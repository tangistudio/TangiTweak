import { describe, it, expect, beforeEach } from "vitest";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k);
                const out = Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])]));
                return cb ? cb(out) : Promise.resolve(out);
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb ? cb() : Promise.resolve()),
            remove: (k: any, cb?: any) => {
                for (const x of Array.isArray(k) ? k : [k]) delete store[x];
                return cb ? cb() : Promise.resolve();
            },
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

await import("../src/shared/transpile");
const ss = await import("../src/background/engine/scriptStore");
const pk = await import("../src/background/engine/packages");
const { filesHash } = await import("../src/shared/packageSource");
const { entryIds } = await import("../src/shared/packageModel");

const SRC = "https://example.com/dark/package.json";
const entry = (url: string, extra = "") => `import { tweak } from "tangitweak"; import { tint } from "./lib";\nimport cfg from "./cfg.json";\n${extra}tweak.onRequest({ url: "${url}", strategy: "page" }, async (req) => { tint(cfg.n); return req; });\n`;
const LIB = "export const tint = (n: number) => n;\n";
const manifest = ({ updateURL, ...m }: Record<string, any> = {}) => JSON.stringify({ name: "dark", version: "1.0.0", ...m, tangitweak: updateURL ? { updateURL } : {} });
const files = (e: string, lib = LIB, m: Record<string, any> = {}) => ({ "package.json": manifest(m), "index.ts": e, "lib.ts": lib, "cfg.json": '{"n": 1}' });
const fetched = async (f: Record<string, string>, source = SRC) => ({ source, entries: ["index.ts"], files: f, revision: await filesHash(f) });

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

