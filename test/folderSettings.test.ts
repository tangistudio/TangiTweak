import { describe, it, expect, beforeEach, vi } from "vitest";
import { pathDir, seedBundle } from "./bundleHelper";

// in-memory chrome.storage + directory handle
const store: Record<string, any> = {};
const listeners: ((c: any, area: string) => void)[] = [];
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => {
                Object.assign(store, structuredClone(o));
                cb?.();
                const c = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }]));
                for (const l of listeners) l(c, "local");
            },
        },
        onChanged: { addListener: (l: any) => listeners.push(l) },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};
const files = new Map<string, { text: string; t: number }>();
let clock = 1;
const dir = pathDir(files, { tick: () => clock++, dots: true });
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    files.clear();
    for (const k of Object.keys(store)) delete store[k];
});

const CODE = `import { tweak } from "tangitweak"; tweak.params({ n: { type: "number", default: 1 } });`;
const json = (p: string) => JSON.parse(files.get(p)!.text);

describe("settings.json folder sync", () => {
    it("holds the globals only: exported, applied from disk, never rewritten when stable, and a broken one is left alone", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        await seedBundle("s");
        await ss.saveScript({ id: ss.newId(), name: "s/index", code: CODE });
        await sync.startFromStoredHandle();
        await sleep(600);
        expect(files.get("settings.json")!.text).toBe("{}\n");
        expect(files.has("settings.schema.json")).toBe(false);

        files.set("settings.json", { text: JSON.stringify({ logLevel: "warn" }, null, 2) + "\n", t: clock++ });
        await sleep(1500);
        expect(store.resLogLevel).toBe("warn");
        const stable = files.get("settings.json")!;
        await sleep(1500);
        expect(files.get("settings.json")).toBe(stable);

        files.set("settings.json", { text: "{ broken\n", t: clock++ });
        await sleep(1500);
        expect(store.resLogLevel).toBe("warn");
        expect(files.get("settings.json")!.text).toBe("{ broken\n");
        await sync.stop();
    }, 20000);

    it("a settings.json save in the Editor is written out to the synced folder without echo", async () => {
        const sync = await import("../src/background/folderSync");
        const { applySettingsText } = await import("../src/background/settingsFile");
        await sync.startFromStoredHandle();
        await sleep(600);
        const edited = JSON.stringify({ logLevel: "error" }, null, 2) + "\n";
        expect((await applySettingsText(edited)).error).toBeUndefined();
        await sync.exportSettingsFrom();
        expect(files.get("settings.json")!.text).toBe(edited);
        const stamp = files.get("settings.json")!.t;
        await sleep(1500); // the poll must not bounce it back
        expect(files.get("settings.json")!.t).toBe(stamp);
        expect(store.resLogLevel).toBe("error");
        await sync.stop();
    }, 20000);
});

