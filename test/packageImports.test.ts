// Package imports: a tweak bundle's dependencies, imported by name. Package
// URL parsing, the background download of a package's module graph (ESM / CJS / UMD,
// dependency ranges, built-ins, failures, caching, pruning), the runtime
// loader through the compilers and the page hook, and the typings crawl.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../src/shared/transpile";
import { compileManyWithLibs, compileWithLibs, makeModuleResolver } from "../src/shared/compile";
import { makeLibRequire, importResolver } from "../src/shared/scriptImports";
import { errorPosition } from "../src/ui/problems";
import {
    classifyNested,
    declarationRefs,
    exportsFile,
    isEsModule,
    makePackageLoader,
    packageClosure,
    parsePackageUrl,
    rangeUrl,
    requireSpecs,
    typesCandidates,
    typesPackageName,
    PACKAGE_MODULES_KEY,
    PACKAGE_TYPINGS_KEY,
    TYPINGS_FORMAT,
} from "../src/shared/packageImports";
import { fakeUnpkg, REGISTRY } from "./fakeUnpkg";

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
    runtime: { lastError: undefined, sendMessage: () => {}, getURL: (p: string) => `chrome-extension://x/${p}` },
};

let unpkg = fakeUnpkg(REGISTRY);
let current: typeof import("../src/background/engine/packageImports") | undefined;

/** a fresh background module (its in-memory state) over the current store */
async function bg() {
    vi.resetModules();
    return (current = await import("../src/background/engine/packageImports"));
}

/** the tweak bundle `dir` whose main file imports `pkgs` ("name@version" or "name@version/sub") by name: each import goes to that package URL */
function tweakImporting(pkgs: string[], dir = "t") {
    const deps: Record<string, string> = {};
    const code = pkgs
        .map((spec) => {
            const [, name, version, sub = ""] = /^((?:@[^/]+\/)?[^/@]+)@([^/]+)(\/.*)?$/.exec(spec)!;
            deps[name] = version;
            return `import "${name}${sub}";`;
        })
        .join("\n");
    return { script: { name: `${dir}/main`, code }, data: { path: `${dir}/package.json`, text: JSON.stringify({ name: dir, tangitweak: {}, dependencies: deps }) } };
}

/** ensurePackages over a tweak importing `pkgs` */
function ensure(p: Awaited<ReturnType<typeof bg>>, pkgs: string[], opts?: { retry?: boolean }) {
    const t = tweakImporting(pkgs);
    return p.ensurePackages([t.script], { ...opts, data: [t.data] });
}

beforeEach(async () => {
    await current?.packageTypingsIdle();
    for (const k of Object.keys(store)) delete store[k];
    unpkg = fakeUnpkg(REGISTRY);
    (globalThis as any).fetch = unpkg.fetch;
});

