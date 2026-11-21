import { describe, it, expect, beforeEach, vi } from "vitest";
import { bundlePkg, pathDir } from "./bundleHelper";

// A change received from the folder must not be echoed back to it (and the
// Editor's sync button must not show "sending" for it) — only real local
// changes write to the folder.

const store: Record<string, any> = {};
const storageListeners: ((c: Record<string, any>) => void)[] = [];
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => {
                const changes: Record<string, any> = {};
                for (const [k, v] of Object.entries(o)) changes[k] = { oldValue: store[k], newValue: v };
                Object.assign(store, structuredClone(o));
                cb?.();
                for (const l of storageListeners) l(changes);
            },
            remove: (k: any, cb?: any) => ((Array.isArray(k) ? k : [k]).forEach((x: string) => delete store[x]), cb?.()),
        },
        onChanged: { addListener: (fn: any) => storageListeners.push(fn) },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

type F = Map<string, { text: string; t: number }>;
const files: F = new Map();
/** every write/delete the extension makes in the folder */
const ops: string[] = [];
let clock = 1;
const dir = pathDir(files, { tick: () => clock++, ops, dots: true, special: (p) => (p === ".tangitweak-backup" ? pathDir(new Map(), { tick: () => clock++, ops }, p + "/", p) : undefined) });
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

/** the activities the Editor's sync button showed */
const shown: string[] = [];
vi.mock("../src/background/engine/logs", async (orig) => ({
    ...(await orig<any>()),
    broadcastToUi: (msg: any) => {
        if (msg?.type === "sync" && msg.status.activity !== "idle" && shown[shown.length - 1] !== msg.status.activity) shown.push(msg.status.activity);
    },
}));

const put = (name: string, text: string) => files.set(name, { text, t: clock++ });
const ss = () => import("../src/background/engine/scriptStore");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PARAMS = `import { tweak } from "tangitweak"; tweak.params({ n: { type: "number", default: 1 } });`;

async function settled(sync: typeof import("../src/background/folderSync")) {
    // let debounced storage → disk work fire on its own, as in the browser
    for (let i = 0; i < 3; i++) {
        await sleep(350);
        await sync.flush();
    }
}

/** a synced folder with two tweaks (one declaring a param), fully settled */
async function setup() {
    put("p/package.json", bundlePkg("p"));
    put("p/index.ts", "// plain");
    put("w/package.json", bundlePkg("w"));
    put("w/index.ts", PARAMS);
    await import("../src/shared/transpile");
    const sync = await import("../src/background/folderSync");
    await sync.startFromStoredHandle({ fresh: true });
    await settled(sync);
    ops.length = 0;
    shown.length = 0;
    return sync;
}

beforeEach(async () => {
    const sync = await import("../src/background/folderSync");
    await sync.stop();
    vi.resetModules();
    files.clear();
    ops.length = 0;
    shown.length = 0;
    storageListeners.length = 0;
    for (const k of Object.keys(store)) delete store[k];
});

const names = async () => (await (await ss()).listScripts()).map((s) => s.meta.name).sort();
const scriptOps = () => ops.filter((o) => o.endsWith(".ts"));

describe("folder sync: received changes are not echoed back", () => {
    it("an external delete is only received", async () => {
        const sync = await setup();
        files.delete("p/index.ts");
        await settled(sync);
        expect(await names()).toEqual(["w/index"]);
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("an external delete of a script with params is only received", async () => {
        const sync = await setup();
        files.delete("w/index.ts");
        await settled(sync);
        expect(await names()).toEqual(["p/index"]);
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]); // its data folder stays, forgotten
        expect(files.has("w/.tweak/settings.json")).toBe(true);
        await sync.stop();
    });

    it("an external edit is only received", async () => {
        const sync = await setup();
        put("p/index.ts", "// plain edited");
        put("w/index.ts", PARAMS + "\n// edited");
        await settled(sync);
        const by = Object.fromEntries((await (await ss()).listScripts()).map((s) => [s.meta.name, s.code]));
        expect(by).toEqual({ "p/index": "// plain edited", "w/index": PARAMS + "\n// edited" });
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("an external edit declaring a param is only received", async () => {
        const sync = await setup();
        put("p/index.ts", `import { tweak } from "tangitweak"; tweak.params({ m: { type: "number", default: 2 } });`);
        await settled(sync);
        expect(JSON.parse(files.get("p/.tweak/settings.json")!.text)).toEqual({ enabled: true }); // defaults aren't written
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("an external add is only received", async () => {
        const sync = await setup();
        put("added.ts", "// added");
        put("Added Params.ts", `import { tweak } from "tangitweak"; tweak.params({ k: { type: "boolean", default: true } });`);
        await settled(sync);
        expect(await names()).toEqual(["Added Params", "added", "p/index", "w/index"].sort());
        expect(shown).toEqual(["receiving"]);
        expect(scriptOps()).toEqual([]);
        await sync.stop();
    });

    it("an external edit of a tweak's .tweak/settings.json is only received", async () => {
        const sync = await setup();
        put("w/.tweak/settings.json", JSON.stringify({ enabled: true, params: { n: 7 } }, null, 2) + "\n");
        await settled(sync);
        const { listScripts, getParamValues } = await ss();
        expect(await getParamValues((await listScripts()).find((s) => s.meta.name === "w/index")!.id)).toMatchObject({ n: 7 });
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("a local edit is only sent", async () => {
        const sync = await setup();
        const { saveScript, listScripts } = await ss();
        const s = (await listScripts()).find((x) => x.meta.name === "p/index")!;
        await saveScript({ id: s.id, code: "// local edit", name: "p/index" });
        await settled(sync);
        expect(files.get("p/index.ts")?.text).toBe("// local edit");
        expect(shown).toEqual(["sending"]);
        expect(ops).toEqual(["write p/index.ts"]);
        await sync.stop();
    });

    it("a local delete is only sent", async () => {
        const sync = await setup();
        const { deleteScript, listScripts } = await ss();
        await deleteScript((await listScripts()).find((x) => x.meta.name === "w/index")!.id);
        await settled(sync);
        expect(await names()).toEqual(["p/index"]);
        expect(shown).toEqual(["sending"]);
        expect(ops).toEqual(["delete w/.tweak/settings.json", "delete w/.tweak", "delete w/index.ts"]);
        await sync.stop();
    });
});