describe("a tweak's data folder in the synced folder", () => {
    it("mirrors .tweak/settings.json both ways with only the non-default params, and reports an invalid file without applying it", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        await seedBundle("s");
        const id = ss.newId();
        await ss.saveScript({ id, name: "s/index", code: CODE });
        await sync.startFromStoredHandle();
        await sleep(600);
        expect(json("s/.tweak/settings.json")).toEqual({ enabled: true });

        await ss.setParamValue(id, "n", 7);
        await sync.flush();
        expect(json("s/.tweak/settings.json")).toEqual({ enabled: true, params: { n: 7 } });
        await ss.setParamValue(id, "n", 1); // back at its default: gone from the file
        await sync.flush();
        expect(json("s/.tweak/settings.json")).toEqual({ enabled: true });

        files.set("s/.tweak/settings.json", { text: JSON.stringify({ enabled: false, params: { n: 9 } }), t: clock++ });
        await sync.flush();
        expect((await ss.getScript(id))!.enabled).toBe(false);
        expect((await ss.getParamValues(id)).n).toBe(9);

        // invalid: reported, not applied, and not overwritten by later changes
        files.set("s/.tweak/settings.json", { text: JSON.stringify({ enabled: true, params: { n: "x" } }), t: clock++ });
        await sync.flush();
        expect((await ss.getScript(id))!.enabled).toBe(false);
        expect((await ss.getParamValues(id)).n).toBe(9);
        await ss.setParamValue(id, "n", 4);
        await sync.flush();
        expect(json("s/.tweak/settings.json").params.n).toBe("x");

        // fixed on disk: applies again
        files.set("s/.tweak/settings.json", { text: JSON.stringify({ enabled: true }), t: clock++ });
        await sync.flush();
        expect((await ss.getScript(id))!.enabled).toBe(true);
        expect((await ss.getParamValues(id)).n).toBe(1);
        // deleted on disk: back to its defaults, and written again
        await ss.setParamValue(id, "n", 3);
        await sync.flush();
        files.delete("s/.tweak/settings.json");
        await sync.flush();
        expect((await ss.getParamValues(id)).n).toBe(1);
        expect(json("s/.tweak/settings.json")).toEqual({ enabled: true });
        await sync.stop();
    }, 20000);

    it("writes one stores/<id>.json per persisted global store, applies edits on disk, and deletes a store whose file goes", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const { storeOwner } = await import("../src/background/engine/stores");
        await seedBundle("kit");
        const id = ss.newId();
        await ss.saveScript({ id, name: "kit/index", code: "// ok" });
        await ss.saveScript({ id: ss.newId(), name: "kit/helper", code: "// a module" });
        storeOwner.forget(id);
        await sync.startFromStoredHandle({ fresh: true });
        await sleep(300);
        expect([...files.keys()].filter((p) => p.includes("/stores/"))).toEqual([]);

        await storeOwner.replace(id, "flags", { beta: true });
        await storeOwner.replace(id, "cart", { n: 2 });
        await sync.flush();
        expect(json("kit/.tweak/stores/flags.json")).toEqual({ beta: true });
        expect(json("kit/.tweak/stores/cart.json")).toEqual({ n: 2 });

        files.set("kit/.tweak/stores/cart.json", { text: '{"n":9}', t: clock++ });
        files.set("kit/.tweak/stores/extra.json", { text: '{"on":true}', t: clock++ });
        await sync.flush();
        expect(storeOwner.get(id, "cart")?.data).toEqual({ n: 9 });
        expect(storeOwner.get(id, "extra")?.data).toEqual({ on: true });

        files.delete("kit/.tweak/stores/extra.json");
        await sync.flush();
        expect(storeOwner.get(id, "extra")).toBeUndefined();

        // not an object: reported and left alone
        files.set("kit/.tweak/stores/cart.json", { text: "[1]", t: clock++ });
        await sync.flush();
        expect(storeOwner.get(id, "cart")?.data).toEqual({ n: 9 });
        await storeOwner.replace(id, "cart", { n: 10 });
        await sync.flush();
        expect(files.get("kit/.tweak/stores/cart.json")!.text).toBe("[1]");

        // a store deleted in the extension takes its file with it
        await storeOwner.deleteStore(id, "flags");
        await sync.flush();
        expect(files.has("kit/.tweak/stores/flags.json")).toBe(false);
        // the data folder is no script, module or data file
        expect((await ss.listScripts()).map((s) => s.meta.name).sort()).toEqual(["kit/helper", "kit/index"]);
        expect((await ss.listDataFiles()).map((d) => d.path)).toEqual(["kit/package.json"]);
        await sync.stop();
    }, 20000);

    it("changing the Tweak data folder setting moves every tweak's folder; an invalid or taken name is refused", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const { setDataFolder, getDataFolder } = await import("../src/background/tweakDataFiles");
        await seedBundle("a");
        await seedBundle("b");
        const a = ss.newId();
        await ss.saveScript({ id: a, name: "a/index", code: CODE });
        await ss.saveScript({ id: ss.newId(), name: "b/index", code: CODE });
        await ss.setParamValue(a, "n", 5);
        await sync.startFromStoredHandle();
        await sleep(600);
        files.set("a/.tweak/notes.md", { text: "mine", t: clock++ });

        for (const bad of ["", "a/b", "..", ".", "node_modules", "s p", "x\\y"]) expect((await setDataFolder(bad)).error).toBeTruthy();
        await ss.saveDataFile({ path: "b/data/keep.json", text: "{}" });
        expect((await setDataFolder("data")).error).toMatch(/b\/data already exists/);
        expect(await getDataFolder()).toBe(".tweak");

        expect(await setDataFolder(".state")).toEqual({});
        expect(store.resDataFolder).toBe(".state");
        await sync.flush();
        await sleep(100);
        await sync.flush();
        expect([...files.keys()].filter((p) => p.startsWith("a/") || p.startsWith("b/")).sort()).toEqual([
            "a/.state/notes.md",
            "a/.state/settings.json",
            "a/index.ts",
            "a/package.json",
            "b/.state/settings.json",
            "b/data/keep.json",
            "b/index.ts",
            "b/package.json",
        ]);
        expect(json("a/.state/settings.json")).toEqual({ enabled: true, params: { n: 5 } });
        expect((await ss.getParamValues(a)).n).toBe(5);
        await sync.stop();
    }, 20000);
});
