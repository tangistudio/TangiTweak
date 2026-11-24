/**
 * How handlers override each other or stack up: one model for every
 * strategy.
 *
 * A request passes the strategies as layers ({@link LAYERS}), page side
 * first:
 *
 *   page → rules → extension → debugger → helper → server
 *
 * Within a layer, handlers run in stages, each in list order (scripts top
 * to bottom, then registration order within a script):
 *
 *   onRequest → (network) → onResponseHeaders → onResponseBody
 *
 * Every matching onRequest handler runs. The last one that returns a
 * decision (`replaceResponse`, `redirect`, `block` or `allow`) has the last
 * word; the earlier decisions it replaced are "overruled"
 * ({@link overruledLine}). A final decision (block, redirect, replacement)
 * ends the request in its layer: every handler of the layers behind it
 * never sees it. A replacement (a mock) still goes through the layer's own
 * response handlers, unless the strategy serves it by redirect.
 *
 * The background's strategies and `runOp` (`shared/bodyOps.ts`) apply these
 * rules; the `tangitweak/test` harness (`testing/layers.ts`) simulates them.
 * This module decides who a final result kept from running
 * ({@link skippedBy}) and words the warnings for it ({@link skippedLine}),
 * stacks header edits ({@link HeaderStack}) and keeps one result per
 * onRequest return ({@link singleRequestResult}).
 *
 * @see docs/scripting.md, "Multiple handlers: how they stack"
 *
 * @module
 */

import { isNetKind, routeLabel, routeMatches, type NetKind, type RouteMeta, type Strategy } from "./route";

/**
 * The layers a request passes, page side first: one per strategy, in the
 * order they see the request on its way to the server.
 */
export const LAYERS: Strategy[] = ["page", "rules", "extension", "debugger", "helper"];

/** stage of each handler kind within a layer */
const STAGE: Record<NetKind, number> = { onRequest: 0, onResponseHeaders: 1, onResponseBody: 2 };

/** The handler a result came from, as `runOp` results carry it in `who`. */
export interface Who {
    /** ID of the handler's script. */
    scriptId: string;
    /** Name of the handler's script, as log lines show it. */
    scriptName: string;
    /** Which kind of network handler it is. */
    kind: NetKind;
    /** The handler's registration order within its kind in the script ({@link RouteMeta.index}, 0-based; labels show it 1-based). */
    index: number;
}

/**
 * What a final result did to the request.
 *
 * - `"replace"`: a response was served without the request reaching the
 *   network (an onRequest `replaceResponse`).
 * - `"block"`: an onRequest `block`.
 * - `"redirect"`: an onRequest `redirect`.
 */
export type FinalOutcome = "replace" | "block" | "redirect";

/** A final result and where it was decided. */
export interface Winner extends Who {
    /** The layer (strategy) whose handler decided it. */
    strategy: Strategy;
    /** What the result did to the request. */
    outcome: FinalOutcome;
    /** The redirect target URL; set only when {@link Winner.outcome} is `"redirect"`. */
    target?: string;
}

/**
 * An enabled network handler, in list order.
 *
 * The background lists one per network route of every enabled, active
 * script (`background/engine/skipped.ts`).
 */
export interface RouteRef {
    /** ID of the handler's script. */
    scriptId: string;
    /** Name of the handler's script, as log lines show it. */
    scriptName: string;
    /** The script's position in the list (0-based; disabled scripts still take a position). */
    order: number;
    /** The handler's route. */
    route: RouteMeta;
    /** The strategy that runs it: its layer in {@link LAYERS}. */
    strategy: Strategy;
}

/** The request a final result ended, as {@link skippedBy} matches routes against it. */
export interface SkipRequest {
    /** The request's URL. */
    url: string;
    /** HTTP method; undefined matches routes with any `methods`. */
    method?: string;
    /**
     * webRequest resource type; `""` or undefined = unknown.
     *
     * Page handlers count only when it is `"xmlhttprequest"`, since they only
     * ever see the page's own fetch/XHR.
     */
    type?: string;
}

/** How a final result was served, as {@link skippedBy} and {@link skipReason} take it. */
export interface SkipOptions {
    /**
     * Whether a replacement went through its layer's response handlers.
     * False where the strategy serves it by redirect (Chromium's
     * `extension`, `rules`), so they never see it.
     *
     * @defaultValue `true`
     */
    mockFlows?: boolean;
}

