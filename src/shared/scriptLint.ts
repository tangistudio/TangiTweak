/**
 * scriptLint: static checks on a script, before it runs. One `sucrase` →
 * `acorn` → `eslint-scope` pass (scopes resolved, so a local that shadows a
 * store isn't one, and top-level helpers a handler calls count as its code):
 *
 * - `no-invalid-world-access`: onSite handlers using stores or handles,
 *   network handlers using `tweak.siteStore`;
 * - `no-rules-side-effects`: per-request-looking code (logging, fetch,
 *   timers, store writes) in `strategy: "rules"` handlers;
 * - `valid-selectors-and-shortcuts`: static CSS selectors of `ctx.elements`
 *   / `ctx.mount` / `ctx.iframes` / `ctx.shortcut({ iframes })` and static
 *   `ctx.shortcut` keys; a `shadow: true` selector that looks like it spans
 *   a shadow host.
 *
 * Registrations made by helpers during setup are fine (pageShim), so there
 * is no "top-level registrations only" rule. Sucrase keeps lines but not
 * columns: diagnostics are per line. Lint only sees what is written
 * statically; the runtime checks stay.
 *
 * `scriptLintCore` is self-contained (no outer references): the ESLint
 * plugin written to synced folders embeds its source (generatedFiles).
 */
import { parse } from "acorn";
import { analyze } from "eslint-scope";
import { transform } from "sucrase";
import { NO_SITE_STORE, SITE_NO_HANDLES, SITE_NO_STORES } from "./remote";
import { parseShortcut } from "./shortcut";

export type LintRule = "no-invalid-world-access" | "no-rules-side-effects" | "valid-selectors-and-shortcuts";
export type LintSeverity = "error" | "warning";

export interface LintDiagnostic {
    rule: LintRule;
    severity: LintSeverity;
    /** 1-based line (of the script's source: sucrase keeps lines) */
    line: number;
    message: string;
    /** the AST node it is about (the ESLint plugin reports there) */
    node?: unknown;
}

export interface LintEnv {
    SITE_NO_STORES: string;
    SITE_NO_HANDLES: string;
    NO_SITE_STORE: string;
    /** why `keys` isn't a shortcut, or null */
    shortcutProblem(keys: string): string | null;
    /** a stricter selector check than the built-in one (the DOM's), or null */
    selectorProblem?: (selector: string) => string | null;
}

type StoreKind = "pageStore" | "tabStore" | "globalStore";
interface Use {
    name: string;
    line: number;
    node: unknown;
}
export interface SiteAnalysis {
    /** 0-based: which `tweak.onSite(` call of the source it is */
    nth: number;
    line: number;
    pageStore: Use[];
    tabStore: Use[];
    globalStore: Use[];
    handles: Use[];
}
export interface NetAnalysis {
    api: string;
    /** 0-based, per api */
    nth: number;
    line: number;
    /** `strategy` when written as a literal in the route object */
    strategy?: string;
    siteStores: Use[];
    effects: { text: string; does: string; line: number; node: unknown }[];
}
export interface LintAnalysis {
    sites: SiteAnalysis[];
    nets: NetAnalysis[];
    checks: LintDiagnostic[];
}

