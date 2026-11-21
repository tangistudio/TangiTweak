/**
 * Tweak bundles: a folder whose package.json has a "tangitweak" block. Its
 * entry (`main`, else index.ts, else index.tsx) is the tweak; the other
 * files are its modules; anything outside a bundle needs a rewrite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "../src/shared/transpile";
import { bareImport, bundleOf, bundleRole, dataReader, dependenciesOf, entryName, gateCompiled, NEEDS_REWRITE, versionProblem } from "../src/shared/tweakBundle";
import { bundlePkg } from "./bundleHelper";

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
    runtime: { lastError: undefined, sendMessage: () => {}, getManifest: () => ({ version: "0.40.0", version_name: "0.40.0-alpha" }) },
};

const { saveScript, saveDataFile, listScripts } = await import("../src/background/engine/scriptStore");

const read = (files: Record<string, string>) => dataReader(Object.entries(files).map(([path, text]) => [{ path, text }][0]));

describe("bundles", () => {
    it("finds a file's bundle: the nearest folder whose package.json has a tangitweak block", () => {
        const r = read({ "kit/package.json": bundlePkg("kit"), "kit/vendor/package.json": JSON.stringify({ name: "v" }), "solo/package.json": JSON.stringify({ name: "s" }) });
        expect(bundleOf("kit/index", r)?.root).toBe("kit/");
        expect(bundleOf("kit/vendor/x", r)?.pkgPath).toBe("kit/package.json");
        expect(bundleOf("solo/index", r)).toBeUndefined();
        expect(bundleOf("top", r)).toBeUndefined();
    });

    it("the entry is `main`, else index.ts, else index.tsx", () => {
        const b = (extra = {}) => bundleOf("t/x", read({ "t/package.json": bundlePkg("t", extra) }))!;
        const has = (...names: string[]) => (n: string) => names.includes(n);
        expect(entryName(b(), has("t/index", "t/index.tsx"))).toBe("t/index");
        expect(entryName(b(), has("t/index.tsx"))).toBe("t/index.tsx");
        expect(entryName(b(), has())).toBe("t/index");
        expect(entryName(b({ main: "./src/main.ts" }), has("t/index"))).toBe("t/src/main");
        expect(entryName(b({ main: "app.tsx" }), has("t/index"))).toBe("t/app.tsx");
    });

    it("roles: the entry, its modules, and files that need a rewrite (single files, metadata.json bundles)", () => {
        const r = read({ "t/package.json": bundlePkg("t"), "old/metadata.json": JSON.stringify({ scripts: ["a.ts"] }) });
        const names = ["t/index", "t/lib/util", "solo", "old/a"];
        expect(bundleRole("t/index", names, r)).toMatchObject({ role: "entry", entry: "t/index" });
        expect(bundleRole("t/lib/util", names, r)).toMatchObject({ role: "module", entry: "t/index" });
        const solo = bundleRole("solo", names, r);
        expect(solo.role === "rewrite" && solo.reason).toMatch(/^Needs a rewrite: single-file scripts no longer load/);
        const old = bundleRole("old/a", names, r);
        expect(old.role === "rewrite" && old.reason).toMatch(/^Needs a rewrite: old\/metadata\.json bundles no longer load/);
    });

    it("checks the extension's version against dependencies.tangitweak (minimum only; a missing one is fine)", () => {
        expect(versionProblem({ dependencies: { tangitweak: "^0.40.0-alpha" } }, "0.40.0-alpha")).toBeNull();
        expect(versionProblem({ dependencies: { tangitweak: "^0.39.0" } }, "0.40.0-alpha")).toBeNull();
        expect(versionProblem({ dependencies: {} }, "0.1.0")).toBeNull();
        expect(versionProblem({ dependencies: { tangitweak: "^0.41.0" } }, "0.40.0-alpha")).toMatch(/^Requires TangiTweak 0\.41\.0 or newer \(you have 0\.40\.0-alpha\) — update TangiTweak/);
    });

    it("gates compile results: modules and rewrites are inert; an entry needing a newer TangiTweak doesn't load", () => {
        const c = { meta: { name: "x", active: true, routes: [{ kind: "onRequest" }] } as any, paramDefs: { on: { type: "boolean" } }, error: null };
        const r = read({ "t/package.json": bundlePkg("t", { dependencies: { tangitweak: "^9.0.0" } }), "u/package.json": bundlePkg("u") });
        const names = ["t/index", "u/index", "u/m"];
        expect(gateCompiled("u/index", c, names, r, "0.40.0")).toBe(c);
        const mod = gateCompiled("u/m", c, names, r, "0.40.0");
        expect([mod.meta.active, mod.paramDefs, mod.error]).toEqual([false, {}, null]);
        expect(gateCompiled("solo", c, names, r, "0.40.0").error).toMatch(new RegExp(`^${NEEDS_REWRITE}`));
        const v = gateCompiled("t/index", c, names, r, "0.40.0");
        expect([v.meta.active, v.error]).toEqual([false, expect.stringMatching(/Requires TangiTweak 9\.0\.0/)]);
    });

    it("bare imports resolve through the bundle's dependencies, npm: aliases included", () => {
        const r = read({ "t/package.json": bundlePkg("t", { dependencies: { tangitweak: "^0.40.0", dayjs: "^1.11.0", events: "npm:events@^3", local: "file:../x" } }) });
        expect(bareImport("t/index", "dayjs/plugin/utc", r)).toEqual({ url: "https://unpkg.com/dayjs@%5E1.11.0/plugin/utc", pkgPath: "t/package.json" });
        expect(bareImport("t/index", "events", r)).toEqual({ url: "https://unpkg.com/events@%5E3", pkgPath: "t/package.json" });
        expect(bareImport("t/index", "local", r)).toMatchObject({ error: expect.stringMatching(/only npm registry ranges/) });
        expect(bareImport("t/index", "nope", r)).toBeUndefined();
        expect(bareImport("t/index", "tangitweak", r)).toBeUndefined();
        expect(bareImport("t/index", "./x", r)).toBeUndefined();
        expect(dependenciesOf("t/lib/a", r)).toMatchObject({ events: "npm:events@^3" });
        expect(dependenciesOf("solo", r)).toEqual({});
    });
});

describe("stored scripts by bundle role", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
    });

    const CODE = `import { tweak } from "tangitweak";\ntweak.onRequest({ url: "*://a.test/*", strategy: "helper" }, () => {});`;

    it("a single file doesn't load: its error asks for a rewrite, its code is kept", async () => {
        const s = await saveScript({ id: "s", name: "solo", code: CODE });
        expect(s.error).toMatch(/^Needs a rewrite: single-file scripts no longer load/);
        expect(s.meta.active).toBe(false);
        expect((await listScripts())[0].code).toBe(CODE);
    });

    it("a metadata.json bundle's files don't load either", async () => {
        await saveDataFile({ path: "kit/metadata.json", text: JSON.stringify({ name: "Kit", scripts: ["a.ts"] }) });
        const s = await saveScript({ id: "a", name: "kit/a", code: CODE });
        expect(s.error).toMatch(/^Needs a rewrite: kit\/metadata\.json bundles no longer load/);
    });

    it("adding the package.json makes the folder a tweak: its index loads", async () => {
        await saveScript({ id: "s", name: "t/index", code: CODE });
        await saveDataFile({ path: "t/package.json", text: bundlePkg("t") });
        const s = (await listScripts()).find((x) => x.id === "s")!;
        expect(s.error).toBeNull();
        expect(s.meta.active).toBe(true);
    });

    it("an entry whose package.json needs a newer TangiTweak shows why and doesn't run", async () => {
        const { id } = await saveDataFile({ path: "t/package.json", text: bundlePkg("t", { dependencies: { tangitweak: "^0.41.0" } }) });
        const s = await saveScript({ id: "s", name: "t/index", code: CODE });
        expect(s.error).toMatch(/Requires TangiTweak 0\.41\.0 or newer \(you have 0\.40\.0-alpha\)/);
        expect(s.meta.active).toBe(false);
        await saveDataFile({ id, text: bundlePkg("t", { dependencies: { tangitweak: "^0.40.0-alpha" } }) });
        expect((await listScripts()).find((x) => x.id === "s")!.meta.active).toBe(true);
    });
});

describe("New Tweak…", () => {
    it("scaffolds package.json (tangitweak block, dependencies.tangitweak), tsconfig.json, .gitignore and an index.ts that loads as the tweak", async () => {
        const { newTweakFiles } = await import("../src/shared/newTweak");
        const { minTangiTweakOf, parseManifest } = await import("../src/shared/packageMetadata");
        const { data, entry } = newTweakFiles("tools/My Tweak");
        const files = Object.fromEntries(data.map((d) => [d.path, d.text]));
        expect(Object.keys(files)).toEqual(["tools/My Tweak/package.json", "tools/My Tweak/tsconfig.json", "tools/My Tweak/.gitignore"]);
        const pkg = JSON.parse(files["tools/My Tweak/package.json"]);
        expect(pkg).toMatchObject({ name: "my-tweak", version: "1.0.0", tangitweak: { displayName: "My Tweak" }, dependencies: { tangitweak: "^0.40.0-alpha" } }); // the running version_name
        expect(minTangiTweakOf(pkg)).toBe("0.40.0-alpha");
        expect(parseManifest(files["tools/My Tweak/package.json"])).toMatchObject({ name: "My Tweak", packageName: "my-tweak", scripts: ["index.ts"] });
        expect(JSON.parse(files["tools/My Tweak/tsconfig.json"])).toEqual({ extends: "tangitweak/tsconfig.json" });
        expect(files["tools/My Tweak/.gitignore"].split("\n")).toEqual(["node_modules/", ".tweak/", ""]);
        expect(entry.name).toBe("tools/My Tweak/index");

        for (const d of data) await saveDataFile(d);
        await saveScript({ id: "new_tweak", ...entry });
        const s = (await listScripts()).find((x) => x.id === "new_tweak")!;
        expect(s.error).toBeNull();
        expect(s.meta.active).toBe(true);
        expect(Object.keys(s.paramDefs ?? {})).toEqual(["color"]);
    });
});
