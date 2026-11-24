/**
 * The test loader's request walk (plan §6.6), used by `simulate` when
 * `realLimits` is on and the request names no `strategy`.
 *
 * A request goes through the strategies as layers, in the browser's order
 * (`LAYERS` in precedence.ts: `page`, `rules`, `extension`, `debugger`,
 * `helper`) and each layer sees it only if that browser would let it. The
 * `rules` layer applies the fixed browser rules the handlers were probed
 * into, without calling the handlers. The first block, redirect or
 * replacement stops the request; the layers in front of it then run their
 * response handlers, nearest first. Every handler that didn't get to run is
 * listed with the extension's own words for why.
 *
 * @module
 */

import { bodyKind } from "../shared/bodyKind";
import { resolveFileRef, runOp, type OpEnv, type OpScript } from "../shared/bodyOps";
import { debuggerMissedLine, isLoopbackUrl, MISSED_REASONS, routeProblem } from "../shared/missedTap";
import { LAYERS, skippedBy, skipReason, winnerOf, type RouteRef, type Winner } from "../shared/precedence";
import { handlerLayer, routeLabel, routeMatches, type Layer, type RouteMeta, type Strategy } from "../shared/route";
import { substitute, type RuleSpec } from "../shared/dnrRules";
import type { Routed } from "../shared/compile";
import { NET_KINDS } from "../shared/route";

/** The browser a test pretends to be: Chrome MV3, a Chromium MV2 build or Firefox. */
export type BrowserName = "chrome" | "chromium-mv2" | "firefox";

/** What each {@link BrowserName} is, in the terms `routeProblem` checks a route against. */
export const BROWSER_ENV: Record<
    BrowserName,
    {
        /** Whether the browser is Firefox. */
        firefox: boolean;
        /** Whether the extension runs as Manifest V3 (only `"chrome"`). */
        mv3: boolean;
    }
> = {
    chrome: { firefox: false, mv3: true },
    "chromium-mv2": { firefox: false, mv3: false },
    firefox: { firefox: true, mv3: false },
};

/** A handler that didn't run for a request and why. */
export interface SkippedHandler {
    /** The handler's label, such as `onResponseBody #1`. */
    handler: string;
    /** The strategy the handler's route runs with. */
    strategy: Strategy;
    /** The name of the script the handler belongs to. */
    script: string;
    /** The reason, in the words the extension shows for it. */
    why: string;
}

/** The handler whose block, redirect or replacement ended the request. */
export interface DecidedBy {
    /** The layer that answered (`"rules"` for a probed browser rule). */
    strategy: Strategy;
    /** The handler's label, such as `onRequest #1` or `<kind> #<n>` when its route isn't known. */
    handler: string;
    /** The name of the script the handler belongs to. */
    script: string;
    /** What it did: answered the request itself, blocked it or redirected it. */
    outcome: "replace" | "block" | "redirect";
}

/** A script's probed `rules` handler, as the browser took it. */
export interface RuleGroupRef {
    /** The id of the script the handler belongs to. */
    scriptId: string;
    /** The name of that script. */
    scriptName: string;
    /** The handler's route. */
    route: RouteMeta;
    /** The declarativeNetRequest rules the probe produced, in order. */
    specs: RuleSpec[];
    /** The handler's layer; {@link LayerEnv.rules} lists the handlers by layer, then list order. */
    layer?: Layer;
}

/**
 * Turns `resourceType` as tests write it into the webRequest type.
 *
 * `undefined`, `"fetch"` and `"xhr"` become `"xmlhttprequest"`, `"document"`
 * becomes `"main_frame"` and `"iframe"` becomes `"sub_frame"`. Anything else
 * is returned as it is.
 *
 * @param t - The `resourceType` a test passed, if any.
 * @returns The webRequest type.
 */
export function webRequestType(t: string | undefined): string {
    if (!t || t === "fetch" || t === "xhr") return "xmlhttprequest";
    if (t === "document") return "main_frame";
    if (t === "iframe") return "sub_frame";
    return t;
}