/**
 * Lists the handlers a final result kept from running on this request.
 *
 * Only handlers whose route matches the request ({@link routeMatches}) count,
 * never the winner itself:
 *
 * - Same layer: no onRequest handler (they all run). Response handlers
 *   after a block or a redirect, and after a replacement only when it
 *   doesn't flow through them (`opts.mockFlows` false).
 * - Layers behind the winner: everything (the request never gets there).
 * - Layers in front: only response handlers and only for a block (a
 *   replacement or a redirect still comes back to them as a response).
 *
 * After a redirect, handlers that also match the target run on the new
 * request, so they aren't counted.
 *
 * @param routes - The enabled handlers, in list order.
 * @param w - The final result and the layer that decided it.
 * @returns The skipped handlers, in the order of `routes`.
 */
export function skippedBy(routes: RouteRef[], req: SkipRequest, w: Winner, opts: SkipOptions = {}): RouteRef[] {
    const wl = LAYERS.indexOf(w.strategy);
    const ws = STAGE[w.kind];
    const type = req.type || undefined;
    return routes.filter((r) => {
        const kind = r.route.kind;
        if (!isNetKind(kind)) return false;
        if (r.scriptId === w.scriptId && kind === w.kind && r.route.index === w.index) return false;
        // page handlers only ever see the page's own fetch/XHR
        if (r.strategy === "page" && type !== "xmlhttprequest") return false;
        if (!routeMatches(r.route, req.url, req.method, type)) return false;
        if (w.outcome === "redirect" && w.target && routeMatches(r.route, w.target, req.method, type)) return false;
        const l = LAYERS.indexOf(r.strategy);
        const rs = STAGE[kind];
        if (l > wl) return true;
        if (l < wl) return w.outcome === "block" && rs >= STAGE.onResponseHeaders;
        if (rs <= ws) return false;
        return w.outcome !== "replace" || opts.mockFlows === false;
    });
}

/**
 * Turns a `runOp` result into the {@link Winner} behind it.
 *
 * A requestDecision `respond`/`cancel`/`redirect` gives a `"replace"`,
 * `"block"` or `"redirect"` winner.
 *
 * @param r - The result; it must carry `who` ({@link Who}).
 * @param strategy - The layer that ran the op.
 * @returns The winner; `null` for anything else (no `who` or a result
 *   that isn't final, such as header edits).
 */
export function winnerOf(r: any, strategy: Strategy): Winner | null {
    const who: Who | undefined = r?.who;
    if (!who) return null;
    if (r.kind === "respond") return { ...who, strategy, outcome: "replace" };
    if (r.kind === "cancel") return { ...who, strategy, outcome: "block" };
    if (r.kind === "redirect") return { ...who, strategy, outcome: "redirect", target: r.url };
    return null;
}

/** What an onRequest decision does: a final one ({@link FinalOutcome}) or `"allow"`, which drops an earlier one. */
export type RequestDecision = FinalOutcome | "allow";

/** An onRequest handler with the decision it returned. */
export interface Decided extends Who {
    /** What it decided. */
    outcome: RequestDecision;
}

/** Who served a mock: response handlers that run on it get this as `ctx.replacedBy`. */
export interface ReplacedBy {
    /** Name of the tweak whose onRequest handler returned the mock. */
    tweak: string;
    /** That handler's label, e.g. `onRequest #1`. */
    handler: string;
}

const WHAT: Record<RequestDecision, string> = { replace: "replaceResponse", block: "block", redirect: "redirect", allow: "allow" };

/**
 * Labels a decision for log lines: `onRequest #1 → block` (or
 * `→ replaceResponse`, `→ redirect`, `→ allow`). Numbers are 1-based.
 */
export function winnerLabel(w: Decided): string {
    return `${w.kind} #${w.index + 1} → ${WHAT[w.outcome]}`;
}

/**
 * Says why `r` didn't run: the {@link skippedBy} rule that applies, as the
 * parenthesized reason of a {@link skippedLine}.
 *
 * Assumes {@link skippedBy} returned `r` for `w` with the same `opts`.
 */
export function skipReason(r: RouteRef, w: Winner, opts: SkipOptions = {}): string {
    const wl = LAYERS.indexOf(w.strategy);
    const l = LAYERS.indexOf(r.strategy);
    if (l > wl) return `strategy "${w.strategy}" comes before "${r.strategy}", so the request never got there`;
    if (l < wl) return `a blocked request has no response`;
    if (w.outcome === "replace" && opts.mockFlows === false) return `strategy "${w.strategy}" serves a mock by redirect here, so response handlers can't run on it`;
    return `the request ended there`;
}

/** The reason an {@link overruledLine} gives when both handlers are in the same layer. */
export const SAME_LAYER_LATER = "same layer, it comes later in the list";

