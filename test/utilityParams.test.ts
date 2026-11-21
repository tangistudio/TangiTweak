/**
 * An entry whose handlers are gated by a param: its params are editable
 * (popup / the data folder's settings.json), and changing the param must
 * give it its routes (stored meta, reload) and take them back.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "../src/shared/transpile";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const { saveScript, listScripts, setParamValue, loadAllParamValues, onScriptsChanged } = await import("../src/background/engine/scriptStore");
const { analyzeScripts } = await import("../src/background/compileHost");
const { tweakDataFiles, applyTweakDataFile } = await import("../src/background/tweakDataFiles");
const { seedBundle } = await import("./bundleHelper");

const GATE = `import { tweak } from "tangitweak"; 
const p = tweak.params({ on: { type: "boolean", default: false, description: "intercept" } });
export const helper = () => p.on;
if (p.on) tweak.onRequest({ url: "*://example.com/*", strategy: "helper" }, () => ({ block: true }));
`;

const get = async (id: string) => (await listScripts()).find((s) => s.id === id)!;

describe("tweaks whose params gate their handlers", () => {
    beforeEach(async () => {
        for (const k of Object.keys(store)) delete store[k];
        await seedBundle("gate");
    });

    it("stores a param-gated entry with no routes and its paramDefs", async () => {
        const s = await saveScript({ id: "g", name: "gate/index", code: GATE });
        expect(s.error).toBeNull();
        expect(s.meta.active).toBe(false);
        expect(s.paramDefs?.on).toMatchObject({ type: "boolean" });
    });

    it("changing the param turns it into a script and back (stored meta)", async () => {
        await saveScript({ id: "g", name: "gate/index", code: GATE });
        let notified = 0;
        const off = onScriptsChanged(() => notified++);
        await setParamValue("g", "on", true);
        let s = await get("g");
        expect(s.meta.active).toBe(true);
        expect(s.meta.match).toEqual(["*://example.com/*"]);
        expect(s.meta.name).toBe("gate/index");
        expect(notified).toBeGreaterThan(0);
        // a later save (e.g. setEnabled) compiles with the stored values too
        s = await saveScript({ id: "g", code: GATE });
        expect(s.meta.active).toBe(true);
        await setParamValue("g", "on", false);
        s = await get("g");
        expect(s.meta.active).toBe(false);
        expect(s.paramDefs?.on).toBeTruthy();
        off();
    });

    it("the reload-time analyze uses the param values", async () => {
        await saveScript({ id: "g", name: "gate/index", code: GATE });
        const scripts = [{ id: "g", name: "gate/index", code: GATE, updatedAt: 1 }];
        expect((await analyzeScripts(scripts, {})).get("g")!.meta.active).toBe(false);
        expect((await analyzeScripts(scripts, { g: { on: true } })).get("g")!.meta.active).toBe(true);
    });

    it("its data folder settings.json applies the params that turn it into a script", async () => {
        await saveScript({ id: "g", name: "gate/index", code: GATE });
        expect((await get("g")).meta.active).toBe(false);
        expect((await applyTweakDataFile("gate/.tweak/settings.json", JSON.stringify({ params: { on: true } }))).error).toBeUndefined();
        expect((await loadAllParamValues()).g).toEqual({ on: true });
        expect((await get("g")).meta.active).toBe(true);
        expect(JSON.parse((await tweakDataFiles())[0].text)).toEqual({ enabled: true, params: { on: true } });
    });

    it("a module's params and registrations belong to the entry that imports it", async () => {
        await seedBundle("t");
        const g = await saveScript({ id: "g2", name: "t/gate", code: GATE });
        const m = await saveScript({ id: "m", name: "t/index", code: `import { tweak } from "tangitweak";\nimport { helper } from "./gate";\ntweak.onRequest({ url: "*://a.test/*", strategy: "helper" }, () => { helper(); });` });
        expect(g.meta.active).toBe(false);
        expect(g.paramDefs).toEqual({});
        expect(m.error).toBeNull();
        expect(m.meta.active).toBe(true);
        expect(m.paramDefs?.on).toMatchObject({ type: "boolean" });
        expect(m.meta.match).toEqual(["*://a.test/*"]);
        await setParamValue("m", "on", true);
        const after = await get("m");
        expect(after.error).toBeNull();
        expect(after.meta.match).toEqual(["*://example.com/*", "*://a.test/*"]);
    });
});