/** The rules over an ESTree AST and its eslint-scope ScopeManager. Self-contained: embedded in the ESLint plugin. */
export function scriptLintCore(env: LintEnv) {
    const NET = ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"];
    const STORES = ["pageStore", "tabStore", "globalStore"];
    const HANDLES = ["onSite", "onPage", "onOverlay"];
    const CONSOLE = ["log", "info", "warn", "error", "debug", "trace", "table", "dir"];
    const DOM_CALLS = ["elements", "mount", "iframes", "shortcut"];
    const SKIP = new Set(["parent", "loc", "range", "start", "end", "leadingComments", "trailingComments", "comments", "tokens"]);
    const range = (n: any): [number, number] => n.range || [n.start, n.end];
    const lineOf = (n: any): number => n.loc.start.line;
    const inside = (n: any, r: [number, number]) => range(n)[0] >= r[0] && range(n)[1] <= r[1];
    const unwrap = (n: any): any => {
        while (n && /^(TSAsExpression|TSNonNullExpression|TSSatisfiesExpression|TSTypeAssertion|TSInstantiationExpression|ParenthesizedExpression|ChainExpression)$/.test(n.type)) n = n.expression;
        return n;
    };
    function walk(node: any, fn: (n: any) => void): void {
        fn(node);
        for (const k in node) {
            if (SKIP.has(k)) continue;
            const v = node[k];
            if (Array.isArray(v)) {
                for (const c of v) if (c && typeof c.type === "string") walk(c, fn);
            } else if (v && typeof v.type === "string") walk(v, fn);
        }
    }

    function rulesMessage(label: string, text: string, does: string): string {
        return `${label}: \`${text}\` runs once, when scripts load — not for each request: on strategy "rules" the handler only computes a fixed rule that the browser then applies by itself. To ${does}, use a per-request strategy ("extension", "debugger" or "helper")`;
    }

    /** blank what's inside quotes, () and [] (same length), so only the top level is left */
    function topLevel(sel: string): string {
        let out = "";
        let depth = 0;
        let q = "";
        for (let i = 0; i < sel.length; i++) {
            const c = sel[i];
            if (q) {
                if (c === "\\") {
                    out += sel[i + 1] === undefined ? "_" : "__";
                    i++;
                } else if (c === q) {
                    q = "";
                    out += c;
                } else out += "_";
                continue;
            }
            if (c === "\\") {
                out += depth ? (sel[i + 1] === undefined ? "_" : "__") : sel.slice(i, i + 2);
                i++;
                continue;
            }
            if (c === '"' || c === "'") {
                q = c;
                out += c;
            } else if (c === "(" || c === "[") {
                out += depth ? "_" : c;
                depth++;
            } else if (c === ")" || c === "]") {
                depth--;
                out += depth ? "_" : c;
            } else out += depth ? "_" : c;
        }
        return out;
    }

    function selectorProblem(sel: string): string | null {
        if (!sel.trim()) return "is empty";
        const stack: string[] = [];
        let q = "";
        for (let i = 0; i < sel.length; i++) {
            const c = sel[i];
            if (q) {
                if (c === "\\") i++;
                else if (c === q) q = "";
                continue;
            }
            if (c === "\\") i++;
            else if (c === '"' || c === "'") q = c;
            else if (c === "(" || c === "[") stack.push(c);
            else if (c === ")" || c === "]") {
                if (stack.pop() !== (c === ")" ? "(" : "[")) return `has an unmatched "${c}"`;
            }
        }
        if (q) return "has an unclosed string";
        if (stack.length) return `has an unclosed "${stack.pop()}"`;
        for (const part of topLevel(sel).split(",")) {
            const t = part.trim();
            if (!t) return "has an empty selector in its list (a stray comma)";
            if (/^[>+~]/.test(t)) return `starts with the combinator "${t[0]}"`;
            if (/[>+~]$/.test(t)) return `ends with the combinator "${t[t.length - 1]}"`;
            if (/[>+~]\s*[>+~]/.test(t)) return "has two combinators in a row";
            if (/[.#](?![\w\-\\\u00a0-\uffff])/.test(t)) return `has a "." or "#" without a name`;
            if (/#-?\d/.test(t)) return "has an ID that starts with a digit (escape it, or use [id=\"…\"])";
        }
        return env.selectorProblem ? env.selectorProblem(sel) : null;
    }

    /** `"app-shell .toolbar"` with `shadow: true`: the part after a custom element's descendant/child combinator, or null */
    function spansHost(sel: string): { host: string; inner: string } | null {
        const top = topLevel(sel);
        let at = 0;
        for (const part of top.split(",")) {
            const m = /(^|[\s>+~])([a-z][a-z0-9]*-[\w-]*)[^\s>+~]*\s*(?:>|\s)\s*(?=\S)/i.exec(part);
            if (m) {
                const end = at + m.index + m[0].length;
                const inner = sel.slice(end, at + part.length).trim();
                return { host: m[2].toLowerCase(), inner };
            }
            at += part.length + 1;
        }
        return null;
    }

    function analyzeAst(ast: any, scopeManager: any): LintAnalysis {
        const refs = new Map<any, any>();
        for (const s of scopeManager.scopes) for (const r of s.references) refs.set(r.identifier, r);
        const isGlobal = (id: any) => {
            const r = refs.get(id);
            return !r || !r.resolved || r.resolved.defs.length === 0;
        };
        /** `tweak` as imported from "tangitweak" (or under an alias: `{ tweak as t }`), or an undeclared `tweak` */
        const isApi = (id: any): boolean => {
            if (id?.type !== "Identifier") return false;
            const v = refs.get(id)?.resolved;
            if (!v || v.defs.length === 0) return id.name === "tweak";
            const d = v.defs[0];
            if (d.type !== "ImportBinding" || d.node.type !== "ImportSpecifier" || d.parent?.source?.value !== "tangitweak") return false;
            const imported = d.node.imported;
            return (imported.type === "Identifier" ? imported.name : imported.value) === "tweak";
        };
        const apiMember = (n: any): string | null => {
            n = unwrap(n);
            return n && n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" && isApi(n.object) ? n.property.name : null;
        };
        const apiCall = (n: any): string | null => {
            n = unwrap(n);
            return n && n.type === "CallExpression" ? apiMember(n.callee) : null;
        };
        const varOf = (id: any) => refs.get(id)?.resolved ?? null;

        /** the top-level-ish variables bound to `tweak.<store>(…)` / `tweak.siteStore(…)` / a handle */
        const bound = new Map<any, { kind: string; name: string; at: number }>();
        const calls: any[] = [];
        walk(ast, (n) => {
            if (n.type === "CallExpression") calls.push(n);
            if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier" || !n.init) return;
            const api = apiMember(n.init) ?? apiCall(n.init);
            if (!api) return;
            const kind = STORES.includes(api) || api === "siteStore" ? api : HANDLES.includes(api) ? "handles" : null;
            if (!kind) return;
            const v = scopeManager.getDeclaredVariables(n).find((x: any) => x.name === n.id.name);
            if (v) bound.set(v, { kind, name: n.id.name, at: range(n)[0] });
        });
        calls.sort((a, b) => range(a)[0] - range(b)[0]);

        const fnOf = (v: any): any => {
            const d = v?.defs?.[0];
            if (!d) return null;
            if (d.type === "FunctionName") return d.node;
            if (d.type === "Variable") {
                const init = unwrap(d.node.init);
                if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) return init;
            }
            return null;
        };

        /** what a handler's arguments (and the outside functions they reach) use */
        function scan(args: any[]) {
            const uses = new Map<any, { kind: string; name: string; at: number; line: number; node: any }>();
            const direct: { kind: string; name: string; line: number; node: any }[] = [];
            const effects: { text: string; does: string; line: number; node: any; at: number }[] = [];
            if (!args.length) return { uses, direct, effects };
            const top: [number, number] = [range(args[0])[0], range(args[args.length - 1])[1]];
            const seenFns = new Set<any>();
            const seen = new Set<any>();
            const visit = (root: any, via: any) => {
                walk(root, (n) => {
                    const here = via ?? n;
                    if (n.type === "Identifier") {
                        const v = varOf(n);
                        if (!v) return;
                        const b = bound.get(v);
                        if (b) {
                            if (!uses.has(v)) uses.set(v, { ...b, line: lineOf(here), node: here });
                            return;
                        }
                        const fn = fnOf(v);
                        if (fn && !inside(fn, top) && !seenFns.has(fn)) {
                            seenFns.add(fn);
                            visit(fn, here);
                        }
                        return;
                    }
                    if (n.type === "MemberExpression") {
                        const api = apiMember(n);
                        if (api && (STORES.includes(api) || api === "siteStore") && !direct.some((d) => d.kind === api)) direct.push({ kind: api, name: `${unwrap(n).object.name}.${api}`, line: lineOf(here), node: here });
                        return;
                    }
                    if (seen.has(n)) return;
                    let effect: { text: string; does: string } | null = null;
                    if (n.type === "CallExpression") {
                        const callee = unwrap(n.callee);
                        const api = apiMember(callee);
                        if (api === "log") effect = { text: `${callee.object.name}.log`, does: "log each request" };
                        else if (api === "fetch") effect = { text: `${callee.object.name}.fetch`, does: "fetch for each request" };
                        else if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === "console" && isGlobal(callee.object) && CONSOLE.includes(callee.property.name))
                            effect = { text: `console.${callee.property.name}`, does: "log each request" };
                        else if (callee.type === "Identifier" && isGlobal(callee)) {
                            if (callee.name === "fetch") effect = { text: "fetch", does: "fetch for each request" };
                            else if (callee.name === "setTimeout" || callee.name === "setInterval") effect = { text: callee.name, does: "run code for each request" };
                        }
                    } else if (n.type === "AssignmentExpression" || n.type === "UpdateExpression" || (n.type === "UnaryExpression" && n.operator === "delete")) {
                        let target = unwrap(n.type === "AssignmentExpression" ? n.left : n.argument);
                        if (target?.type === "MemberExpression") {
                            while (target.type === "MemberExpression") target = unwrap(target.object);
                            const b = target.type === "Identifier" ? bound.get(varOf(target)) : undefined;
                            if (b && STORES.includes(b.kind)) effect = { text: b.name, does: "update the store for each request" };
                        }
                    }
                    if (effect) {
                        seen.add(n);
                        effects.push({ ...effect, line: lineOf(here), node: here, at: range(here)[0] * 1e7 + range(n)[0] });
                    }
                });
            };
            for (const a of args) visit(a, null);
            effects.sort((a, b) => a.at - b.at);
            return { uses, direct, effects };
        }

        const staticString = (n: any): string | null => {
            n = unwrap(n);
            if (!n) return null;
            if (n.type === "Literal" && typeof n.value === "string") return n.value;
            if (n.type === "TemplateLiteral" && !n.expressions.length) return n.quasis[0].value.cooked;
            if (n.type === "Identifier") {
                const v = varOf(n);
                const d = v?.defs?.length === 1 ? v.defs[0] : null;
                if (d && d.type === "Variable" && d.parent?.kind === "const" && (v.scope.type === "module" || v.scope.type === "global") && d.node.id.type === "Identifier") {
                    const init = unwrap(d.node.init);
                    if (init?.type === "Literal" && typeof init.value === "string") return init.value;
                    if (init?.type === "TemplateLiteral" && !init.expressions.length) return init.quasis[0].value.cooked;
                }
            }
            return null;
        };
        const prop = (obj: any, name: string): any => {
            obj = unwrap(obj);
            if (obj?.type !== "ObjectExpression") return undefined;
            for (const p of obj.properties) if (p.type === "Property" && !p.computed && ((p.key.type === "Identifier" && p.key.name === name) || (p.key.type === "Literal" && p.key.value === name))) return p.value;
            return undefined;
        };
        const isTrue = (n: any) => unwrap(n)?.type === "Literal" && unwrap(n).value === true;

        const sites: SiteAnalysis[] = [];
        const nets: NetAnalysis[] = [];
        const checks: LintDiagnostic[] = [];
        const perApi: Record<string, number> = {};
        for (const call of calls) {
            const callee = unwrap(call.callee);
            const api = apiMember(callee);
            if (api === "onSite") {
                const { uses, direct } = scan(call.arguments);
                const site: SiteAnalysis = { nth: (perApi.onSite = (perApi.onSite ?? -1) + 1), line: lineOf(call), pageStore: [], tabStore: [], globalStore: [], handles: [] };
                for (const u of [...uses.values()].sort((a, b) => a.at - b.at)) if (u.kind !== "siteStore") (site as any)[u.kind].push({ name: u.name, line: u.line, node: u.node });
                for (const d of direct) if (d.kind !== "siteStore") (site as any)[d.kind].push({ name: d.name, line: d.line, node: d.node });
                sites.push(site);
                continue;
            }
            if (api && NET.includes(api)) {
                const { uses, direct, effects } = scan(call.arguments);
                const strategy = staticString(prop(call.arguments[0], "strategy"));
                const siteStores = [...uses.values()]
                    .filter((u) => u.kind === "siteStore")
                    .sort((a, b) => a.at - b.at)
                    .concat(direct.filter((d) => d.kind === "siteStore") as any)
                    .map((u) => ({ name: u.name, line: u.line, node: u.node }));
                nets.push({ api, nth: (perApi[api] = (perApi[api] ?? -1) + 1), line: lineOf(call), ...(strategy ? { strategy } : {}), siteStores, effects: effects.map(({ at: _at, ...e }) => e) });
                continue;
            }
            if (api || callee?.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier" || isApi(callee.object) || !DOM_CALLS.includes(callee.property.name)) continue;
            const what = `${callee.object.name}.${callee.property.name}`;
            const args = call.arguments;
            const report = (severity: LintSeverity, node: any, message: string) => checks.push({ rule: "valid-selectors-and-shortcuts", severity, line: lineOf(node), message, node });
            const checkSelector = (node: any, shadow: boolean) => {
                const sel = staticString(node);
                if (sel === null) return;
                const why = selectorProblem(sel);
                if (why) return report("error", node, `${what}: "${sel}" isn't a valid CSS selector — it ${why}`);
                const span = shadow ? spansHost(sel) : null;
                if (span)
                    report(
                        "warning",
                        node,
                        `${what}: "${sel}" looks like it reaches into <${span.host}>'s shadow root — with shadow: true a selector is matched inside one root at a time and never spans a shadow boundary, so it can't match there; select the inner element on its own (${JSON.stringify(span.inner)})`
                    );
            };
            const lastObject = () => [...args].reverse().find((a: any) => unwrap(a)?.type === "ObjectExpression");
            const name = callee.property.name;
            if (name === "shortcut") {
                const keys = staticString(args[0]);
                const why = keys === null ? null : env.shortcutProblem(keys);
                if (why) report("error", args[0], why);
                const ifr = prop(args[2], "iframes");
                if (!ifr) continue;
                if (unwrap(ifr).type === "ObjectExpression") {
                    const sel = prop(ifr, "selector");
                    if (sel) checkSelector(sel, isTrue(prop(ifr, "shadow")));
                } else checkSelector(ifr, false);
            } else if (name === "mount") {
                if (args.length >= 2) checkSelector(args[0], isTrue(prop(args[2], "shadow")));
            } else if (args.length) checkSelector(args[0], isTrue(prop(lastObject(), "shadow")));
        }
        return { sites, nets, checks };
    }

    function diagnostics(a: LintAnalysis): LintDiagnostic[] {
        const out: LintDiagnostic[] = [];
        const names = (u: Use[]) => u.map((x) => `\`${x.name}\``).join(", ");
        for (const s of a.sites) {
            const label = `onSite #${s.nth + 1}`;
            const stores = [...s.pageStore, ...s.tabStore, ...s.globalStore];
            if (stores.length) out.push({ rule: "no-invalid-world-access", severity: "error", line: stores[0].line, node: stores[0].node, message: `${label}: uses ${names(stores)} — ${env.SITE_NO_STORES}` });
            if (s.handles.length) out.push({ rule: "no-invalid-world-access", severity: "warning", line: s.handles[0].line, node: s.handles[0].node, message: `${label}: uses ${names(s.handles)} — ${env.SITE_NO_HANDLES}` });
        }
        for (const n of a.nets) {
            const label = `${n.api} #${n.nth + 1}`;
            if (n.siteStores.length) out.push({ rule: "no-invalid-world-access", severity: "error", line: n.siteStores[0].line, node: n.siteStores[0].node, message: `${label}: uses ${names(n.siteStores)} — ${env.NO_SITE_STORE}` });
            if (n.strategy === "rules") for (const e of n.effects) out.push({ rule: "no-rules-side-effects", severity: "warning", line: e.line, node: e.node, message: rulesMessage(label, e.text, e.does) });
        }
        out.push(...a.checks);
        return out.sort((x, y) => x.line - y.line);
    }

    return { analyze: analyzeAst, diagnostics, rulesMessage, selectorProblem };
}

/** a shortcut's keys checked the way `parseShortcut` does, given its named keys (the ESLint plugin's stand-in for it). Self-contained. */
export function shortcutShapeProblem(keys: string, named: string[]): string | null {
    if (!keys.trim()) return 'ctx.shortcut: the keys must be a string like "Alt+Shift+M" or "Mod+K"';
    const mods = ["mod", "ctrl", "control", "alt", "option", "opt", "shift", "meta", "cmd", "command", "super", "win"];
    const parts = keys.trim().split(/\s*\+(?!$)\s*/);
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim();
        if (i < parts.length - 1) {
            if (!mods.includes(p.toLowerCase())) return `ctx.shortcut: "${keys}" has an unknown modifier "${p}" (use Mod, Ctrl, Alt, Shift or Meta)`;
            continue;
        }
        if (!p) return `ctx.shortcut: "${keys}" has no key`;
        if ([...p].length !== 1 && !named.includes(p.toLowerCase())) return `ctx.shortcut: "${keys}" has an unknown key "${p}"`;
    }
    return null;
}

/** the named keys `parseShortcut` takes (for shortcutShapeProblem) */
export function shortcutKeyNames(): string[] {
    const candidates = ["esc", "escape", "enter", "return", "tab", "space", "spacebar", "backspace", "delete", "del", "insert", "ins", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright", "plus"];
    for (let i = 1; i <= 24; i++) candidates.push(`f${i}`);
    return candidates.filter((k) => {
        try {
            parseShortcut(k);
            return true;
        } catch {
            return false;
        }
    });
}

/** the DOM's verdict on a selector, where there is a DOM (the editor) */
function domSelectorProblem(sel: string): string | null {
    const doc = (globalThis as any).document;
    if (!doc?.createDocumentFragment) return null;
    try {
        doc.createDocumentFragment().querySelector(sel);
        return null;
    } catch {
        return "doesn't parse";
    }
}

export const LINT_ENV: LintEnv = {
    SITE_NO_STORES,
    SITE_NO_HANDLES,
    NO_SITE_STORE,
    shortcutProblem(keys) {
        try {
            parseShortcut(keys, false);
            return null;
        } catch (e: any) {
            return String(e?.message || e);
        }
    },
    selectorProblem: domSelectorProblem,
};

const core = scriptLintCore(LINT_ENV);

/** the script as plain JS with its lines kept (types and JSX gone), or null when it doesn't transpile */
function lintJs(code: string): string | null {
    try {
        return transform(code, { transforms: ["typescript", "jsx"], jsxRuntime: "automatic", production: true, disableESTransforms: true }).code;
    } catch {}
    try {
        return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
    } catch {
        return null;
    }
}

function parseJs(js: string): any {
    const opts = { ecmaVersion: "latest", locations: true, ranges: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true } as const;
    try {
        return { ast: parse(js, { ...opts, sourceType: "module" }), sourceType: "module" as const };
    } catch {}
    try {
        return { ast: parse(js, { ...opts, sourceType: "script" }), sourceType: "script" as const };
    } catch {
        return null;
    }
}

const cache = new Map<string, LintAnalysis | null>();
const CACHE_MAX = 32;

/** the script's analysis (cached by source), or null when it doesn't parse (its compile error says why) */
export function analyzeScript(code: string): LintAnalysis | null {
    if (cache.has(code)) {
        const hit = cache.get(code)!;
        cache.delete(code);
        cache.set(code, hit);
        return hit;
    }
    let out: LintAnalysis | null = null;
    const js = lintJs(code);
    const parsed = js === null ? null : parseJs(js);
    if (parsed) {
        try {
            const scopes = analyze(parsed.ast as any, { ecmaVersion: 2022, sourceType: parsed.sourceType, fallback: "iteration" } as any);
            out = core.analyze(parsed.ast, scopes);
        } catch {
            out = null;
        }
    }
    cache.set(code, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return out;
}

/** every lint diagnostic of a script, by line */
export function scriptLint(code: string): LintDiagnostic[] {
    const a = analyzeScript(code);
    return a ? core.diagnostics(a) : [];
}

export const rulesMessage = core.rulesMessage;

/** a selector/shortcut diagnostic as a route warning line (Problems view): "line 12 (error): …" */
export const lintLineWarning = (d: LintDiagnostic): string => `line ${d.line} (${d.severity}): ${d.message}`;