describe("installed packages", () => {
    it("installs a package into its folder, then applies a same-powers update by itself", async () => {
        const v1 = await fetched(files(entry("*://a.com/*")));
        const a = await pk.analyzePackage(v1);
        expect(a.error).toBeNull();
        expect(a.folder).toBe("dark");
        expect(a.caps.urls).toEqual(["*://a.com/*"]);

        const pkg = await pk.installPackage(v1, { enabled: true, autoUpdate: true });
        const scripts = await ss.listScripts();
        expect(scripts.map((s) => s.meta.name).sort()).toEqual(["dark/index", "dark/lib"]);
        expect((await ss.listDataFiles()).map((d) => d.path).sort()).toEqual(["dark/cfg.json", "dark/package.json"]);

        const v2 = await fetched(files(entry("*://a.com/*"), "export const tint = (n: number) => n * 2;\n", { version: "1.1.0" }));
        const after = await pk.offerPackage(pkg.id, v2, false);
        expect(after!.pending).toBeUndefined();
        expect(after!.metadata.version).toBe("1.1.0");
        expect(after!.previous?.metadata.version).toBe("1.0.0");
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).toContain("n * 2");
        // same ids: the entry kept its store id
        expect(entryIds(after!)).toEqual(entryIds(pkg));

        const back = await pk.rollbackPackage(pkg.id);
        expect(back.metadata.version).toBe("1.0.0");
        expect(back.autoUpdate).toBe(false);
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).not.toContain("n * 2");
    });

    it("holds an update that can do more, and one over local edits", async () => {
        const pkg = await pk.installPackage(await fetched(files(entry("*://a.com/*"))), { enabled: true, autoUpdate: true });
        const wider = await fetched(files(entry("<all_urls>")));
        const held = await pk.offerPackage(pkg.id, wider, false);
        expect(held!.pending?.added).toEqual(["runs on <all_urls>"]);
        expect(held!.revision).toBe(pkg.revision);

        // skipping it: the next automatic check doesn't offer it again
        await pk.dismissPending(pkg.id);
        const again = await pk.offerPackage(pkg.id, wider, false);
        expect(again!.pending).toBeUndefined();
        expect(again!.skipped).toBe(wider.revision);
        // asking for it does
        const asked = await pk.offerPackage(pkg.id, wider, true);
        expect(asked!.pending?.revision).toBe(wider.revision);
        const applied = await pk.applyPending(pkg.id);
        expect(applied.caps.urls).toEqual(["<all_urls>"]);

        // an edit here holds the next update
        const lib = (await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!;
        await ss.saveScript({ id: lib.id, code: lib.code + "// mine\n" });
        const v3 = await fetched(files(entry("<all_urls>"), "export const tint = (n: number) => n + 1;\n"));
        const held2 = await pk.offerPackage(pkg.id, v3, false);
        expect(held2!.pending?.reasons.join()).toContain("changed here since installed: lib.ts");
    });

    it("refuses an update that doesn't compile; a second install of the same name takes another folder", async () => {
        const f = await fetched(files(entry("*://a.com/*")));
        const pkg = await pk.installPackage(f, { enabled: false, autoUpdate: true });
        expect(pkg.folder).toBe("dark");
        const s = (await ss.listScripts()).find((x) => x.id === entryIds(pkg)[0])!;
        expect(s.meta.name).toBe("dark/index");
        expect(s.enabled).toBe(false);
        const pkg2 = await pk.installPackage(f, { enabled: true, autoUpdate: true });
        expect((await ss.listScripts()).find((x) => x.id === entryIds(pkg2)[0])!.meta.name).toBe("dark (2)/index");

        const broken = files("import { tweak } from 'tangitweak'; tweak.onRequest({ url: \"*://a.com/*\", strategy: \"page\" }, async (r) => r;\n");
        const out = await pk.offerPackage(pkg.id, { ...f, files: broken, revision: await filesHash(broken) }, false);
        expect(out!.lastError).toMatch(/doesn't compile/);
        expect(out!.revision).toBe(pkg.revision);
    });

    it("installs a bundle from its package.json: its files together, one tweak (the entry), metadata and iconUrl", async () => {
        const run = (u: string, extra = "") => `import { tweak } from "tangitweak"; import { k } from "./shared";${extra}\ntweak.onRequest({ url: "${u}", strategy: "page" }, async (r) => (k, r));\n`;
        const b = {
            "package.json": JSON.stringify({ name: "kit", version: "2.0.0", tangitweak: { displayName: "Kit", icon: "./logo.svg", connect: ["api.x.com"] } }),
            "logo.svg": '<svg viewBox="0 0 8 8"><circle r="4"/></svg>',
            "index.ts": run("*://a.com/*", ` import { b } from "./tools/b"; void b;`),
            "tools/b.ts": run("*://b.com/*").replace("./shared", "../shared") + "export const b = 1;\n",
            "shared.ts": "export const k = 1;\n",
        };
        const f = { source: "https://example.com/kit/package.json", entries: ["index.ts"], files: b, revision: await filesHash(b) };
        const a = await pk.analyzePackage(f);
        expect(a.error).toBeNull();
        expect(a.bundle).toBe(true);
        expect(a.name).toBe("Kit");
        expect(a.folder).toBe("kit");
        expect(a.iconUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        expect(a.caps.urls).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(a.caps.connect).toEqual(["api.x.com"]);
        const pkg = await pk.installPackage(f, { enabled: true, autoUpdate: true });
        expect(pkg.metadata.version).toBe("2.0.0");
        expect(entryIds(pkg)).toHaveLength(1);
        const names = (await ss.listScripts()).map((s) => s.meta.name).sort();
        expect(names).toEqual(["kit/index", "kit/shared", "kit/tools/b"]);
        expect((await ss.listScripts()).filter((s) => s.meta.active).map((s) => s.meta.name)).toEqual(["kit/index"]);
        expect((await ss.listDataFiles()).map((d) => d.path).sort()).toEqual(["kit/logo.svg", "kit/package.json"]);
    });

    it("updates from package.json's tangitweak.updateURL, even installed from local files", async () => {
        const U = "https://example.com/u/package.json";
        const withUrl = (url: string, ver = "1.0.0", lib = LIB) => files(entry("*://a.com/*"), lib, { version: ver, updateURL: url });
        let remote: Record<string, string> = {};
        const serve = (f: Record<string, string>) => (remote = Object.fromEntries(Object.entries(f).map(([k, v]) => [`https://example.com/u/${k}`, v])));
        (globalThis as any).fetch = async (url: string) => (url in remote ? { ok: true, status: 200, text: async () => remote[url] } : { ok: false, status: 404 });

        const v1 = withUrl(U);
        const pkg = await pk.installPackage(await fetched(v1, ""), { enabled: true, autoUpdate: true });
        expect(pkg).toMatchObject({ source: "", autoUpdate: true, metadata: { updateURL: U } });

        // the same files: only the revision moves
        serve(v1);
        const same = (await pk.checkPackages())[pkg.id];
        expect(same.pending).toBeUndefined();
        expect(same.lastError).toBeUndefined();
        expect(same.updatedAt).toBe(pkg.updatedAt);

        serve(withUrl(U, "1.1.0", "export const tint = (n: number) => n * 3;\n"));
        const after = (await pk.checkPackages())[pkg.id];
        expect(after).toMatchObject({ source: "", metadata: { version: "1.1.0" } });
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).toContain("n * 3");

        // moving the updates elsewhere waits for review
        serve(withUrl("https://github.com/me/s/tree/main/dark", "1.2.0"));
        const moved = (await pk.checkPackages())[pkg.id];
        expect(moved.pending?.reasons).toEqual(["it updates from somewhere else: https://github.com/me/s/tree/main/dark"]);
        expect(moved.metadata.version).toBe("1.1.0");
    });

    it("forgets a package whose entry is deleted", async () => {
        const pkg = await pk.installPackage(await fetched(files(entry("*://a.com/*"))), { enabled: true, autoUpdate: true });
        await pk.forgetPackage(pkg.id);
        expect(await pk.listPackages()).toEqual({});
        expect((await ss.listScripts()).length).toBe(2);
    });

    it("detects an already-existing package by name (even from local files or another URL) and upgrades in place", async () => {
        const v1 = await fetched(files(entry("*://a.com/*")), "https://github.com/me/dark");
        const pkg1 = await pk.installPackage(v1, { enabled: true, autoUpdate: true });
        const origIds = entryIds(pkg1);

        // Incoming v1.2.0 from local files (source = "") with same package name "dark"
        const v2Files = {
            ...files(entry("*://a.com/*"), "export const tint = (n: number) => n * 10;\n", { version: "1.2.0" }),
            "extra.json": '{"added": true}',
        };
        const v2 = await fetched(v2Files, "");
        const a = await pk.analyzePackage(v2);
        expect(a.folder).toBe("dark");
        expect(a.existing).toMatchObject({
            packageId: pkg1.id,
            name: "dark",
            version: "1.0.0",
            copyName: "dark (2)",
        });
        expect(a.existing?.before["lib.ts"]).toContain("(n: number) => n");

        const upgraded = await pk.upgradePackage(v2, { packageId: a.existing?.packageId, autoUpdate: true });
        expect(upgraded.id).toBe(pkg1.id);
        expect(upgraded.metadata.version).toBe("1.2.0");
        expect(upgraded.source).toBe("https://github.com/me/dark"); // keeps remote source when upgraded from local files
        expect(entryIds(upgraded)).toEqual(origIds);
        expect(upgraded.previous?.metadata.version).toBe("1.0.0");
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).toContain("n * 10");
        expect((await ss.listDataFiles()).map((d) => d.path).sort()).toEqual(["dark/cfg.json", "dark/extra.json", "dark/package.json"]);
    });

    it("detects an unmanaged Explorer folder or root script with the same name, diffs only crawled package files, and preserves unimported companion files", async () => {
        // Unmanaged bundle folder already in Explorer (e.g. from folder sync with a git checkout)
        await ss.saveDataFile({ path: "bonsai/package.json", text: JSON.stringify({ name: "bonsai", version: "0.0.1-alpha", tangitweak: {} }) });
        const existingEntry = await ss.saveScript({ id: ss.newId(), name: "bonsai/index.tsx", code: 'import { tweak } from "tangitweak"; import "./old.json";\ntweak.onPage("*://a.com/*", () => {});\n', enabled: false });
        await ss.saveDataFile({ path: "bonsai/old.json", text: "{}" });
        // Unimported companion files in the synced repo folder (must NOT be reported removed or deleted)
        const readme = await ss.saveDataFile({ path: "bonsai/README.md", text: "# Bonsai\n" });
        const unusedUtil = await ss.saveScript({ id: ss.newId(), name: "bonsai/shared/util/text", code: "export const trim = (s: string) => s.trim();\n" });

        const incomingFiles = {
            "package.json": JSON.stringify({ name: "bonsai", version: "0.0.2-alpha", tangitweak: {} }),
            "index.tsx": 'import { tweak } from "tangitweak"; tweak.onPage("*://a.com/*", () => { console.log("v2"); });\n',
        };
        const incoming = { source: "https://github.com/me/bonsai", entries: ["index.tsx"], files: incomingFiles, revision: "abc12345" };
        const a = await pk.analyzePackage(incoming);
        expect(a.folder).toBe("bonsai");
        expect(a.existing).toMatchObject({
            name: "bonsai",
            version: "0.0.1-alpha",
            copyName: "bonsai (2)",
        });
        expect(a.existing?.packageId).toBeUndefined();
        expect(Object.keys(a.existing!.before).sort()).toEqual(["index.tsx", "old.json", "package.json"]);

        // Upgrading in place preserves the existing script id & disabled state, removes old.json, keeps companion files, and enables Roll Back
        const upgraded = await pk.upgradePackage(incoming, { autoUpdate: true });
        expect(upgraded.folder).toBe("bonsai");
        expect(upgraded.metadata.version).toBe("0.0.2-alpha");
        expect(entryIds(upgraded)).toEqual([existingEntry.id]);
        const afterEntry = (await ss.listScripts()).find((s) => s.id === existingEntry.id)!;
        expect(afterEntry.enabled).toBe(false);
        expect(afterEntry.code).toContain('console.log("v2")');
        expect((await ss.listDataFiles()).map((d) => d.path).sort()).toEqual(["bonsai/README.md", "bonsai/package.json"]);
        expect((await ss.listScripts()).map((s) => s.meta.name).sort()).toEqual(["bonsai/index.tsx", "bonsai/shared/util/text"]);

        const rolledBack = await pk.rollbackPackage(upgraded.id);
        expect(rolledBack.metadata.version).toBe("0.0.1-alpha");
        expect((await ss.listDataFiles()).map((d) => d.path).sort()).toEqual(["bonsai/README.md", "bonsai/old.json", "bonsai/package.json"]);

        // Later update that begins importing the companion files adopts their existing store ids instead of clashing or duplicating
        const v3 = {
            source: "https://github.com/me/bonsai",
            entries: ["index.tsx"],
            files: {
                "package.json": JSON.stringify({ name: "bonsai", version: "0.0.3-alpha", tangitweak: {} }),
                "index.tsx": 'import { tweak } from "tangitweak"; import "./README.md";\nimport { trim } from "./shared/util/text";\ntweak.onPage("*://a.com/*", () => trim("x"));\n',
                "README.md": "# Bonsai v3\n",
                "shared/util/text.ts": "export const trim = (s: string) => s.trim();\n",
            },
            revision: "def67890",
        };
        const up3 = await pk.upgradePackage(v3, { packageId: rolledBack.id, autoUpdate: true });
        expect(up3.files["README.md"].id).toBe(readme.id);
        expect(up3.files["shared/util/text.ts"].id).toBe(unusedUtil.id);
        expect((await ss.listScripts()).filter((s) => s.meta.name === "bonsai/shared/util/text")).toHaveLength(1);
    });

    it("unwraps stringList tweak.params Proxies in route.url and recovers legacy object-serialized route.url entries", async () => {
        const { describeCapabilities } = await import("../src/shared/packageCaps");
        const paramCode = [
            `import { tweak } from "tangitweak"; const cfg = tweak.params({ pages: { type: "stringList", default: ["http://localhost:8080/*", "https://cloud.mongodb.com/*"] } });`,
            `tweak.onSite(cfg.pages, () => {});`,
            `tweak.onPage({ url: cfg.pages, when: "document_start" }, () => {});`,
        ].join("\n");

        // Saving to structuredClone-backed storage succeeds (plain string[], not Proxy)
        await ss.saveDataFile({ path: "bonsai/package.json", text: JSON.stringify({ name: "bonsai", version: "0.0.1-alpha", tangitweak: {} }) });
        const existing = await ss.saveScript({ id: ss.newId(), name: "bonsai/index.tsx", code: paramCode });
        expect(existing.meta.routes[0].url).toEqual(["http://localhost:8080/*", "https://cloud.mongodb.com/*"]);

        // Simulate legacy Chrome storage having serialized an earlier array Proxy as `{ "0": "...", "1": "..." }`
        store.resScripts[existing.id].meta.routes[0].url = { 0: "http://localhost:8080/*", 1: "https://cloud.mongodb.com/*" };

        const incoming = {
            source: "https://github.com/nima-taheri-mongodb/bonsai",
            entries: ["index.tsx"],
            files: {
                "package.json": JSON.stringify({ name: "bonsai", version: "0.0.2-alpha", tangitweak: {} }),
                "index.tsx": paramCode,
            },
            revision: "9d3dc7db",
        };
        const a = await pk.analyzePackage(incoming);
        expect(a.error).toBeNull();
        expect(a.caps.urls).toEqual(["http://localhost:8080/*", "https://cloud.mongodb.com/*"]);
        expect(describeCapabilities(a.caps).some((c) => c.text.includes("localhost:8080"))).toBe(true);
    });

    it("surfaces a newer dependencies.tangitweak on analyze and holds auto-updates that need a newer TangiTweak", async () => {
        (globalThis as any).chrome.runtime.getManifest = () => ({ version: "0.35.0", version_name: "0.35.0-alpha" });
        const v1 = await fetched(files(entry("*://a.com/*")));
        const pkg = await pk.installPackage(v1, { enabled: true, autoUpdate: true });

        // Update requires TangiTweak 0.99.0 -> analyzed with versionWarning AND held as pending instead of auto-applying
        const v2Files = {
            ...files(entry("*://a.com/*"), LIB, { version: "2.0.0", dependencies: { tangitweak: "^0.99.0" } }),
        };
        const v2 = await fetched(v2Files);
        const analysis = await pk.analyzePackage(v2, pkg.id);
        expect(analysis.versionWarning).toBe("Requires TangiTweak 0.99.0 or newer (you have 0.35.0-alpha).");

        const held = await pk.offerPackage(pkg.id, v2, false);
        expect(held?.metadata.version).toBe("1.0.0"); // not auto-applied
        expect(held?.pending?.metadata.version).toBe("2.0.0");
        expect(held?.pending?.reasons).toContain("Requires TangiTweak 0.99.0 or newer (you have 0.35.0-alpha)");
    });
});
