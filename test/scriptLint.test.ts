import { parse } from "acorn";
import { analyze } from "eslint-scope";
import { describe, expect, it } from "vitest";
import { compileScript, rulesProblems, siteProblems } from "../src/shared/compile";
import { eslintPluginText } from "../src/shared/generatedFiles";
import { NO_SITE_STORE, SITE_NO_STORES } from "../src/shared/remote";
import { scriptLint } from "../src/shared/scriptLint";
import { collectProblems, type ProblemMarker } from "../src/ui/problems";

const rules = (code: string, rule?: string) => scriptLint(code).filter((d) => !rule || d.rule === rule);

describe("no-invalid-world-access", () => {
    it("follows outside helpers a handler calls, and ignores a local that shadows a store", () => {
        const code = [
            `import { tweak } from "tangitweak"; const g = tweak.globalStore("g", { n: 0 });`,
            `function bump() { g.n++; }`,
            `tweak.onSite("*", () => { bump(); });`,
            `tweak.onSite("*", () => { const g = { n: 1 }; g.n++; });`,
        ].join("\n");
        const d = rules(code, "no-invalid-world-access");
        expect(d).toHaveLength(1);
        expect(d[0]).toMatchObject({ severity: "error", line: 3, message: `onSite #1: uses \`g\` — ${SITE_NO_STORES}` });
        const c = compileScript(code);
        expect(siteProblems(code, c.meta.routes)).toEqual([`onSite #1: uses \`g\` — ${SITE_NO_STORES}`]);
    });

    it("flags tweak.siteStore in a network handler, through a helper", () => {
        const code = `const s = tweak.siteStore({});\nconst read = () => s.x;\ntweak.onRequest({ url: "*://a/*" }, () => { read(); });`;
        expect(rules(code, "no-invalid-world-access").map((d) => d.message)).toEqual([`onRequest #1: uses \`s\` — ${NO_SITE_STORE}`]);
    });

    it("follows the imported tweak API under an alias, and ignores a local named tweak", () => {
        const code = [
            `import { tweak as t } from "tangitweak";`,
            `const g = t.globalStore("g", { n: 0 });`,
            `t.onSite("*", () => { g.n++; });`,
            `function f(tweak) { const p = tweak.pageStore({}); tweak.onSite("*", () => { p.x = 1; }); }`,
        ].join("\n");
        expect(rules(code, "no-invalid-world-access").map((d) => d.line)).toEqual([3]);
    });
});

describe("no-rules-side-effects", () => {
    it("flags side effects reached through a helper, only on a literal rules strategy", () => {
        const code = [
            `import { tweak } from "tangitweak"; const log = (m) => console.log(m);`,
            `tweak.onRequest({ url: "*://a/*", strategy: "rules" }, () => { log("x"); return { block: true }; });`,
            `tweak.onRequest({ url: "*://b/*", strategy: "extension" }, () => { log("y"); });`,
            `tweak.onRequest({ url: "*://c/*", strategy: "rules" }, () => { const console = { log() {} }; console.log(1); return {}; });`,
        ].join("\n");
        const d = rules(code, "no-rules-side-effects");
        expect(d.map((x) => [x.line, x.message.slice(0, x.message.indexOf(" runs"))])).toEqual([[2, "onRequest #1: `console.log`"]]);
        const routes = compileScript(code).meta.routes;
        expect(rulesProblems(code, routes)).toHaveLength(1);
    });
});