/**
 * Returns a tweak's handlers as `browser` runs them: the routes it turns off
 * (with the Problems view's text) and the ones left.
 *
 * On Chromium MV2 an `extension` handler's async result is ignored, since
 * blocking webRequest can't wait for it: the promise's rejection is
 * swallowed, `onAsync` is called and the handler counts as returning
 * nothing.
 *
 * @param scripts - The compiled scripts, in load order.
 * @param browser - The browser to run them as.
 * @param onAsync - Called each time an ignored async result comes back.
 * @returns The scripts without their turned-off routes, the routes left and the routes turned off.
 */
export function layerScripts(
    scripts: OpScript[],
    browser: BrowserName,
    onAsync: (s: OpScript, route: RouteMeta) => void
): {
    /** The scripts with only the routes `browser` runs, MV2 `extension` handlers wrapped. */
    scripts: OpScript[];
    /** Every route that runs, in script order. */
    refs: RouteRef[];
    /** Every route `browser` turns off. */
    disabled: {
        /** The route. */
        ref: RouteRef;
        /** Why it is off, as the Problems view says it. */
        why: string;
    }[];
} {
    const env = { ...BROWSER_ENV[browser], dnr: true };
    const refs: RouteRef[] = [];
    const disabled: { ref: RouteRef; why: string }[] = [];
    const out = scripts.map((s, order) => {
        const handlers: any = { ...s.handlers };
        for (const kind of NET_KINDS) {
            handlers[kind] = ((s.handlers as any)[kind] as Routed[]).flatMap((h) => {
                const ref: RouteRef = { scriptId: s.id, scriptName: s.name, order, route: h.route, layer: handlerLayer(h.route, s.layers).layer, strategy: h.route.strategy! };
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

/** A request as {@link requestThroughLayers} walks it. */
export interface LayerRequest {
    /** The full request URL. */
    url: string;
    /** The HTTP method, in upper case. */
    method: string;
    /** The tab the request comes from. */
    tabId: number;
    /** The id of the page the request comes from (`simulate` defaults it to `tab:<tabId>`). */
    page: string;
    /** The URL of the tab's page. */
    tabUrl: string;
    /** The webRequest type, as {@link webRequestType} gives it. */
    resourceType: string;
    /** The request headers, with lower-case names. */
    requestHeaders: Record<string, string>;
    /** The request body, as handlers receive it. */
    requestBody?: unknown;
    /** Whether this is a document request in a tab that had none before (the debugger may miss it). */
    firstDocument?: boolean;
}

/** A response: the server's or one a handler or rule made. */
export interface UpstreamAnswer {
    /** The HTTP status. */
    status: number;
    /** The response headers, with lower-case names. */
    headers: Record<string, string>;
    /** The response body. */
    body: string | Uint8Array;
}

/** What {@link requestThroughLayers} needs to know about the tweak and the browser. */
export interface LayerEnv {
    /** The browser to act as. */
    browser: BrowserName;
    /** The scripts to run, as {@link layerScripts} returned them. */
    scripts: OpScript[];
    /** The routes that run, from {@link layerScripts}. */
    refs: RouteRef[];
    /** The routes the browser turns off, from {@link layerScripts}. */
    disabled: {
        /** The route. */
        ref: RouteRef;
        /** Why it is off, as the Problems view says it. */
        why: string;
    }[];
    /** Every script's probed `rules` handlers, in run order (layer, then list order): a later one gets a higher rule priority. */
    rules: RuleGroupRef[];
    /** Where handlers' log lines (and optional trace lines) go. */
    opEnv: OpEnv;
    /**
     * Fetches the real response when no layer answers.
     *
     * @param requestHeaders - The request headers after every layer's edits.
     * @returns The server's response.
     */
    upstream(requestHeaders: Record<string, string>): Promise<UpstreamAnswer>;
}

/** What came of a request: the response the page gets and how it got there. */
export interface LayerResult extends UpstreamAnswer {
    /**
     * What happened to the request: `"blocked"` (status 0), `"redirected"`
     * (status 307), `"replaced"` (a handler or rule answered), `"modified"`
     * (headers or body changed) or `"passthrough"`.
     */
    action: "passthrough" | "modified" | "replaced" | "redirected" | "blocked";
    /** The redirect target or `null` when there was no redirect. */
    redirectedTo: string | null;
    /** The request headers after every layer's edits. */
    requestHeaders: Record<string, string>;
    /** Every matching handler that didn't run and why. */
    skipped: SkippedHandler[];
    /** The handler that blocked, redirected or answered the request (`null` when none did). */
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

/** Applies declarativeNetRequest header ops to `headers` and returns whether anything changed. */
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

/**
 * Walks `req` through the layers, as described at the top of this file.
 *
 * Matching routes the browser turns off are listed as skipped first. Then,
 * layer by layer:
 *
 * - `rules` applies the probed rules' request header edits. Its last
 *   matching block or redirect (the highest rule priority) ends the walk
 *   instead, dropping those edits; a redirect to a `data:` URL becomes a
 *   replacement with status 200. A last `allow` lets the request on and
 *   drops the header edits of handlers before it.
 * - `page` only sees `xmlhttprequest` requests and `helper` never sees
 *   loopback URLs; their handlers are listed as skipped otherwise.
 * - For a tab's first document, `debugger` handlers are listed as ones
 *   that "may miss it" but still run.
 * - Every other layer runs its request handlers, then its replacements.
 *   The first answer, block or redirect ends the walk.
 *
 * A block answers with status 0 and a redirect with status 307 and a
 * `location` header. Otherwise the response (the replacement or
 * `env.upstream`'s) goes back through the layers in front of the one that
 * answered, nearest first, each running its header and body handlers.
 *
 * @param env - The tweak and browser to walk the request with.
 * @param req - The request.
 * @returns The response the page gets, with what decided it and what was skipped.
 */
export async function requestThroughLayers(env: LayerEnv, req: LayerRequest): Promise<LayerResult> {
    const { url, method, resourceType: type } = req;
    const mv3 = env.browser === "chrome";
    // Chromium serves an extension or rules mock by redirect: the layer's response handlers never see it
    const mockFlows = (layer: Strategy) => layer !== "rules" && (layer !== "extension" || env.browser === "firefox");
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
            // rule priority follows run order: the last matching decision wins, and an
            // allow on top keeps only later handlers' header edits (they outrank it)
            let top: { g: RuleGroupRef; spec: RuleSpec; rank: number } | undefined;
            const edits: { rank: number; a: any }[] = [];
            env.rules.forEach((g, rank) => {
                for (const spec of g.specs) {
                    if (!specMatches(spec, req)) continue;
                    const a = spec.action || {};
                    if (a.type === "modifyHeaders") edits.push({ rank, a });
                    else if (a.type === "block" || a.type === "redirect" || a.type === "allow") top = { g, spec, rank };
                }
            });
            if (top && top.spec.action.type !== "allow") {
                const { g, spec } = top;
                const a = spec.action;
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
            const ops: any[] = [];
            for (const e of edits) {
                if (top && e.rank <= top.rank) continue;
                ops.push(...(e.a.requestHeaders || []));
                responseRules.push(...(e.a.responseHeaders || []));
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
        const d = await runOp(env.scripts, "requestDecision", { ...args, mockFlows: mockFlows(layer) }, env.opEnv);
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
    }

    if (winner) {
        const w: Winner = winner;
        route ??= env.refs.find((r) => r.scriptId === w.scriptId && r.route.kind === w.kind && r.route.index === w.index)?.route;
        const opts = { mockFlows: mockFlows(w.strategy) };
        for (const r of skippedBy(env.refs, { url, method, type }, w, opts)) skip(r, skipReason(r, w, opts));
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
