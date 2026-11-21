/**
 * The test loader's request walk (plan §6.6): a request goes through the
 * strategies as layers, in the browser's order (precedence.ts LAYERS), each
 * seeing it only if that browser would let it. `rules` applies the fixed
 * browser rules the handlers were probed into, without calling them. The
 * first block, redirect or replacement stops the request; the layers in
 * front then run their response handlers. Everything a handler didn't get
 * to run for is listed with the extension's own words.
 */
import { bodyKind } from "../shared/bodyKind";
import { resolveFileRef, runOp, type OpEnv, type OpScript } from "../shared/bodyOps";
import { debuggerMissedLine, isLoopbackUrl, MISSED_REASONS, routeProblem } from "../shared/missedTap";
import { LAYERS, skippedBy, skipReason, winnerOf, type RouteRef, type Winner } from "../shared/precedence";
import { routeLabel, routeMatches, type RouteMeta, type Strategy } from "../shared/route";
import { substitute, type RuleSpec } from "../shared/dnrRules";
import type { Routed } from "../shared/compile";
import { NET_KINDS } from "../shared/route";

export type BrowserName = "chrome" | "chromium-mv2" | "firefox";

export const BROWSER_ENV: Record<BrowserName, { firefox: boolean; mv3: boolean }> = {
    chrome: { firefox: false, mv3: true },
    "chromium-mv2": { firefox: false, mv3: false },
    firefox: { firefox: true, mv3: false },
};

/** a handler that didn't run for a request, and why */
export interface SkippedHandler {
    /** `onResponseBody #1` */
    handler: string;
    strategy: Strategy;
    script: string;
    why: string;
}

/** the handler whose block, redirect or replacement ended the request */
export interface DecidedBy {
    strategy: Strategy;
    handler: string;
    script: string;
    outcome: "replace" | "block" | "redirect";
}

/** a script's probed `rules` handler, as Chrome took it */
export interface RuleGroupRef {
    scriptId: string;
    scriptName: string;
    route: RouteMeta;
    specs: RuleSpec[];
}

/** `resourceType` as tests write it → the webRequest type */
export function webRequestType(t: string | undefined): string {
    if (!t || t === "fetch" || t === "xhr") return "xmlhttprequest";
    if (t === "document") return "main_frame";
    if (t === "iframe") return "sub_frame";
    return t;
}

/**
 * A tweak's handlers as `browser` runs them: the routes it turns off (with
 * the Problems view's text) and the ones left. On Chromium MV2 an
 * `extension` handler's async result is ignored (blocking webRequest can't
 * wait for it).
 */
export function layerScripts(
    scripts: OpScript[],
    browser: BrowserName,
    onAsync: (s: OpScript, route: RouteMeta) => void
): { scripts: OpScript[]; refs: RouteRef[]; disabled: { ref: RouteRef; why: string }[] } {
    const env = { ...BROWSER_ENV[browser], dnr: true };
    const refs: RouteRef[] = [];
    const disabled: { ref: RouteRef; why: string }[] = [];
    const out = scripts.map((s, order) => {
        const handlers: any = { ...s.handlers };
        for (const kind of NET_KINDS) {
            handlers[kind] = ((s.handlers as any)[kind] as Routed[]).flatMap((h) => {
                const ref: RouteRef = { scriptId: s.id, scriptName: s.name, order, route: h.route, strategy: h.route.strategy! };
                const why = routeProblem({ kind: h.route.kind, strategy: ref.strategy, resourceTypes: h.route.resourceTypes }, env);
                if (why) {
                    disabled.push({ ref, why });
                    return [];
                }
                refs.push(ref);
                if (browser !== "chromium-mv2" || ref.strategy !== "extension") return [h];
                const fn = (...args: any[]) => {
                    const r = (h.fn as any)(...args);
                    if (!r || typeof r.then !== "function") return r;
                    r.then(undefined, () => {});
                    onAsync(s, h.route);
                    return undefined;
                };
                return [{ ...h, fn }];
            });
        }
        return { ...s, handlers };
    });
    return { scripts: out, refs, disabled };
}

export interface LayerRequest {
    url: string;
    method: string;
    tabId: number;
    page: string;
    tabUrl: string;
    /** the webRequest type */
    resourceType: string;
    requestHeaders: Record<string, string>;
    requestBody?: unknown;
    /** a document request in a tab that had none before (the debugger may miss it) */
    firstDocument?: boolean;
}

export interface UpstreamAnswer {
    status: number;
    headers: Record<string, string>;
    body: string | Uint8Array;
}

