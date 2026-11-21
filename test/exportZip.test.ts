/**
 * Export…/Import… zip: laid out like the synced scripts folder (scripts and
 * data files by path, empty folders as folder entries, settings.json with
 * the globals; each tweak's data folder only when asked for).
 */
import { describe, it, expect } from "vitest";
import { buildExportZip, emptyFolders, filesGoneFrom, packageRoots, readExportZip } from "../src/shared/exportZip";
import { readZipEntries, writeZip } from "../src/shared/zip";

// in-memory chrome.storage — must exist before scriptStore/settingsFile load
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

const buf = (z: Uint8Array): ArrayBuffer => z.slice().buffer;
const PKG = JSON.stringify({ name: "dbg", tangitweak: {} });

describe("export zip layout", () => {
    it("lays files out as the scripts folder: settings.json, folders, scripts (.ts/.tsx) and data files by path", async () => {
        const zip = buildExportZip({
            settings: '{"logLevel":"warn"}\n',
            scripts: [
                { name: "Debug header", code: "a" },
                { name: "ui/Panel.tsx", code: "b" },
                { name: "mock/helpers", code: "c" },
            ],
            dataFiles: [{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }],
            folders: ["mock/empty", "later"],
        });
        const raw = await readZipEntries(buf(zip));
        expect(Object.keys(raw.files)).toEqual(["settings.json", "Debug header.ts", "ui/Panel.tsx", "mock/helpers.ts", "mock/rate-limits.json", "icons/x.svg"]);
        expect(raw.folders).toEqual(["mock/empty", "later"]);
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe('{"logLevel":"warn"}\n');
        expect(z.scripts).toEqual([
            { name: "Debug header", file: "Debug header.ts", code: "a" },
            { name: "ui/Panel.tsx", file: "ui/Panel.tsx", code: "b" },
            { name: "mock/helpers", file: "mock/helpers.ts", code: "c" },
        ]);
        expect(z.dataFiles).toEqual([{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }]);
        expect(z.folders).toEqual(["mock/empty", "later"]);
        expect(z.ignored).toEqual([]);
    });

    it("without settings.json there's no settings entry", async () => {
        const z = await readExportZip(buf(buildExportZip({ scripts: [{ name: "a", code: "" }], dataFiles: [] })));
        expect(z.settings).toBeNull();
        expect(z.tweakData).toEqual([]);
        expect(z.scripts.map((s) => s.name)).toEqual(["a"]);
    });

    it("a tweak's data folder goes in only when given; reading sorts it out by bundle", async () => {
        const base = { scripts: [{ name: "dbg/index", code: "// ok" }], dataFiles: [{ path: "dbg/package.json", text: PKG }] };
        const without = await readZipEntries(buf(buildExportZip(base)));
        expect(Object.keys(without.files)).toEqual(["dbg/index.ts", "dbg/package.json"]);
        const zip = buildExportZip({
            ...base,
            tweakData: [
                { path: "dbg/.tweak/settings.json", text: '{"enabled":false}' },
                { path: "dbg/.tweak/stores/cart.json", text: '{"n":1}' },
                { path: "dbg/.tweak/notes.md", text: "?" },
            ],
        });
        const z = await readExportZip(buf(zip));
        expect(z.tweakData).toEqual([
            { root: "dbg/", file: "settings.json", text: '{"enabled":false}' },
            { root: "dbg/", file: "stores/cart.json", text: '{"n":1}' },
        ]);
        expect(z.ignored).toEqual(["dbg/.tweak/notes.md"]);
        expect(z.dataFiles.map((d) => d.path)).toEqual(["dbg/package.json"]); // never data files
        expect(z.scripts.map((s) => s.name)).toEqual(["dbg/index"]);
    });

    it("the data folder is the one the zip's settings.json names, else the importer's", async () => {
        const files = { "dbg/index.ts": "", "dbg/package.json": PKG, "dbg/.data/settings.json": "{}", "dbg/.tweak/settings.json": "{}" };
        expect((await readExportZip(buf(writeZip(files)))).tweakData.map((d) => d.file)).toEqual(["settings.json"]);
        expect((await readExportZip(buf(writeZip(files)), ".data")).tweakData).toHaveLength(1);
        const named = await readExportZip(buf(writeZip({ ...files, "settings.json": '{"dataFolder":".data"}' })));
        expect(named.tweakData).toEqual([{ root: "dbg/", file: "settings.json", text: "{}" }]);
        // outside a tweak a dot folder is skipped
        expect((await readExportZip(buf(writeZip({ "a.ts": "", ".tweak/settings.json": "{}" })))).tweakData).toEqual([]);
    });

    it("takes a zipped scripts folder: unwraps its top folder, skips the support files, dot entries and node_modules", async () => {
        const zip = writeZip({
            "Scripts/": "",
            "Scripts/settings.json": "{}\n",
            "Scripts/tt-api.d.ts": "declare const tt: any;",
            "Scripts/tsconfig.json": "{}",
            "Scripts/settings.schema.json": "{}",
            "Scripts/.vscode/settings.json": "{}",
            "Scripts/node_modules/x/index.json": "{}",
            "__MACOSX/Scripts/._a.ts": "",
            "Scripts/a.ts": "A",
            "Scripts/types.d.ts": "declare const x: 1;",
            "Scripts/README.md": "# hi",
            "Scripts/notes.txt": "skip",
            "Scripts/d/data.json": "[]",
            "Scripts/e/": "",
        });
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe("{}\n");
        expect(z.scripts).toEqual([{ name: "a", file: "a.ts", code: "A" }]);
        expect(z.dataFiles).toEqual([
            { path: "README.md", text: "# hi" },
            { path: "d/data.json", text: "[]" },
        ]);
        expect(z.folders).toEqual(["e"]);
        expect(z.ignored.sort()).toEqual(["notes.txt", "types.d.ts"]);
    });

    it("keeps a single top folder that is just a folder of scripts", async () => {
        const z = await readExportZip(buf(writeZip({ "mock/a.ts": "A", "mock/b.json": "{}" })));
        expect(z.scripts.map((s) => s.name)).toEqual(["mock/a"]);
        expect(z.dataFiles.map((d) => d.path)).toEqual(["mock/b.json"]);
    });

    it("isn't fooled by a non-zip", async () => {
        await expect(readExportZip(new TextEncoder().encode("name: x\ncode: y\n").buffer as ArrayBuffer)).rejects.toThrow("not a zip file");
    });

    it("emptyFolders: only folders with nothing (no file, no folder) inside, once", () => {
        expect(emptyFolders(["a", "a/b", "c", "C", "d", "e"], ["a/b/x.ts", "d/y.json"])).toEqual(["c", "e"]);
        expect(emptyFolders(["a", "a/b"], [])).toEqual(["a/b"]);
    });
});

