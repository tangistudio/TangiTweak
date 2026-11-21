// A tweak's modules run with its `tweak`: what a module registers — at its
// own top level, or in an exported function the entry calls — is the
// entry's, keyed in run order, the same in the background and the page.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, makeModuleResolver, siteProblems, toRunnableJs } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { makeLibRequire } from "../src/shared/scriptImports";
import { scriptFunction } from "../src/shared/scriptFn";
import { routeLabel } from "../src/shared/route";

const A = `import { tweak } from "tangitweak"; export function install(p: string) { tweak.onPage(p, () => "a1"); return tweak.onPage(p, () => "a2"); }\ntweak.onPage("*", () => "a-own");`;
const B = `import { tweak } from "tangitweak"; export const install = () => tweak.onPage("*", () => "b");\nexport const site = () => tweak.onSite("*", () => "s");`;
const ROOT = `import { tweak } from "tangitweak"; import { install as a } from "./a";\nimport { install as b, site } from "./b";\na("*");\ntweak.onPage("*", () => "root");\nb();\nsite();\na("*");`;
// a's own top level runs first (on import), then the entry's calls in order
const KEYS = ["onPage:0", "onPage:1", "onPage:2", "onPage:3", "onPage:4", "onSite:0", "onPage:5", "onPage:6"];

const base = { params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined } };

/** as the page worlds run a tweak: its modules with the entry's shim */
function pageRun(world: "isolated" | "page", code = ROOT) {
    const libs = [
        { name: "t/a", src: toRunnableJs(A) },
        { name: "t/b", src: toRunnableJs(B) },
    ];
    const shim = makePageShim({ ...base, world });
    const requireFrom = makeLibRequire(libs, (lib, require, m) => scriptFunction(lib.src!, lib.name)(shim.host, console, require, m, m.exports));
    const m = { exports: {} as any };
    shim.top(() => scriptFunction(toRunnableJs(code), "t/index")(shim.host, console, requireFrom("t/index"), m, m.exports));
    return { shim, requireFrom };
}

const scripts = [
    { id: "a", name: "t/a", code: A },
    { id: "b", name: "t/b", code: B },
];

describe("a module's registrations belong to the entry", () => {
    it("background: the entry's routes, keyed in run order", () => {
        const c = compileScript(ROOT, { name: "t/index", importModule: makeModuleResolver(scripts, () => ({})).resolveFrom("t/index") });
        expect(c.error).toBeNull();
        expect(c.meta.routes.filter((r) => r.key).map((r) => r.key)).toEqual(KEYS);
        expect(c.meta.routes.every((r) => r.lib === undefined)).toBe(true);
        expect(c.meta.routes.map((r) => r.file)).toEqual(["t/a", "t/a", "t/a", undefined, "t/b", "t/b", "t/a", "t/a"]);
        expect(routeLabel(c.meta.routes.find((r) => r.key === "onPage:1")!)).toBe("onPage #2");
    });

    it("page (onPage): the same handlers, with the background's keys", () => {
        const { shim } = pageRun("isolated");
        expect(shim.dom.map((d) => [d.h, d.fn({})])).toEqual([
            ["onPage:0", "a-own"],
            ["onPage:1", "a1"],
            ["onPage:2", "a2"],
            ["onPage:3", "root"],
            ["onPage:4", "b"],
            ["onPage:5", "a1"],
            ["onPage:6", "a2"],
        ]);
    });

    it("page (onSite): the site's world gets the module's onSite handler", () => {
        expect(pageRun("page").shim.dom.map((d) => [d.h, d.fn({})])).toEqual([["onSite:0", "s"]]);
    });

    it("onSite warnings check the entry's own calls only", () => {
        const code = `import { tweak } from "tangitweak"; import { site } from "./b";\nconst ps = tweak.pageStore({});\nsite();\ntweak.onSite("*", () => ps);`;
        const c = compileScript(code, { name: "t/index", importModule: makeModuleResolver(scripts.slice(1), () => ({})).resolveFrom("t/index") });
        expect(c.error).toBeNull();
        expect(siteProblems(code, c.meta.routes).map((m) => m.slice(0, m.indexOf(":")))).toEqual(["onSite #2"]);
    });
});