export interface LayerEnv {
    browser: BrowserName;
    scripts: OpScript[];
    refs: RouteRef[];
    disabled: { ref: RouteRef; why: string }[];
    rules: RuleGroupRef[];
    opEnv: OpEnv;
    upstream(requestHeaders: Record<string, string>): Promise<UpstreamAnswer>;
}

export interface LayerResult extends UpstreamAnswer {
    action: "passthrough" | "modified" | "replaced" | "redirected" | "blocked";
    redirectedTo: string | null;
    requestHeaders: Record<string, string>;
    skipped: SkippedHandler[];
    decidedBy: DecidedBy | null;
}

function specMatches(spec: RuleSpec, req: LayerRequest): boolean {
    const c = spec.condition || {};
    if (typeof c.regexFilter === "string" && !new RegExp(c.regexFilter).test(req.url)) return false;
    if (c.resourceTypes && !c.resourceTypes.includes(req.resourceType)) return false;
    if (c.requestMethods && !c.requestMethods.includes(req.method.toLowerCase())) return false;
    if (c.tabIds && !c.tabIds.includes(req.tabId)) return false;
    if (c.excludedTabIds && c.excludedTabIds.includes(req.tabId)) return false;
    return true;
}

/** apply declarativeNetRequest header ops */
function applyOps(headers: Record<string, string>, ops: any[] | undefined): boolean {
    let changed = false;
    for (const o of ops || []) {
        const k = String(o.header).toLowerCase();
        if (o.operation === "remove") {
            if (k in headers) changed = true;
            delete headers[k];
        } else if (o.operation === "append" && k in headers) {
            headers[k] = `${headers[k]}, ${o.value}`;
            changed = true;
        } else {
            headers[k] = String(o.value);
            changed = true;
        }
    }
    return changed;
}