describe("package URLs", () => {
    it("accepts pinned unpkg URLs, scoped names, prereleases and subpaths", () => {
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13")).toEqual({ name: "dayjs", version: "1.11.13", sub: "" });
        expect(parsePackageUrl("https://unpkg.com/@scope/pkg@2.0.0-beta.1+build.5/dist/a.js")).toEqual({ name: "@scope/pkg", version: "2.0.0-beta.1+build.5", sub: "dist/a.js" });
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13/plugin/utc")).toEqual({ name: "dayjs", version: "1.11.13", sub: "plugin/utc" });
    });

    it("rejects ranges, tags, other hosts, query strings and odd paths with a helpful message", () => {
        expect(parsePackageUrl("https://unpkg.com/dayjs")).toBe(
            `cannot import "https://unpkg.com/dayjs": pin an exact version, e.g. https://unpkg.com/dayjs@1.2.3 (ranges and tags like "latest" can change under the script)`
        );
        for (const u of ["https://unpkg.com/dayjs@1", "https://unpkg.com/dayjs@^1.2.0", "https://unpkg.com/dayjs@latest/plugin/utc", "https://unpkg.com/@s/x@1.2"]) expect(parsePackageUrl(u)).toMatch(/pin an exact version/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@latest/plugin/utc")).toMatch(/e\.g\. https:\/\/unpkg\.com\/dayjs@1\.2\.3\/plugin\/utc/);
        expect(parsePackageUrl("https://cdn.jsdelivr.net/npm/dayjs@1.11.13")).toMatch(/only pinned https:\/\/unpkg\.com\/<package>@<version> URLs/);
        expect(parsePackageUrl("http://unpkg.com/dayjs@1.11.13")).toMatch(/only pinned/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13?module")).toMatch(/query string or hash/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13#x")).toMatch(/query string or hash/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13/../x")).toMatch(/isn't normalized/);
        expect(parsePackageUrl("https://unpkg.com/")).toMatch(/not a package URL/);
    });

    it("are never script or data file imports", () => {
        expect(importResolver(["https:/unpkg.com/x@1.0.0"])("main", "https://unpkg.com/x@1.0.0")).toBeUndefined();
    });

    it("classifies a library's nested specifiers", () => {
        const from = "https://unpkg.com/a@1.0.0/dist/x.js";
        expect(classifyNested("./y", from)).toEqual({ url: "https://unpkg.com/a@1.0.0/dist/y" });
        expect(classifyNested("../z.js", from)).toEqual({ url: "https://unpkg.com/a@1.0.0/z.js" });
        expect(classifyNested("/b@2.0.0/c.js", from)).toEqual({ url: "https://unpkg.com/b@2.0.0/c.js" });
        expect(classifyNested("https://unpkg.com/b@2.0.0", from)).toEqual({ url: "https://unpkg.com/b@2.0.0" });
        expect(classifyNested("https://esm.sh/b", from)).toHaveProperty("error");
        expect(classifyNested("@s/p/sub/x", from)).toEqual({ bare: "@s/p", sub: "sub/x" });
        expect(rangeUrl("b", "^1.2.0 || 2", "x.js")).toBe("https://unpkg.com/b@%5E1.2.0%20%7C%7C%202/x.js");
        expect(rangeUrl("b", undefined, "")).toBe("https://unpkg.com/b@latest");
        for (const r of ["workspace:*", "github:a/b", "file:../x", "a/b"]) expect(rangeUrl("b", r, "")).toBeNull();
        // npm: aliases name another package
        expect(rangeUrl("b", "npm:other@1", "")).toBe("https://unpkg.com/other@1");
        expect(rangeUrl("events", "npm:events@^3", "")).toBe("https://unpkg.com/events@%5E3");
        expect(rangeUrl("x", "npm:@s/y", "sub/a.js")).toBe("https://unpkg.com/@s/y@latest/sub/a.js");
        expect(typesPackageName("@scope/x")).toBe("@types/scope__x");
    });

    it("scans code: ES module syntax, requires and declaration references", () => {
        expect(isEsModule(`export default 1`)).toBe(true);
        expect(isEsModule(`const a = 1;\nimport x from "y"`)).toBe(true);
        expect(isEsModule(`module.exports = { importer: 1 }; // import x from "y"`)).toBe(false);
        expect(isEsModule(`exports.a = 1;\nexports.b = 2;\nimports.c = 3;`)).toBe(false);
        expect(requireSpecs(`a.require("no"); require("x"); require('./y'); myrequire("z")`)).toEqual(["x", "./y"]);
        const refs = declarationRefs(`/// <reference path="./g.d.ts" />\n/// <reference types="node" />\nimport a from "./a";\nexport * from "b/c";\ntype T = import("./t");\nimport e = require("e");\ndeclare module "ambient" {}\ndeclare module "./aug" {}\n// import z from "./commented"`);
        expect(refs).toEqual({ specs: ["./a", "b/c", "./t", "e", "./aug"], paths: ["./g.d.ts"], types: ["node"] });
        expect(typesCandidates({ exports: { ".": { node: { import: { types: "./n.d.mts" } } } } }, "")).toEqual(["n.d.mts", "index.d.ts"]);
        // like TypeScript: `import` before `require`, whatever the order
        expect(typesCandidates({ exports: { "./a": { require: { types: "./a.d.cts" }, import: { types: "./a.d.ts" } } } }, "a.js")[0]).toBe("a.d.ts");
        expect(typesCandidates({ exports: { "./a": { require: { types: "./a.d.cts" } } } }, "a")[0]).toBe("a.d.cts");
        expect(typesCandidates({ main: "dist/a.js" }, "")).toEqual(["dist/a.d.ts", "index.d.ts"]);
        // no types condition: the declaration beside the exported file (@redux-devtools/instrument)
        expect(typesCandidates({ exports: "./lib/instrument.js" }, "")).toEqual(["lib/instrument.d.ts", "index.d.ts"]);
        expect(typesCandidates({ exports: { "./b": { import: "./dist/b.mjs" } } }, "b")[0]).toBe("dist/b.d.mts");
        expect(typesCandidates({ exports: { "./*": { types: "./t/*.d.ts" } } }, "x.js")).toEqual(["t/x.js.d.ts", "t/x.d.ts", "x.d.ts", "x.js.d.ts", "x.js/index.d.ts", "x.d.mts", "x.d.cts"]);
    });
});

describe("downloading a package's module graph", () => {
    it("ESM (relative imports, import.meta), CJS with dependency ranges, UMD in sloppy mode", async () => {
        const p = await bg();
        const urls = ["https://unpkg.com/esm-lib@1.0.0", "https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/umd-lib@1.0.0"];
        expect(await ensure(p, ["esm-lib@1.0.0", "cjs-lib@2.0.0", "umd-lib@1.0.0"])).toBe(true);
        const pkgs = p.packagesSnapshot();
        expect(pkgs.aliases["https://unpkg.com/esm-lib@1.0.0"]).toBe("https://unpkg.com/esm-lib@1.0.0/index.js");
        expect(pkgs.modules["https://unpkg.com/esm-lib@1.0.0/index.js"].requires["./math.js"]).toBe("https://unpkg.com/esm-lib@1.0.0/math.js");
        // "^3.0.0" → 3.1.0, not 4.0.0
        expect(pkgs.modules["https://unpkg.com/cjs-lib@2.0.0/lib/index.js"].requires).toEqual({
            "dep-lib": "https://unpkg.com/dep-lib@3.1.0/index.js",
            "dep-lib/extra": "https://unpkg.com/dep-lib@3.1.0/extra.js",
        });
        const load = makePackageLoader(pkgs);
        const esm = load(urls[0]);
        expect(esm.default(4)).toBe(8);
        expect(esm.add(1, 2)).toBe(3);
        expect(esm.where).toBe("https://unpkg.com/esm-lib@1.0.0/index.js");
        expect(esm.Id.first).toBe(7); // a static block sees the static fields above it
        expect(load(urls[1]).shout("hi")).toBe("HI!");
        expect(load(urls[2])).toEqual({ rootIsExports: true, sloppy: true, nodeEnv: "production" });
        delete (globalThis as any).ttUmdSloppyGlobal;
        // stored for later runs (offline)
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules)).toHaveLength(6);
    });

    it("a subpath only package.json `exports` maps, or a folder's own package.json, resolves through it (production, ES module first)", async () => {
        const p = await bg();
        const sub = "https://unpkg.com/cond-lib@1.0.0/is-dev";
        await ensure(p, ["cond-user@1.0.0", "cond-lib@1.0.0/is-dev"]);
        const pkgs = p.packagesSnapshot();
        expect(pkgs.modules["https://unpkg.com/cond-user@1.0.0/index.js"].requires["cond-lib/is-dev"]).toBe("https://unpkg.com/cond-lib@1.0.0/prod.mjs");
        expect(pkgs.aliases[sub]).toBe("https://unpkg.com/cond-lib@1.0.0/prod.mjs");
        const load = makePackageLoader(pkgs);
        expect(pkgs.modules["https://unpkg.com/cond-user@1.0.0/index.js"].requires["cond-lib/consts"]).toBe("https://unpkg.com/cond-lib@1.0.0/dist/consts.js");
        expect(load("https://unpkg.com/cond-user@1.0.0")).toEqual({ dev: false, gap: 7 });
        expect(load(sub).IS_DEV).toBe(false);
        expect(exportsFile({ exports: { "./a": [{ worker: "./w.js" }, "./a.js"] } }, "a")).toBe("a.js");
        expect(exportsFile({ exports: { "./a": { node: "./n.js" } } }, "a")).toBeUndefined();
        expect(exportsFile({ main: "x.js" }, "a")).toBeUndefined();
    });

    it("a save retries a stored package's failed nested requires (a download from before a fix, a flaky one)", async () => {
        const top = "https://unpkg.com/cond-user@1.0.0";
        const code = ["cond-user@1.0.0"];
        await ensure(await bg(), code);
        const user = "https://unpkg.com/cond-user@1.0.0/index.js";
        // as an older version stored it: the nested require failed, a built-in too
        store[PACKAGE_MODULES_KEY].modules[user].requires["cond-lib/is-dev"] = `!cannot import "cond-lib/is-dev" (required by ${user}): HTTP 404`;
        store[PACKAGE_MODULES_KEY].modules[user].requires["fs"] = `!"fs" is a Node.js built-in — not available in TangiTweak scripts`;
        let p = await bg();
        expect(await ensure(p, code)).toBe(false); // not on a plain ensure (startup, page loads)
        expect(p.packagesSnapshot().modules[user].requires["cond-lib/is-dev"]).toMatch(/^!/);
        unpkg.calls.length = 0;
        expect(await ensure(p, code, { retry: true })).toBe(true);
        expect(p.packagesSnapshot().modules[user].requires["cond-lib/is-dev"]).toBe("https://unpkg.com/cond-lib@1.0.0/prod.mjs");
        expect(p.packagesSnapshot().modules[user].requires["fs"]).toMatch(/Node\.js built-in/);
        expect(unpkg.calls.filter((u) => u.includes("cond-user") && !u.endsWith("/package.json"))).toEqual([]); // the stored module isn't downloaded again
        p = await bg();
        await p.loadPackages();
        expect(makePackageLoader(p.packagesSnapshot())(top).dev).toBe(false); // stored
        unpkg.calls.length = 0;
        expect(await ensure(p, code, { retry: true })).toBe(false); // nothing left to retry
        expect(unpkg.calls).toEqual([]);
    });

    it("a library's require of a Node.js built-in or a missing file throws a clear error only when run", async () => {
        const p = await bg();
        await ensure(p, ["builtin-lib@1.0.0", "nested-fail@1.0.0"]);
        const load = makePackageLoader(p.packagesSnapshot());
        expect(load("https://unpkg.com/builtin-lib@1.0.0")).toEqual({
            ok: true,
            err: `"fs" is a Node.js built-in — not available in tweaks`,
            err2: `"node:path" is a Node.js built-in — not available in tweaks — add "path": "npm:path-browserify" to the tweak's package.json "dependencies" to use npm's browser version`,
        });
        const nf = load("https://unpkg.com/nested-fail@1.0.0");
        expect(nf.ok).toBe(1);
        expect(nf.err).toMatch(/cannot import "\.\/missing\.js" \(required by https:\/\/unpkg\.com\/nested-fail@1\.0\.0\/index\.js\): HTTP 404/);
        expect(unpkg.calls.filter((c) => c.includes("fs"))).toEqual([]);
    });

    it("a package's npm: alias dependency downloads the package it names", async () => {
        const p = await bg();
        await ensure(p, ["alias-user@1.0.0"]);
        const pkgs = p.packagesSnapshot();
        expect(pkgs.modules["https://unpkg.com/alias-user@1.0.0/index.js"].requires.evt).toBe("https://unpkg.com/tiny-events@1.0.0/index.js");
        expect(makePackageLoader(pkgs)("https://unpkg.com/alias-user@1.0.0")).toEqual({ evt: "tiny-events" });
    });

    it("a tweak's bare imports come from its package.json; a Node.js built-in a package needs falls back to the tweak's dependencies", async () => {
        const tweak = (deps: Record<string, string>) => [{ path: "t/package.json", text: JSON.stringify({ name: "t", tangitweak: {}, dependencies: deps }) }];
        const entry = { name: "t/index", code: `import n from "needs-events";` };
        let p = await bg();
        await p.ensurePackages([entry], { data: tweak({ "needs-events": "^1.0.0" }) });
        let load = makePackageLoader(p.packagesSnapshot());
        const bare = p.packagesSnapshot().aliases["https://unpkg.com/needs-events@%5E1.0.0"];
        expect(bare).toBe("https://unpkg.com/needs-events@1.0.0/index.js");
        // not given: the error says how to add it
        expect(load(bare).err).toMatch(/^"events" is a Node\.js built-in — not available in tweaks — add "events": "latest" to the tweak's package\.json "dependencies"/);
        for (const k of Object.keys(store)) delete store[k];
        p = await bg();
        const deps = { "needs-events": "^1.0.0", events: "npm:tiny-events@^1.0.0" };
        await p.ensurePackages([entry], { data: tweak(deps) });
        load = makePackageLoader(p.packagesSnapshot());
        expect(load("https://unpkg.com/needs-events@1.0.0/index.js", deps)).toEqual({ events: "tiny-events", nodeEvents: "tiny-events" });
    });

    it("the built-in fallback is per tweak: two tweaks sharing a package each get their own `events`", async () => {
        const tweak = (name: string, events: string) => ({ path: `${name}/package.json`, text: JSON.stringify({ name, tangitweak: {}, dependencies: { "needs-events": "^1.0.0", events } }) });
        const data = [tweak("a", "npm:tiny-events@^1.0.0"), tweak("b", "npm:tiny-events@^2.0.0")];
        const entries = ["a", "b"].map((t) => ({ name: `${t}/index`, code: `import n from "needs-events";` }));
        let p = await bg();
        // one tweak at a time, like two saves: the second still gets its own
        await p.ensurePackages([entries[0]], { data });
        await p.ensurePackages(entries, { data });
        const mod = "https://unpkg.com/needs-events@1.0.0/index.js";
        const check = (pkgs: ReturnType<typeof p.packagesSnapshot>) => {
            const load = makePackageLoader(pkgs);
            expect(load(mod, JSON.parse(data[0].text).dependencies)).toEqual({ events: "tiny-events", nodeEvents: "tiny-events" });
            expect(load(mod, JSON.parse(data[1].text).dependencies)).toEqual({ events: "tiny-events 2", nodeEvents: "tiny-events 2" });
            expect(load(mod).err).toMatch(/"events" is a Node\.js built-in/);
        };
        check(p.packagesSnapshot());
        // one compile of both tweaks (one loader): each gets its own
        const seen: string[] = ((globalThis as any).ttSeenEvents = []);
        const scripts = ["a", "b"].map((t) => ({ id: t, name: `${t}/index`, code: `import n from "needs-events"; (globalThis as any).ttSeenEvents.push("${t}:" + n.events);` }));
        compileManyWithLibs(["a", "b"], scripts, {}, data, p.packagesSnapshot());
        expect(seen).toEqual(["a:tiny-events", "b:tiny-events 2"]);
        delete (globalThis as any).ttSeenEvents;
        // stored: a fresh background has both
        p = await bg();
        await p.loadPackages();
        check(p.packagesSnapshot());
        unpkg.calls.length = 0;
        expect(await p.ensurePackages(entries, { data })).toBe(false); // nothing left to resolve
        expect(unpkg.calls.filter((u) => u.includes("events"))).toEqual([]);
    });

    it("cycles get partial exports; JSON modules export their data", async () => {
        const p = await bg();
        await ensure(p, ["cycle-lib@1.0.0", "json-lib@1.0.0"]);
        const load = makePackageLoader(p.packagesSnapshot());
        expect(load("https://unpkg.com/cycle-lib@1.0.0")).toEqual({ a: 1, fromB: 1 });
        expect(load("https://unpkg.com/json-lib@1.0.0")).toBe(5);
    });

    it("a .css module adds a <style> through the loader's `style` (elsewhere it's ignored)", async () => {
        const p = await bg();
        const url = "https://unpkg.com/css-lib@1.0.0/dist/theme.css";
        await ensure(p, ["css-lib@1.0.0/dist/theme.css"]);
        const styles: [string, string][] = [];
        expect(() => makePackageLoader(p.packagesSnapshot())(url)).not.toThrow();
        makePackageLoader(p.packagesSnapshot(), undefined, { style: (css, from) => styles.push([css, from]) })(url);
        expect(styles).toEqual([[".btn { color: red; }\n", url]]);
        const pkgs = p.packagesSnapshot();
        const shipped = [...Object.entries(pkgs.modules).map(([name, pkg]) => ({ name, pkg })), ...Object.entries(pkgs.aliases).map(([name, alias]) => ({ name, alias })), { name: "t/package.json", json: tweakImporting(["css-lib@1.0.0"]).data.text }];
        const seen: string[] = [];
        makeLibRequire(shipped, () => {}, { style: (css) => seen.push(css) })("t/main")("css-lib/dist/theme.css");
        expect(seen).toEqual([".btn { color: red; }\n"]);
    });

    it("is cached: a second ensure (and a fresh background) fetches nothing", async () => {
        let p = await bg();
        const code = ["cjs-lib@2.0.0"];
        await ensure(p, code);
        await p.packageTypingsIdle();
        const n = unpkg.calls.length;
        expect(await ensure(p, code)).toBe(false);
        p = await bg();
        expect(await ensure(p, code)).toBe(false);
        await p.packageTypingsIdle();
        expect(unpkg.calls.length).toBe(n);
        expect(makePackageLoader(p.packagesSnapshot())("https://unpkg.com/cjs-lib@2.0.0").shout("a")).toBe("A!");
    });

    it("a failed download isn't stored and is retried on the next save", async () => {
        const p = await bg();
        const code = ["esm-lib@1.0.0"];
        unpkg.setOffline(true);
        await ensure(p, code, { retry: true });
        expect(p.packagesSnapshot().failed).toEqual({ "https://unpkg.com/esm-lib@1.0.0": "download failed (Failed to fetch)" });
        expect(store[PACKAGE_MODULES_KEY]).toBeUndefined();
        const sig = p.packagesSig();
        // a compile (no retry) right after doesn't hammer the network
        const n = unpkg.calls.length;
        await ensure(p, code);
        expect(unpkg.calls.length).toBe(n);
        unpkg.setOffline(false);
        expect(await ensure(p, code, { retry: true })).toBe(true);
        expect(p.packagesSnapshot().failed).toEqual({});
        expect(p.packagesSig()).not.toBe(sig);
    });

    it("the install page's status request starts the download: downloading → typing → ready, or failed with why", async () => {
        const p = await bg();
        const u = "https://unpkg.com/esm-lib@1.0.0";
        expect(await p.requestPackages([u, "https://unpkg.com/esm-lib@1", "./x"])).toEqual({ [u]: { state: "downloading" } });
        await vi.waitFor(() => expect(p.packageStatus(u).state).toMatch(/^(typing|ready)$/));
        await p.packageTypingsIdle();
        expect(p.packageStatus(u)).toEqual({ state: "ready" });
        expect(await p.requestPackages([u])).toEqual({ [u]: { state: "ready" } });

        const v = "https://unpkg.com/cjs-lib@2.0.0";
        unpkg.setOffline(true);
        await p.requestPackages([v]);
        await vi.waitFor(() => expect(p.packageStatus(v)).toEqual({ state: "failed", reason: "download failed (Failed to fetch)" }));
        // asking again within the minute doesn't hammer the network
        const n = unpkg.calls.length;
        expect(await p.requestPackages([v])).toEqual({ [v]: { state: "failed", reason: "download failed (Failed to fetch)" } });
        expect(unpkg.calls.length).toBe(n);
    });

    it("prunes modules and typings no script imports any more", async () => {
        const p = await bg();
        await ensure(p, ["esm-lib@1.0.0", "cjs-lib@2.0.0"]);
        await p.packageTypingsIdle();
        expect(Object.keys(p.packageTypings().tops).sort()).toEqual(["https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/esm-lib@1.0.0"]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 120_000); // past the guard for just-saved imports
        try {
            const a = tweakImporting(["esm-lib@1.0.0"]);
            (await import("../src/background/engine/dataFiles")).setDataFilesSnapshot({ d: { id: "d", ...a.data, savedAt: 0 } });
            await p.prunePackages([a.script]);
        } finally {
            vi.useRealTimers();
        }
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules).sort()).toEqual(["https://unpkg.com/esm-lib@1.0.0/index.js", "https://unpkg.com/esm-lib@1.0.0/math.js"]);
        expect(Object.keys(store[PACKAGE_MODULES_KEY].aliases)).toEqual(["https://unpkg.com/esm-lib@1.0.0"]);
        expect(Object.keys(store[PACKAGE_TYPINGS_KEY].tops)).toEqual(["https://unpkg.com/esm-lib@1.0.0"]);
        expect(Object.keys(store[PACKAGE_TYPINGS_KEY].files).every((f) => f.startsWith("unpkg.com/esm-lib@1.0.0/"))).toBe(true);
    });

    it("a prune racing a save keeps what was just ensured", async () => {
        const p = await bg();
        await ensure(p, ["esm-lib@1.0.0"]);
        await p.prunePackages([]);
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules)).toHaveLength(2);
    });
});