/**
 * Builds the WARN line for an onRequest decision a later handler replaced:
 * `[A] onRequest #1 → block was overruled: [B] onRequest #1 → replaceResponse has the last word (why) <url>`.
 *
 * @param over - The earlier decision, which no longer applies.
 * @param by - The later decision, which applies unless another replaces it.
 * @param why - Why `by` comes later. @defaultValue {@link SAME_LAYER_LATER}
 */
export function overruledLine(over: Decided, by: Decided, url: string, why = SAME_LAYER_LATER): string {
    return `[${over.scriptName}] ${winnerLabel(over)} was overruled: [${by.scriptName}] ${winnerLabel(by)} has the last word (${why}) ${url}`;
}

/**
 * Builds the INFO line for a response handler that ran on a mock:
 * `[B] onResponseBody #1 ran on a mock from [A] onRequest #1 (ctx.replacedBy is set) <url>`.
 *
 * @param handler - The response handler's label, e.g. `onResponseBody #1`.
 * @param mock - Who served the mock: the tweak's name and its handler's label.
 */
export function mockFlowLine(scriptName: string, handler: string, mock: ReplacedBy, url: string): string {
    return `[${scriptName}] ${handler} ran on a mock from [${mock.tweak}] ${mock.handler} (ctx.replacedBy is set) ${url}`;
}

/**
 * The text that marks a {@link skippedLine}.
 *
 * The background's `log` looks for it: a skipped body handler legitimately
 * never runs, so it isn't also warned about with a "… never ran for …" line.
 */
export const SKIPPED_MARK = " → skipped: ";

/**
 * Builds the WARN line for a handler a final result kept from running:
 * `[B] onResponseBody #1 → skipped: [A] onRequest #1 → block took priority (why) <url>`.
 *
 * The background logs one per skipped handler with kind `"missed"`, so the
 * Network view shows it as missed (`is:missed`). It ends with the URL, so it
 * annotates that request.
 *
 * @param r - The skipped handler.
 * @param w - The final result that took priority.
 */
export function skippedLine(r: RouteRef, w: Winner, url: string, opts: SkipOptions = {}): string {
    return `[${r.scriptName}] ${routeLabel(r.route)}${SKIPPED_MARK}[${w.scriptName}] ${winnerLabel(w)} took priority (${skipReason(r, w, opts)}) ${url}`;
}

// ---- header edits: the later handler in list order wins per header ----

/** A handler's header edits: what an onRequest `headers` or onResponseHeaders result holds. */
export interface HeaderEdits {
    /** Headers to set, by name; values are converted with `String()`. */
    set?: Record<string, any>;
    /** Names of headers to remove. */
    remove?: string[];
}

/** A header edit a later handler replaced, reported as a warning ({@link overrideLine}). */
export interface HeaderOverride {
    /** The header's name, lowercased. */
    header: string;
    /** The later handler, whose edit applies. */
    by: Who;
    /** The earlier handler, whose edit is replaced. */
    over: Who;
}

/**
 * Stacks header edits in list order. Per header (case-insensitive) the
 * last edit wins, whether it sets or removes.
 *
 * Callers create one per request and stage, {@link HeaderStack.add} each
 * handler's edits as it returns, then apply {@link HeaderStack.result}.
 */
export class HeaderStack {
    private edits = new Map<string, { name: string; value?: string; by?: Who }>();

    /**
     * Adds one handler's edits, after the ones added before.
     *
     * Within one call, removals are applied before sets, so a header both
     * removed and set ends up set. A header keeps the name as its latest edit
     * wrote it.
     *
     * @param h - The edits; `null` or undefined adds nothing.
     * @param by - The handler they come from. Without it, nothing is reported
     *   as overridden, either by or over these edits.
     * @returns The earlier handlers' edits these replace with a different
     *   value (an edit from the same handler or with the same value isn't
     *   reported).
     */
    add(h: HeaderEdits | null | undefined, by?: Who): HeaderOverride[] {
        const out: HeaderOverride[] = [];
        const put = (name: string, value: string | undefined) => {
            const key = name.toLowerCase();
            const prev = this.edits.get(key);
            if (prev?.by && by && prev.value !== value && !(prev.by.scriptId === by.scriptId && prev.by.kind === by.kind && prev.by.index === by.index)) {
                out.push({ header: key, by, over: prev.by });
            }
            this.edits.delete(key); // re-insert: keeps the applied order
            this.edits.set(key, { name, value, by });
        };
        for (const n of h?.remove || []) put(String(n), undefined);
        for (const [n, v] of Object.entries(h?.set || {})) put(n, String(v));
        return out;
    }

    /** Whether no edit has been added. */
    get empty(): boolean {
        return this.edits.size === 0;
    }