function applyEdits(headers: Record<string, string>, edits: { set?: Record<string, string>; remove?: string[] } | null | undefined): boolean {
    if (!edits) return false;
    let changed = false;
    for (const r of edits.remove || []) {
        const k = String(r).toLowerCase();
        if (k in headers) changed = true;
        delete headers[k];
    }
    for (const [k, v] of Object.entries(edits.set || {})) {
        headers[k.toLowerCase()] = String(v);
        changed = true;
    }
    return changed;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** walk `req` through the layers (see the top of this file) */
export async function requestThroughLayers(env: LayerEnv, req: LayerRequest): Promise<LayerResult> {
    const { url, method, resourceType: type } = req;
    const mv3 = env.browser === "chrome";
    const skipped: SkippedHandler[] = [];
    const seen = new Set<string>();
    const skip = (r: RouteRef, why: string) => {
        const key = `${r.scriptId}|${r.route.kind}|${r.route.index}`;
        if (seen.has(key)) return;
        seen.add(key);
        skipped.push({ handler: routeLabel(r.route), strategy: r.strategy, script: r.scriptName, why });
    };
    const matches = (r: RouteRef) => routeMatches(r.route, url, method, type);
    for (const d of env.disabled) if (matches(d.ref)) skip(d.ref, d.why);

    const requestHeaders = { ...req.requestHeaders };
    let reqModified = false;
    let winner: Winner | null = null;
    let route: RouteMeta | undefined;
    let replaced: UpstreamAnswer | null = null;
    const reached: Strategy[] = [];
    const responseRules: any[] = [];
    const base = { url, method, tabId: req.tabId, page: req.page, tabUrl: req.tabUrl, resourceType: type, requestBody: req.requestBody };

    layers: for (const layer of LAYERS) {
        const mine = env.refs.filter((r) => r.strategy === layer && matches(r));
        if (layer === "rules") {
            reached.push(layer);
            const ops: any[] = [];
            for (const g of env.rules) {
                for (const spec of g.specs) {
                    if (!specMatches(spec, req)) continue;
                    const a = spec.action || {};
                    if (a.type === "modifyHeaders") {
                        ops.push(...(a.requestHeaders || []));
                        responseRules.push(...(a.responseHeaders || []));
                        continue;
                    }
                    if (a.type !== "block" && a.type !== "redirect") continue;
                    const who = { scriptId: g.scriptId, scriptName: g.scriptName, kind: g.route.kind as any, index: g.route.index };
                    route = g.route;
                    if (a.type === "block") winner = { ...who, strategy: "rules", outcome: "block" };
                    else {
                        const target = a.redirect?.url ?? substitute(spec.condition.regexFilter, a.redirect?.regexSubstitution ?? "", url) ?? url;
                        if (target.startsWith("data:")) {
                            const f = resolveFileRef(target, url);
                            replaced = { status: 200, headers: { "content-type": f.mime }, body: f.content };
                            winner = { ...who, strategy: "rules", outcome: "replace" };
                        } else winner = { ...who, strategy: "rules", outcome: "redirect", target };
                    }
                    break layers;
                }
            }
            if (applyOps(requestHeaders, ops)) reqModified = true;
            continue;
        }
        if (layer === "page" && type !== "xmlhttprequest") {
            for (const r of mine) skip(r, MISSED_REASONS.hookNotFetch);
            continue;
        }
        if (layer === "helper" && isLoopbackUrl(url)) {
            for (const r of mine) skip(r, MISSED_REASONS.helperLoopback);
            continue;
        }
        if (layer === "debugger" && type === "main_frame" && req.firstDocument && mine.length) {
            const why = `may miss it: ${debuggerMissedLine("page load", url, [...new Set(mine.map((r) => r.scriptName))], mv3)}`;
            for (const r of mine) skip(r, why);
        }
        reached.push(layer);
        const args = { ...base, requestHeaders: { ...requestHeaders }, tier: layer };
        const d = await runOp(env.scripts, "requestDecision", args, env.opEnv);
        if (d?.kind === "headers") {
            if (applyEdits(requestHeaders, d.changes)) reqModified = true;
        } else if (d) {
            winner = winnerOf(d, layer);
            if (d.kind === "respond") {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(d.headers || {})) headers[k.toLowerCase()] = String(v);
                if (d.mime && !headers["content-type"]) headers["content-type"] = d.mime;
                replaced = { status: d.status ?? 200, headers, body: d.content ?? "" };
            }
            break;
        }
        const r = await runOp(env.scripts, "replace", { ...args, requestHeaders: { ...requestHeaders } }, env.opEnv);
        if (r) {
            winner = winnerOf(r, layer);
            replaced = { status: 200, headers: { "content-type": r.mime }, body: r.content };
            break;
        }
    }

    if (winner) {
        const w: Winner = winner;
        route ??= env.refs.find((r) => r.scriptId === w.scriptId && r.route.kind === w.kind && r.route.index === w.index)?.route;
        for (const r of skippedBy(env.refs, { url, method, type }, w)) skip(r, skipReason(r, w));
    }
    const decidedBy: DecidedBy | null = winner
        ? { strategy: winner.strategy, handler: route ? routeLabel(route) : `${winner.kind} #${winner.index + 1}`, script: winner.scriptName, outcome: winner.outcome }
        : null;
    const done = (action: LayerResult["action"], a: UpstreamAnswer, redirectedTo: string | null = null): LayerResult => ({
        ...a,
        action,
        redirectedTo,
        requestHeaders,
        skipped,
        decidedBy,
    });

    if (winner?.outcome === "block") return done("blocked", { status: 0, headers: {}, body: "" });
    if (winner?.outcome === "redirect") return done("redirected", { status: 307, headers: { location: winner.target! }, body: "" }, winner.target!);

    // the layers in front of the one that answered see the response, nearest first
    const front = winner ? reached.slice(0, reached.indexOf(winner.strategy)) : reached;
    const answer = replaced ?? (await env.upstream({ ...requestHeaders }));
    const headers = { ...answer.headers };
    let body = answer.body;
    let resModified = false;
    for (const layer of [...front].reverse()) {
        if (layer === "rules") {
            if (applyOps(headers, responseRules)) resModified = true;
            continue;
        }
        const args = { ...base, requestHeaders: { ...requestHeaders }, tier: layer, status: answer.status };
        const edits = await runOp(env.scripts, "responseHeaders", { ...args, responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) }, env.opEnv);
        if (applyEdits(headers, edits)) resModified = true;
        const ct = headers["content-type"];
        const bytes = typeof body === "string" ? null : body;
        const input = bodyKind(ct, bytes) === "binary" ? (typeof body === "string" ? enc.encode(body) : body) : typeof body === "string" ? body : dec.decode(body);
        const out = await runOp(env.scripts, "transform", { ...args, contentType: ct, body: input }, env.opEnv);
        if (out !== null && out !== undefined) {
            body = out;
            resModified = true;
        } else body = input;
    }
    const result = { status: answer.status, headers, body };
    if (replaced) return done("replaced", result);
    return done(reqModified || resModified ? "modified" : "passthrough", result);
}