describe("package imports in scripts", () => {
    const PKG = { path: "t/package.json", text: JSON.stringify({ name: "t", tangitweak: {}, dependencies: { "esm-lib": "1.0.0", "cjs-lib": "2.0.0", "umd-lib": "1.0.0", nope: "1.0.0" } }) };
    const SCRIPT = `import { tweak } from "tangitweak"; import twice from "esm-lib";
import { shout } from "cjs-lib";
export const run = () => shout(String(twice(21)) + "x");
tweak.params({ n: { type: "number", default: twice(2) } });
tweak.onRequest({ url: "*://a.test/*", strategy: "helper" }, () => {});`;
    const main = (code: string) => ({ id: "m", name: "t/main", code });

    it("compile and run through the background resolver", async () => {
        const p = await bg();
        await p.ensurePackages([main(SCRIPT)], { data: [PKG] });
        const c = compileWithLibs(main(SCRIPT), [], {}, [PKG], p.packagesSnapshot());
        expect(c.error).toBeNull();
        expect(c.paramDefs?.n.default).toBe(4);
        expect(c.exports.run()).toBe("42X!");
        expect(c.deps.filter((d) => d.startsWith("https:")).sort()).toEqual(["https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/esm-lib@1.0.0"]);
    });

    it("a library script's package import works for its importers; each module runs once per registry", async () => {
        const p = await bg();
        const lib = { id: "l", name: "t/lib/util", code: `import twice from "esm-lib";\nexport const four = twice(2);` };
        const m = main(`import { four } from "./lib/util";\nimport twice from "esm-lib";\nexport const same = [four, twice(2)];`);
        await p.ensurePackages([lib, m], { data: [PKG] });
        const r = makeModuleResolver([lib, m], () => ({}), { packages: p.packagesSnapshot(), dataFiles: [PKG] });
        const a = r.resolveFrom("t/main")("esm-lib");
        expect(r.resolveFrom("t/lib/util")("esm-lib")).toBe(a);
        const c = compileWithLibs(m, [lib], {}, [PKG], p.packagesSnapshot());
        expect(c.error).toBeNull();
        expect(c.exports.same).toEqual([4, 4]);
    });

    it("a URL import, or a missing or failed package, is the importer's compile error at the import line, never a stub", async () => {
        const p = await bg();
        const at = (code: string, pkgs = p.packagesSnapshot()) => {
            const c = compileWithLibs(main(code), [], {}, [PKG], pkgs);
            return { error: c.error, line: c.error ? errorPosition(c.error)?.line : undefined };
        };
        expect(at(`import { tweak } from "tangitweak"; // x\n\nimport d from "https://unpkg.com/esm-lib@1.0.0";\ntweak.onRequest({ url: "*://a/*", strategy: "helper" }, () => d());`)).toEqual({
            error: expect.stringContaining(`cannot import "https://unpkg.com/esm-lib@1.0.0": URL imports aren't supported — add the package to "dependencies" in package.json and import it by name`),
            line: 3,
        });
        expect(at(`import d from "https://example.com/x.js";\nd();`).error).toMatch(/URL imports aren't supported/);
        expect(at(`\nimport d from "esm-lib";\nd();`)).toEqual({
            error: expect.stringMatching(/cannot import "esm-lib": not downloaded yet — save the tweak to download it/),
            line: 2,
        });

        const missing = `import { tweak } from "tangitweak"; \nimport x from "nope";\ntweak.onRequest({ url: "*://a/*", strategy: "helper" }, () => x());`;
        await p.ensurePackages([main(missing)], { retry: true, data: [PKG] });
        expect(at(missing)).toEqual({ error: expect.stringMatching(/cannot import "https:\/\/unpkg\.com\/nope@1\.0\.0": download failed \(HTTP 404 — no such package, version or file\)/), line: 2 });

        unpkg.setOffline(true);
        const offline = `import x from "umd-lib";\nx();`;
        await p.ensurePackages([main(offline)], { retry: true, data: [PKG] });
        expect(at(offline).error).toMatch(/cannot import "https:\/\/unpkg\.com\/umd-lib@1\.0\.0": download failed \(Failed to fetch\)/);
    });

    it("the page hook's require resolves bare imports and libraries' nested requires, and refuses URL imports", async () => {
        const p = await bg();
        await p.ensurePackages([main(SCRIPT)], { data: [PKG] });
        const pkgs = p.packagesSnapshot();
        const libs = [
            ...Object.entries(pkgs.aliases).map(([name, alias]) => ({ name, alias, src: "" })),
            ...[...packageClosure(pkgs, Object.keys(pkgs.aliases))].map((name) => ({ name, pkg: pkgs.modules[name], src: "" })),
            { name: "t/util", src: "" },
            { name: "t/package.json", json: PKG.text },
        ];
        const ran: string[] = [];
        const requireFrom = makeLibRequire(libs, (lib, require, m) => {
            ran.push(lib.name);
            m.exports.v = require("esm-lib").default(5);
        });
        expect(requireFrom("t/main")("cjs-lib").shout("ok")).toBe("OK!");
        expect(requireFrom("t/main")("./util").v).toBe(10);
        expect(ran).toEqual(["t/util"]);
        expect(() => requireFrom("t/main")("https://unpkg.com/esm-lib@1.0.0")).toThrow(/URL imports aren't supported/);
    });
});

describe("package typings", () => {
    async function typingsOf(...urls: string[]) {
        const p = await bg();
        await ensure(p, urls);
        await p.packageTypingsIdle();
        return p.packageTypings();
    }

    it("a package's own types: entry, relative references and a pointer package.json", async () => {
        const t = await typingsOf("esm-lib@1.0.0", "esm-lib@1.0.0/math.js");
        expect(Object.keys(t.files).sort()).toEqual(["unpkg.com/esm-lib@1.0.0/index.d.ts", "unpkg.com/esm-lib@1.0.0/math.d.ts", "unpkg.com/esm-lib@1.0.0/package.json"]);
        expect(JSON.parse(t.files["unpkg.com/esm-lib@1.0.0/package.json"])).toEqual({ name: "esm-lib", version: "1.0.0", types: "./index.d.ts" });
        expect(t.tops["https://unpkg.com/esm-lib@1.0.0/math.js"]).toEqual(["unpkg.com/esm-lib@1.0.0/math.d.ts"]);
        expect(store[PACKAGE_TYPINGS_KEY]).toEqual({ ...t, v: TYPINGS_FORMAT });
    });

    it("`exports` types, a subpath, `/// <reference path>` and a bare type dependency under node_modules", async () => {
        const t = await typingsOf("exp-lib@1.0.0", "exp-lib@1.0.0/sub");
        expect(JSON.parse(t.files["unpkg.com/exp-lib@1.0.0/package.json"]).types).toBe("./dist/index.d.mts");
        expect(t.files["unpkg.com/exp-lib@1.0.0/dist/globals.d.ts"]).toContain("EXP_LIB_GLOBAL");
        expect(JSON.parse(t.files["unpkg.com/exp-lib@1.0.0/sub/package.json"])).toEqual({ types: "../dist/sub.d.ts" });
        // dep-lib "^3.0.0" → 3.1.0, mirrored once, pointed at from node_modules
        expect(t.files["unpkg.com/dep-lib@3.1.0/types.d.ts"]).toContain("interface Dep");
        expect(JSON.parse(t.files["node_modules/dep-lib/package.json"])).toEqual({ name: "dep-lib", version: "3.1.0", types: "../../unpkg.com/dep-lib@3.1.0/types.d.ts" });
    });

    it("no declarations: @types at the same major, else a stub", async () => {
        const t = await typingsOf("cjs-lib@2.0.0", "umd-lib@1.0.0");
        expect(t.files["unpkg.com/@types/cjs-lib@2.0.1/index.d.ts"]).toContain("shout(s: string): string");
        expect(JSON.parse(t.files["unpkg.com/cjs-lib@2.0.0/package.json"]).types).toBe("../@types/cjs-lib@2.0.1/index.d.ts");
        expect(t.files["unpkg.com/umd-lib@1.0.0/index.d.ts"]).toMatch(/no TypeScript declarations[\s\S]*export = mod/);
        expect(JSON.parse(t.files["unpkg.com/umd-lib@1.0.0/package.json"]).types).toBe("./index.d.ts");
    });

    it("typings stored as stubs by an older resolution get another try; real ones are kept", async () => {
        const t = await typingsOf("esm-lib@1.0.0", "umd-lib@1.0.0");
        store[PACKAGE_TYPINGS_KEY] = { files: t.files, tops: t.tops }; // no format: older resolution
        const p = await bg();
        await p.loadPackages();
        expect(Object.keys(p.packageTypings().tops)).toEqual(["https://unpkg.com/esm-lib@1.0.0"]);
        expect(Object.keys(p.packageTypings().files).some((f) => f.startsWith("unpkg.com/umd-lib"))).toBe(false);
        expect(p.packageStatus("https://unpkg.com/umd-lib@1.0.0").state).toBe("typing");
    });

    it("typing failures don't fail the download", async () => {
        const p = await bg();
        const real = unpkg.fetch;
        (globalThis as any).fetch = async (u: string) => (/\.d\.|@types/.test(u) ? Promise.reject(new TypeError("Failed to fetch")) : real(u));
        await ensure(p, ["esm-lib@1.0.0"]);
        await p.packageTypingsIdle();
        expect(p.packagesSnapshot().failed).toEqual({});
        expect(p.packageTypings().tops).toEqual({});
        expect(p.packageStatus("https://unpkg.com/esm-lib@1.0.0")).toMatchObject({ state: "untyped", reason: expect.stringContaining("Failed to fetch") });
    });
});