    /**
     * The merged edits, in the order they were last applied: no header is
     * both set and removed.
     */
    result(): {
        /** Headers to set, by name as last written. */
        set: Record<string, string>;
        /** Names of headers to remove. */
        remove: string[];
    } {
        const set: Record<string, string> = {};
        const remove: string[] = [];
        for (const e of this.edits.values()) {
            if (e.value === undefined) remove.push(e.name);
            else set[e.name] = e.value;
        }
        return { set, remove };
    }
}

/**
 * Merges `add` over `base`: the later edit wins per header.
 *
 * Neither side is attributed to a handler, so no override is reported.
 */
export function mergeHeaderEdits(
    base: HeaderEdits | null | undefined,
    add: HeaderEdits
): {
    /** Headers to set, by name as last written. */
    set: Record<string, string>;
    /** Names of headers to remove. */
    remove: string[];
} {
    const s = new HeaderStack();
    s.add(base);
    s.add(add);
    return s.result();
}

/**
 * Builds the WARN line for a header edit a later handler replaced:
 * `[B] onRequest #1 overrides request header "x" from [A] onRequest #1 (the later one in the list wins) <url>`.
 *
 * @param which - Whether it is a request or a response header.
 */
export function overrideLine(o: HeaderOverride, which: "request" | "response", url: string): string {
    return `[${o.by.scriptName}] ${o.by.kind} #${o.by.index + 1} overrides ${which} header "${o.header}" from [${o.over.scriptName}] ${o.over.kind} #${o.over.index + 1} (the later one in the list wins) ${url}`;
}

/** The keys of an onRequest result, in the order {@link singleRequestResult} keeps the first used one. */
const REQUEST_RESULTS = ["replaceResponse", "redirect", "block", "allow", "headers"] as const;
/** A key of an onRequest result: one of {@link REQUEST_RESULTS}. */
type RequestResultKey = (typeof REQUEST_RESULTS)[number];

function usesKey(result: any, k: RequestResultKey): boolean {
    if (k === "headers") return !!result.headers && ((result.headers.set && Object.keys(result.headers.set).length > 0) || (result.headers.remove && result.headers.remove.length > 0));
    return k === "block" || k === "allow" ? result[k] === true : !!result[k];
}

/**
 * Keeps one result of an onRequest return value: it is exactly one of
 * replaceResponse / redirect / block / allow / headers.
 *
 * One with several keeps the first in that order and drops the rest
 * (`dropped`, for the {@link mixedResultLine} warning), the same on every
 * strategy. A key counts as used when it is truthy, except `block` and `allow` (only
 * `true`) and `headers` (only with a non-empty `set` or `remove`).
 *
 * @param result - The handler's return value.
 * @returns `result` itself when it uses at most one key (or isn't an
 *   object), else a shallow copy without the dropped keys.
 */
export function singleRequestResult<T>(result: T): {
    /** The result to apply: `result` itself or a copy without the dropped keys. */
    result: T;
    /** The key that applies; undefined when the result uses none. */
    kept?: RequestResultKey;
    /** The keys that were removed; empty unless several were used. */
    dropped: RequestResultKey[];
} {
    if (!result || typeof result !== "object") return { result, dropped: [] };
    const used = REQUEST_RESULTS.filter((k) => usesKey(result, k));
    if (used.length < 2) return { result, kept: used[0], dropped: [] };
    const [kept, ...dropped] = used;
    const out: any = { ...result };
    for (const k of dropped) delete out[k];
    return { result: out, kept, dropped };
}

/**
 * Builds the WARN line for an onRequest result that used several keys (see
 * {@link singleRequestResult}), e.g.
 * `[S] onRequest #1 returned redirect and headers — … so only redirect applied <url>`
 * (the line puts each key name in backticks).
 *
 * When a redirect dropped headers, it adds how to change the redirected
 * request's headers instead (an onRequest handler for the target URL).
 *
 * @param handler - The handler's label, e.g. `onRequest #1`.
 * @param kept - The key that applied.
 * @param dropped - The keys that were ignored.
 */
export function mixedResultLine(scriptName: string, handler: string, kept: string, dropped: string[], url: string): string {
    const ignored = dropped.map((k) => `\`${k}\``).join(", ");
    return `[${scriptName}] ${handler} returned \`${kept}\` and ${ignored} — an onRequest result is one of replaceResponse, redirect, block, allow or headers, so only \`${kept}\` applied${kept === "redirect" && dropped.includes("headers") ? " (to change the redirected request's headers, add an onRequest handler for the target URL)" : ""} ${url}`;
}
