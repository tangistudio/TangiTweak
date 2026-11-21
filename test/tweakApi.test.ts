// `import { tweak } from "tangitweak"`: the scripting API. Each
// file gets its own `tweak`; its handlers are keyed by registration order and
// its unnamed stores by file + position — the same in every world.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, makeModuleResolver, onSiteUses, rulesProblems, siteProblems, toRunnableJs } from "../src/shared/compile";
import { makePageShim, type PageStores } from "../src/shared/pageShim";
import { badPackageImports, makeLibRequire, packageUrls } from "../src/shared/scriptImports";
import { scriptFunction } from "../src/shared/scriptFn";
import { formatScriptError, TT_REMOVED } from "../src/shared/scriptError";
import { builtinModule } from "../src/shared/builtins";
import { needsBuiltinTypings } from "../src/ui/tsWorkspace";
import { onPageEdit, siteStoreEdits } from "../src/ui/placeFix";

const STATE = [
    `import { tweak } from "tangitweak";`,
    `export const page = tweak.pageStore({ hits: 0 });`,
    `export const site = tweak.siteStore({ token: "" });`,
    `export function install() { return tweak.onPage("*", () => "lib"); }`,
].join("\n");
const MAIN = [
    `import { tweak as tw } from "tangitweak";`,
    `import { install } from "./state";`,
    `const g = tw.globalStore("app-state", { n: 1 });`,
    `const tab = tw.tabStore({ open: false });`,
    `function reg(v: string) { return tw.onPage("*", () => v); }`,
    `tw.onSite("*", () => "site");`,
    `reg("a");`,
    `install();`,
    `const p = tw.pageStore({ x: 1 });`,
    `tw.onPage("*", () => "b");`,
    `tw.onOverlay("*", () => {});`,
    `reg("c");`,
].join("\n");
const SCRIPTS = [
    { id: "state", name: "state", code: STATE },
    { id: "main", name: "main", code: MAIN },
];
// numbered tweak-wide: the module's registration is one of the entry's
const PAGE_KEYS = ["onPage:0", "onPage:1", "onPage:2", "onPage:3"];

/** the store names each kind was asked for */
function recorder() {
    const names: string[] = [];
    const rec = (kind: string) => (name: string, initial: object) => (names.push(`${kind} ${name}`), { ...initial });
    return { names, tabStore: rec("tab"), pageStore: rec("page"), siteStore: rec("site"), store: rec("global") };
}

function background() {
    const r = recorder();
    const overrides = { tabStore: r.tabStore, pageStore: r.pageStore, siteStore: r.siteStore, store: r.store };
    const c = compileScript(MAIN, { name: "main", ...overrides, importModule: makeModuleResolver(SCRIPTS, () => overrides).resolveFrom("main") });
    return { c, names: r.names };
}

function page(world: "isolated" | "page") {
    const r = recorder();
    const stores: PageStores = { store: (n, i) => r.store(n, i), tabStore: r.tabStore, pageStore: r.pageStore };
    const base = { params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world, siteStore: r.siteStore, ...(world === "isolated" ? { stores } : {}) };
    const libs = [{ name: "state", src: toRunnableJs(STATE) }];
    const shim = makePageShim(base);
    const requireFrom = makeLibRequire(libs, (lib, require, m) => scriptFunction(lib.src!, lib.name)(shim.host, console, require, m, m.exports));
    const m = { exports: {} as any };
    shim.top(() => scriptFunction(toRunnableJs(MAIN), "main")(shim.host, console, requireFrom("main"), m, m.exports));
    return { shim, names: r.names };
}

describe("tweak: handler keys by registration order, the same in every world", () => {
    it("background (and the overlay, which compiles the same way): keys by registration order", () => {
        const { c } = background();
        expect(c.error).toBeNull();
        expect(c.meta.active).toBe(true);
        const keys = c.meta.routes.filter((r) => r.key).map((r) => r.key);
        expect(keys).toEqual(["onSite:0", ...PAGE_KEYS, "onOverlay:0"]);
        expect(c.meta.routes.find((r) => r.key === "onPage:1")!.file).toBe("state");
    });

    it("the isolated world (onPage) and the site's world (onSite) compute the background's keys", () => {
        const iso = page("isolated").shim;
        expect(iso.dom.map((d) => [d.h, d.fn({})])).toEqual([
            ["onPage:0", "a"],
            ["onPage:1", "lib"],
            ["onPage:2", "b"],
            ["onPage:3", "c"],
        ]);
        expect(page("page").shim.dom.map((d) => [d.h, d.fn({})])).toEqual([["onSite:0", "site"]]);
    });

    it("unnamed stores: named by file + position among tab/page/site stores, the same in every world", () => {
        const expected = ["global app-state", "tab main#0", "page state#0", "site state#1", "page main#1"];
        const sorted = (n: string[]) => [...n].sort();
        expect(sorted(background().names)).toEqual(sorted(expected));
        // the isolated world mirrors the site store
        expect(sorted(page("isolated").names)).toEqual(sorted(expected));
        // the site's world: its stores throw, but positions still count — the site store keeps its name
        expect(page("page").names).toEqual(["site state#1"]);
    });
});