describe("Import… of a tweak's saved data", () => {
    it("lands through the real apply path, keyed by the tweak, without touching others", async () => {
        const ss = await import("../src/background/engine/scriptStore");
        const { applyTweakDataFile } = await import("../src/background/tweakDataFiles");
        const code = `import { tweak } from "tangitweak"; tweak.params({ level: { type: "string", default: "warn" } });\ntweak.onRequest({ url: "*", strategy: "extension" }, () => {});\n`;
        const { seedBundle } = await import("./bundleHelper");
        await seedBundle("untouched");
        await seedBundle("dbg");
        const untouchedId = ss.newId();
        await ss.saveScript({ id: untouchedId, name: "untouched/index", code });
        await ss.setEnabled(untouchedId, false);

        const zip = buildExportZip({
            settings: '{"logLevel":"warn"}\n',
            scripts: [{ name: "dbg/index", code }],
            dataFiles: [{ path: "dbg/package.json", text: PKG }],
            tweakData: [{ path: "dbg/.tweak/settings.json", text: JSON.stringify({ enabled: false, params: { level: "debug" } }) }],
        });
        const z = await readExportZip(buf(zip));
        const id = ss.newId();
        await ss.saveScript({ id, name: "dbg/index", code: z.scripts[0].code });
        expect((await ss.getScript(id))!.enabled).toBe(true);
        expect(z.tweakData).toHaveLength(1);
        for (const d of z.tweakData) expect(await applyTweakDataFile(`${d.root}.tweak/${d.file}`, d.text)).toEqual({});
        expect((await ss.getScript(id))!.enabled).toBe(false);
        expect((await ss.getParamValues(id)).level).toBe("debug");
        expect((await ss.getScript(untouchedId))!.enabled).toBe(false);
        expect((await ss.getParamValues(untouchedId)).level).toBeUndefined();
        // an invalid file applies nothing
        expect((await applyTweakDataFile("dbg/.tweak/settings.json", JSON.stringify({ enabled: true, params: { nope: 1 } }))).error).toMatch(/nope/);
        expect((await ss.getScript(id))!.enabled).toBe(false);
    });
});

describe("Import… of a package's new version", () => {
    const zip = (paths: string[], settings: string | null = null) => ({
        settings,
        scripts: paths.filter((p) => /\.tsx?$/.test(p)).map((p) => ({ name: p.replace(/\.ts$/, ""), file: p, code: "" })),
        dataFiles: paths.filter((p) => !/\.tsx?$/.test(p) && !p.endsWith("/")).map((p) => ({ path: p, text: "" })),
        folders: paths.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)),
    });

    it("its packages: the one folder everything is in (Export Package…), and folders with a package.json", () => {
        expect(packageRoots(zip(["kit/a.ts", "kit/lib/b.ts"]))).toEqual(["kit"]);
        expect(packageRoots(zip(["kit/a.ts", "x.ts"]))).toEqual([]);
        expect(packageRoots(zip(["kit/a.ts"], "globals: {}"))).toEqual([]);
        expect(packageRoots(zip(["a/package.json", "a/x.ts", "b/y.ts", "package.json"]))).toEqual(["a"]);
        // one inside another counts as the outer one
        expect(packageRoots(zip(["kit/package.json", "kit/sub/package.json", "kit/sub/x.ts"]))).toEqual(["kit"]);
    });

    it("existing files in those packages that the zip doesn't have (any case), and nothing outside them", () => {
        const existing = ["kit/a.ts", "kit/old.ts", "kit/lib/data.json", "Kit/Lib/B.ts", "other/c.ts", "kitten/d.ts", "e.ts"];
        expect(filesGoneFrom(zip(["kit/a.ts", "kit/lib/b.ts"]), existing)).toEqual(["kit/old.ts", "kit/lib/data.json"]);
        expect(filesGoneFrom(zip(["kit/a.ts", "x.ts"]), existing)).toEqual([]);
    });
});