describe("valid-selectors-and-shortcuts", () => {
    const run = (body: string) => rules(`tweak.onPage("*", (ctx) => {\n${body}\n});`, "valid-selectors-and-shortcuts");

    it("flags invalid static selectors, resolving top-level consts", () => {
        expect(run(`ctx.elements("div > ", () => {});`)[0]).toMatchObject({ severity: "error", line: 2 });
        expect(run(`ctx.mount("a[href", () => null);`)[0]?.message).toMatch(/unclosed "\["/);
        expect(rules(`const SEL = ".a,,.b";\ntweak.onPage("*", (ctx) => { ctx.iframes(SEL, () => {}); });`)[0]).toMatchObject({ line: 2, severity: "error" });
        expect(run(`ctx.elements("main .card > a[href^='x,y']", () => {});\nctx.elements(pick(), () => {});`)).toEqual([]);
    });

    it("warns when a shadow: true selector expects to cross a shadow boundary", () => {
        const [w] = run(`ctx.elements("app-shell .toolbar button", () => {}, { shadow: true });`);
        expect(w).toMatchObject({ severity: "warning", line: 2 });
        expect(w.message).toContain("<app-shell>");
        expect(w.message).toContain(`".toolbar button"`);
        expect(run(`ctx.elements("app-shell .toolbar button", () => {});`)).toEqual([]);
        expect(run(`ctx.shortcut("Alt+K", () => {}, { iframes: { selector: "x-frame iframe", shadow: true } });`)[0]?.severity).toBe("warning");
    });

    it("flags invalid static shortcut keys", () => {
        expect(run(`ctx.shortcut("Hyper+K", () => {});`)[0]).toMatchObject({ severity: "error", line: 2 });
        expect(run(`ctx.shortcut("Mod+Shift+K", () => {});\nctx.shortcut(keys, () => {});`)).toEqual([]);
    });

    it("reaches the Problems view as line warnings, listed once when the editor marks it live", () => {
        const code = `tweak.onPage("*", (ctx) => {\n    ctx.elements("div >", () => {});\n});`;
        const routeWarnings = siteProblems(code, compileScript(code).meta.routes);
        expect(routeWarnings).toEqual([expect.stringMatching(/^line 2 \(error\): ctx\.elements: "div >"/)]);
        const script = { id: "a", label: "a.ts", error: null, code, routeWarnings };
        const [g] = collectProblems([script], new Map<string, ProblemMarker[]>());
        expect(g.problems.map((p) => [p.severity, p.line, p.column])).toEqual([["error", 2, 5]]);
        const live = [{ severity: "error" as const, message: routeWarnings[0].replace(/^line 2 \(error\): /, ""), line: 2, column: 5 }];
        const [g2] = collectProblems([script], new Map([["a", live]]));
        expect(g2.problems).toHaveLength(1);
    });
});

describe("ESLint plugin (.tangitweak/eslint-plugin.mjs)", () => {
    it("runs the same rules in ESLint's rule format", () => {
        const plugin = new Function(eslintPluginText().replace(/^export default plugin;$/m, "return plugin;"))();
        expect(Object.keys(plugin.rules)).toEqual(["no-invalid-world-access", "no-rules-side-effects", "valid-selectors-and-shortcuts", "valid-package-imports"]);
        expect(plugin.configs.recommended.rules["tangitweak/no-rules-side-effects"]).toBe("warn");
        const code = [
            `const g = tweak.globalStore("g", {});`,
            `tweak.onSite("*", () => { g.n = 1; });`,
            `tweak.onPage("*", (ctx) => { ctx.shortcut("Hyper+K", () => {}); });`,
            `import a from "https://unpkg.com/lodash";`,
            `import b from "https://esm.sh/valtio@2";`,
            `import c from "https://unpkg.com/dayjs@1.11.10";`,
            `const d = import("https://cdn.example.com/x.js");`,
        ].join("\n");
        const ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true, ranges: true });
        const sourceCode = { ast, scopeManager: analyze(ast as any, { ecmaVersion: 2022, sourceType: "module" }) };
        const reports: [string, number][] = [];
        for (const [name, rule] of Object.entries<any>(plugin.rules)) {
            const context = { sourceCode, report: (r: any) => reports.push([name, r.node?.loc.start.line ?? r.loc.line]) };
            const visit = rule.create(context);
            // the import rule's visitors, by hand (no ESLint traversal here)
            for (const n of (ast as any).body) {
                visit[n.type]?.(n);
                if (n.type === "VariableDeclaration") visit.ImportExpression?.(n.declarations[0].init);
            }
            visit["Program:exit"]?.();
        }
        expect(reports).toEqual([
            ["no-invalid-world-access", 2],
            ["valid-selectors-and-shortcuts", 3],
            ["valid-package-imports", 4],
            ["valid-package-imports", 7],
        ]);
    });
});