describe("tweak: stores a library's function creates", () => {
    const LIB = [`import { tweak } from "tangitweak";`, `export function counter() { return tweak.pageStore({ n: 0 }); }`].join("\n");
    const caller = (pre: string) => [`import { tweak } from "tangitweak";`, `import { counter } from "./lib";`, pre, `counter();`, `counter();`].join("\n");
    const scripts = [
        { id: "lib", name: "lib", code: LIB },
        { id: "a", name: "a", code: caller(`tweak.tabStore({});`) },
        { id: "b", name: "b", code: caller("") },
    ];

    it("belong to the caller's run: the same names on every compile, with the library cached", () => {
        const r = recorder();
        const overrides = { tabStore: r.tabStore, pageStore: r.pageStore, siteStore: r.siteStore, store: r.store };
        // one resolver for every compile, as the background keeps one: the library module is loaded once
        const resolver = makeModuleResolver(scripts, () => overrides);
        const compile = (s: (typeof scripts)[number]) => {
            r.names.length = 0;
            const c = compileScript(s.code, { name: s.name, ...overrides, importModule: resolver.resolveFrom(s.id) });
            expect(c.error).toBeNull();
            return [...r.names];
        };
        // named after the library file, counted per caller run (not per loaded module), kept in the caller's stores
        const a = ["tab a#0", "page lib#0", "page lib#1"];
        expect(compile(scripts[1])).toEqual(a);
        expect(compile(scripts[2])).toEqual(["page lib#0", "page lib#1"]);
        expect(compile(scripts[1])).toEqual(a);
    });

    it("the page worlds name them the same", () => {
        const r = recorder();
        const stores: PageStores = { store: (n, i) => r.store(n, i), tabStore: r.tabStore, pageStore: r.pageStore };
        const base = { params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated" as const, siteStore: r.siteStore, stores };
        const shim = makePageShim(base);
        const requireFrom = makeLibRequire([{ name: "lib", src: toRunnableJs(LIB) }], (lib, require, m) => scriptFunction(lib.src!, lib.name)(shim.host, console, require, m, m.exports));
        const m = { exports: {} as any };
        shim.top(() => scriptFunction(toRunnableJs(scripts[1].code), "a")(shim.host, console, requireFrom("a"), m, m.exports));
        expect(r.names).toEqual(["tab a#0", "page lib#0", "page lib#1"]);
    });
});

describe("tweak: the API", () => {
    const run = (code: string) => compileScript(code, { name: "main" });

    it("has no metadata or defineParam, but the env fields", () => {
        const c = run(`import { tweak } from "tangitweak";\nexport const has = ["metadata" in tweak, "defineParam" in tweak, typeof tweak.isMV3, typeof tweak.params];`);
        expect(c.error).toBeNull();
        expect(c.exports.has).toEqual([false, false, "boolean", "function"]);
    });

    it("the network handlers and params work", () => {
        const c = run(`import { tweak } from "tangitweak";\nconst cfg = tweak.params({ on: { type: "boolean", default: true } });\ntweak.onRequest({ url: "*://a.com/*", strategy: "helper" }, () => cfg.on ? { block: true } : undefined);`);
        expect(c.error).toBeNull();
        expect(c.paramDefs?.on).toMatchObject({ type: "boolean", default: true });
        expect(c.meta.routes.map((r) => [r.kind, r.url])).toEqual([["onRequest", ["*://a.com/*"]]]);
    });

    it("globalStore IDs: file-name safe, unique", () => {
        for (const id of ["Seen", "a b", ".hidden", "x/y", ""]) expect(run(`import { tweak } from "tangitweak";\ntweak.globalStore(${JSON.stringify(id)}, {});`).error).toContain(`tweak.globalStore(${JSON.stringify(id)})`);
        expect(run(`import { tweak } from "tangitweak";\ntweak.globalStore("seen-items.v2_x", {});`).error).toBeNull();
        expect(run(`import { tweak } from "tangitweak";\ntweak.globalStore("s", {});\ntweak.globalStore("s", {});`).error).toMatch(/tweak\.globalStore\("s"\)/);
    });

    it("a store ID is unique across a tweak's files", () => {
        const scripts = [{ id: "a", name: "t/a", code: `import { tweak } from "tangitweak";\nexport const s = tweak.globalStore("x", {});` }];
        const compile = (code: string) => compileScript(code, { name: "t/index", importModule: makeModuleResolver(scripts, () => ({})).resolveFrom("t/index") });
        expect(compile(`import { tweak } from "tangitweak";\nimport { s } from "./a";\nvoid s;\ntweak.globalStore("x", {});`).error).toMatch(/tweak\.globalStore\("x"\): a store ID is used once per tweak — "t\/a" already declares it/);
        expect(compile(`import { tweak } from "tangitweak";\nimport { s } from "./a";\nvoid s;\ntweak.globalStore("y", {});`).error).toBeNull();
    });

    it("its messages say tweak", () => {
        const c = run(`import { tweak } from "tangitweak";\ntweak.onPage(42 as any, () => {});`);
        expect(c.error).toContain("tweak.onPage");
    });

    it("the removed `tt` global: a clear error, at load and in a handler, in the background and the page", () => {
        const c = run(`tt.onPage("*", () => {});`);
        expect(c.error).toContain("ReferenceError: tt is not defined");
        expect(c.error).toContain(TT_REMOVED);
        expect(c.meta.active).toBe(false);
        const late = run(`import { tweak } from "tangitweak";\ntweak.onRequest({ url: "*://a.com/*", strategy: "helper" }, () => tt.log(1));`);
        expect(late.error).toBeNull();
        let thrown: unknown;
        try {
            late.handlers.onRequest[0].fn({} as any);
        } catch (e) {
            thrown = e;
        }
        expect(formatScriptError("main", thrown)).toContain(TT_REMOVED);
        const shim = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated" });
        const m = { exports: {} };
        expect(() => shim.top(() => scriptFunction(toRunnableJs(`const cfg = tt.params({});`), "main")(shim.host, console, () => ({}), m, m.exports))).toThrow(TT_REMOVED);
    });

    it("each importing file gets its own tweak", () => {
        const scripts = [{ id: "a", name: "a", code: `import { tweak } from "tangitweak";\nexport const t = tweak;` }];
        const c = compileScript(`import { tweak } from "tangitweak";\nimport { t } from "./a";\nexport const same = t === tweak;`, { name: "main", importModule: makeModuleResolver(scripts, () => ({})).resolveFrom("main") });
        expect(c.error).toBeNull();
        expect(c.exports.same).toBe(false);
    });

    it("is never a package: no download, no typings to fetch; only a tweak's files import it", () => {
        const code = `import { tweak } from "tangitweak";`;
        expect(packageUrls(code)).toEqual([]);
        expect(badPackageImports(code)).toEqual([]);
        expect(needsBuiltinTypings([code])).toBe(false);
        expect(() => builtinModule("tangitweak")).toThrow(/tweak's own files/);
    });
});

describe("tweak: the source analyzers", () => {
    const code = [
        `import { tweak } from "tangitweak";`,
        `const ps = tweak.pageStore({ hits: 0 });`,
        `const g = tweak.globalStore("g", { n: 0 }, { persist: false });`,
        `const site = tweak.siteStore({ a: 1 });`,
        `tweak.onSite("*", () => { document.title = String(ps.hits + g.n); });`,
        `tweak.onRequest({ url: "*://a.com/*", strategy: "rules" }, () => { tweak.log("x"); return undefined; });`,
        `tweak.onRequest({ url: "*://b.com/*", strategy: "helper" }, () => { site.a++; return undefined; });`,
    ].join("\n");

    it("onSite uses, rules side effects and siteStore in network handlers", () => {
        expect(onSiteUses(code)).toEqual([{ nth: 0, pageStore: ["ps"], globalStore: ["g"], handles: [] }]);
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const site = siteProblems(code, c.meta.routes);
        expect(site.some((m) => m.startsWith("onSite #1: uses `ps`, `g`"))).toBe(true);
        expect(site.some((m) => m.startsWith("onRequest #2: uses `site`"))).toBe(true);
        expect(rulesProblems(code, c.meta.routes)).toEqual([expect.stringContaining("`tweak.log` runs once")]);
    });

    it("an alias of the import counts too", () => {
        const aliased = `import { tweak as t } from "tangitweak";\nconst ps = t.pageStore({});\nt.onSite("*", () => ps);`;
        expect(onSiteUses(aliased)).toEqual([{ nth: 0, pageStore: ["ps"], globalStore: [], handles: [] }]);
    });

    it("quick fixes: onSite → onPage, or the stores become siteStores (a globalStore loses its ID and options)", () => {
        const at = code.indexOf("tweak.onSite") + 10;
        expect(onPageEdit(code, at)).toMatchObject({ text: "onPage" });
        let fixed = code;
        for (const e of siteStoreEdits(code, at).reverse()) fixed = fixed.slice(0, e.start) + e.text + fixed.slice(e.end);
        expect(fixed).toContain(`const ps = tweak.siteStore({ hits: 0 });`);
        expect(fixed).toContain(`const g = tweak.siteStore({ n: 0 });`);
    });
});
