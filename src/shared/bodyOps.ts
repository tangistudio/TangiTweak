/**
 * Runs a script's network handlers for one request: the "body ops".
 *
 * Shared by every place network handlers run, so the chain semantics are
 * identical everywhere: the MV3 sandbox page (`sandbox.ts`, for the `page`,
 * `debugger` and `helper` strategies), the background's `page`, `debugger`
 * and `helper` strategies (MV2) and the `tangitweak/test` harness. Each
 * caller passes the compiled scripts ({@link OpScript}) and the request to
 * {@link runOp}, which runs one {@link BodyOp}:
 *
 * - `requestDecision`: every matching `tweak.onRequest` handler, in order.
 *   The last decision (`replaceResponse`, `redirect`, `block` or `allow`)
 *   wins; `allow` drops an earlier one. Header edits stack (the later
 *   handler wins per header) and each handler sees the earlier ones' in
 *   `ctx.requestHeaders`. A replacement (a mock) then goes through the
 *   matching `onResponseHeaders` and `onResponseBody` handlers, which get
 *   `ctx.replacedBy`.
 * - `transform`: `tweak.onResponseBody` handlers compose in order, each
 *   getting the previous one's output.
 * - `responseHeaders`: `tweak.onResponseHeaders` handlers; header edits
 *   stack.
 *
 * Handlers run in script list order, then registration order. A handler
 * that throws is logged as an error and skipped; the chain goes on. Final
 * results carry `who` (the handler that decided) so the caller can report
 * the handlers it kept from running (see `precedence.ts`).
 *
 * @module
 */

import { withPage } from "./currentPage";
import { tabScope } from "./storeOps";
import { formatScriptError } from "./scriptError";
import { effectiveStrategy, handlerLayer, routeGroups, routeLabel, routeMatches, sortByLayer, takesBinary, takesText, type Layer, type ScriptLayers, type Strategy } from "./route";
import type { Routed, ScriptHandlers } from "./compile";
import { kindSkipLine, observedLine, type NetKind } from "./netTypes";
import { HeaderStack, mockFlowLine, mixedResultLine, overrideLine, overruledLine, singleRequestResult, type RequestDecision, type Who } from "./precedence";
import { makeMissedThrottle } from "./missedTap";
import { requestBodyCtx } from "./requestBody";

/**
 * Which handler chain {@link runOp} runs: `requestDecision` (`onRequest`),
 * `transform` (`onResponseBody`) or `responseHeaders` (`onResponseHeaders`).
 */
export type BodyOp = "requestDecision" | "transform" | "responseHeaders";

/** A compiled script whose handlers {@link runOp} may run. */
export interface OpScript {
    /** The script's id: log lines and `who` results are attributed to it. */
    id: string;
    /** The script's name, used in log lines. */
    name: string;
    /** The handlers its compile collected (`CompiledScript.handlers`). */
    handlers: ScriptHandlers;
    /** The script's explicit layers (user setting, package.json); its handlers' layers come from these and their routes ({@link handlerLayer}). */
    layers?: ScriptLayers;
}

/**
 * Which handlers an op runs ({@link handlerRuns}): those whose route matches
 * the request and, when `tier` is given, is owned by that strategy
 * (`route.strategy`).
 *
 * Each network route has exactly one owning strategy, so no handler runs on
 * two strategies for the same request.
 */
export interface OpFilter {
    /** The request URL, matched against the route's `url` and `exclude` patterns. */
    url: string;
    /** The request method; undefined: the route's `methods` aren't checked. */
    method?: string;
    /** The webRequest resource type (`"script"`, `"xmlhttprequest"`, …); undefined: the route's `resourceTypes` aren't checked. */
    resourceType?: string;
    /** Only routes owned by this strategy; undefined: any strategy. */
    tier?: Strategy;
    /** Only the scripts with these ids; undefined: every script. */
    onlyIds?: string[];
    /**
     * `onResponseBody` only: whether the body is binary (`true`) or text
     * (`false`); each route then runs per its `binary` option. Undefined: no
     * check.
     */
    binary?: boolean;
}

/**
 * Whether the handler `h` runs for the request described by `f`: its route
 * is owned by `f.tier` (when set), takes this kind of body (when
 * `f.binary` is set) and matches the URL, method and resource type.
 */
export function handlerRuns(h: Routed, f: OpFilter): boolean {
    if (f.tier && effectiveStrategy(h.route) !== f.tier) return false;
    if (f.binary !== undefined && !(f.binary ? takesBinary(h.route) : takesText(h.route))) return false;
    return routeMatches(h.route, f.url, f.method, f.resourceType);
}

/** Where {@link runOp} reports what the handlers did; each caller routes it to its own log. */
export interface OpEnv {
    /**
     * Logs a line for the script `scriptId`: what a handler changed (`info`),
     * an override or mixed-result warning (`warn`, throttled), a handler that
     * threw (`error`). `kind` `"observed"` marks a `debug` line saying a
     * handler ran but changed nothing (or skipped a body of the wrong kind).
     */
    log(scriptId: string, level: "debug" | "info" | "warn" | "error", msg: string, kind?: NetKind): void;
    /** Receives a trace line per op: the URL, the strategy and the matching scripts. Optional. */
    debug?(msg: string): void;
}

/** A `replaceResponse` result's MIME type by resource type, for when the URL has no telling extension. */
const TYPE_MIME: Record<string, string> = { main_frame: "text/html", sub_frame: "text/html", stylesheet: "text/css", script: "application/javascript" };

/**
 * Guesses a response's MIME type from the URL's extension (`.js`, `.json`,
 * `.css`, `.html`, `.xml`), ignoring the query string.
 *
 * @param fallback What to return for any other extension.
 *   @defaultValue `"application/json"`
 */
export function guessMimeFromUrl(url: string, fallback = "application/json"): string {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
    const m: Record<string, string> = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml" };
    return m[ext] || fallback;
}

/**
 * Turns a `replaceResponse` result's `{ file }` into a body and its MIME type.
 *
 * A `data:` URL is decoded (base64 or percent-encoded) and its media type
 * wins over the request URL's extension (`text/plain` when it has none); if
 * decoding fails, the encoded text is the body. Any other ref is returned
 * as the body itself, typed by {@link guessMimeFromUrl} from `url`.
 *
 * @param ref The `file` value.
 * @param url The request URL.
 */
export function resolveFileRef(
    ref: string,
    url: string
): {
    /** The body's media type. */
    mime: string;
    /** The body: a `data:` URL's decoded text (UTF-8) or the ref itself. */
    content: string;
} {
    const m = /^data:([^,]*?),(.*)$/s.exec(ref);
    if (!m) return { mime: guessMimeFromUrl(url), content: ref };
    const params = m[1].split(";");
    const base64 = params.includes("base64");
    const mime = params[0] || "text/plain";
    let content: string;
    try {
        content = base64 ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    } catch {
        content = m[2];
    }
    return { mime, content };
}

/**
 * Turns an `onRequest` `replaceResponse.body` into text: a string as is, a
 * `Uint8Array` decoded as UTF-8, anything else as JSON.
 */
export function serializeRespondBody(body: any): string {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return JSON.stringify(body);
}

const HANDLER_OF: Record<BodyOp, keyof ScriptHandlers> = {
    requestDecision: "onRequest",
    transform: "onResponseBody",
    responseHeaders: "onResponseHeaders",
};

/** One handler an op runs, with its script and layer. */
interface Step {
    s: OpScript;
    h: Routed;
    layer: Layer;
}

/**
 * The handlers matching `f` for `op`, in run order: by layer (base, site,
 * override), then script list order, then registration order. Every op runs
 * them in this order, so this is the one place that orders them.
 */
function matching(scripts: OpScript[], op: BodyOp, f: OpFilter, env: OpEnv): Step[] {
    const kind = HANDLER_OF[op];
    const steps: Step[] = [];
    for (const s of scripts) {
        if (f.onlyIds && !f.onlyIds.includes(s.id)) continue;
        for (const h of ((s.handlers as any)[kind] as Routed[]) || []) {
            if (handlerRuns(h, f)) steps.push({ s, h, layer: handlerLayer(h.route, s.layers).layer });
        }
    }
    const out = sortByLayer(steps, (x) => x.layer);
    env.debug?.(`run ${op} ${f.url}${f.tier ? ` [${f.tier}]` : ""} → ${out.length} matching handler(s) [${out.map((m) => `${m.s.name} ${routeLabel(m.h.route)} (${m.layer})`).join(", ")}]`);
    return out;
}

const overrideThrottle = makeMissedThrottle();

/** Stacks one handler's header edits, warning (throttled per header and handler pair) when it overrides an earlier handler's. */
function stackHeaders(stack: HeaderStack, edits: any, by: Who, which: "request" | "response", url: string, env: OpEnv): void {
    for (const o of stack.add(edits, by)) {
        const key = `${which}|${o.header}|${o.by.scriptId}|${o.by.kind}|${o.by.index}|${o.over.scriptId}|${o.over.kind}|${o.over.index}`;
        if (overrideThrottle(key)) env.log(o.by.scriptId, "warn", overrideLine(o, which, url));
    }
}

/** Throttles the "returned several results" warning: at most one per handler per minute. */
const mixedThrottle = makeMissedThrottle();

function hasHeaderMods(h: any): boolean {
    return !!h && ((h.set && Object.keys(h.set).length > 0) || (h.remove && h.remove.length > 0));
}

/** Throttles the "overruled" warning: at most one per handler pair per minute. */
const overruledThrottle = makeMissedThrottle();
/** Throttles the "ran on a mock" line: at most one per mock and response handler pair per minute. */
const mockFlowThrottle = makeMissedThrottle();

/** `headers` with `edits` applied: a removed or set name (case-insensitive) goes, then each set one is written lowercased. */
export function editRecord(headers: Record<string, string>, edits: any): Record<string, string> {
    const drop = new Set([...(edits.remove || []), ...Object.keys(edits.set || {})].map((n) => String(n).toLowerCase()));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!drop.has(k.toLowerCase())) out[k] = v;
    for (const [k, v] of Object.entries(edits.set || {})) out[k.toLowerCase()] = String(v);
    return out;
}

/** One header, as webRequest lists them. */
export interface HeaderPair {
    /** The header's name, in any case. */
    name: string;
    /** Its value; webRequest leaves it out for a binary value. */
    value?: string;
}

/** What an onRequest `replaceResponse` serves. */
export interface Replacement {
    /** Its Content-Type. */
    mime: string;
    /** Its body. */
    content: string;
}

/** `pairs` with `edits` applied: a removed or set name (case-insensitive) goes, then each set one is appended. */
export function editPairs(pairs: HeaderPair[], edits: any): HeaderPair[] {
    const drop = new Set([...(edits.remove || []), ...Object.keys(edits.set || {})].map((n) => String(n).toLowerCase()));
    return [...pairs.filter((p) => !drop.has(p.name.toLowerCase())), ...Object.entries(edits.set || {}).map(([name, v]) => ({ name, value: String(v) }))];
}

/**
 * Turns an onRequest `replaceResponse` into the body and Content-Type it
 * serves. A `{ file }` body is read with {@link resolveFileRef}. The
 * Content-Type is `r.mime`, else a `data:` file's own, else the URL's
 * extension, else the resource type's ({@link TYPE_MIME}), else
 * `application/json`.
 */
export function replacementBody(r: any, url: string, resourceType: string): Replacement {
    const body = r.body;
    const fallback = () => guessMimeFromUrl(url, TYPE_MIME[resourceType] ?? "application/json");
    if (body && typeof body === "object" && !(body instanceof Uint8Array) && typeof body.file === "string") {
        const f = resolveFileRef(body.file, url);
        return { mime: r.mime || (body.file.startsWith("data:") ? f.mime : fallback()), content: f.content };
    }
    return { mime: r.mime || fallback(), content: serializeRespondBody(body) };
}

/**
 * Runs one op's handler chain from `scripts` for one request (see the
 * module overview for each op's semantics).
 *
 * Each handler call runs inside `withPage(args.page, …, tab)`, so
 * `tweak.pageStore` and `tweak.tabStore` resolve to that request's page and
 * tab (during the call's synchronous part). A handler that throws is logged
 * through `env` as an error and the chain goes on; a handler's errors never
 * reject the returned promise.
 *
 * `args` carries the request: `url`, `method`, `tabId` (a negative or absent
 * one: no tab), `tabUrl` (default: `url`), `resourceType` (absent:
 * `"xmlhttprequest"`; `""`: unknown, so the handler sees `"other"` and routes'
 * `resourceTypes` aren't checked), `requestHeaders`, `requestBody`, `page`,
 * `tier` and `onlyIds` (see {@link OpFilter}); for `responseHeaders` also
 * `status`, `statusLine` and `responseHeaders`; for `transform` also `body`
 * (a string or `Uint8Array`), `contentType`, `status` and `raw`. For
 * both, `replacedBy` (`{ tweak, handler }`) when the response is a mock:
 * handlers get it as `ctx.replacedBy`. For `requestDecision`, `mockFlows`
 * `false` returns a mock without running the response handlers on it (a
 * strategy that serves it by redirect, or runs them itself), and `rawMock`
 * keeps a `Uint8Array` mock body as bytes.
 *
 * @returns `null` when no handler changed anything. Otherwise, by op:
 * - `requestDecision`: the last decision: `{ kind: "respond", mime, content,
 *   status, headers, scriptId, scriptName, who, replacedBy }` (a mock, after
 *   the response handlers ran on it; `headers` without Content-Type, which
 *   is `mime`), `{ kind: "redirect", url, who }` or `{ kind: "cancel", who }`.
 *   Without one, `{ kind: "headers", changes }` with the stacked request
 *   header edits.
 * - `transform`: the new body. It stays a `Uint8Array` when the input was
 *   binary or `args.raw` is set; otherwise it is decoded to text.
 * - `responseHeaders`: the stacked edits, `{ set, remove }`.
 */
export async function runOp(scripts: OpScript[], op: BodyOp, args: any, env: OpEnv): Promise<any> {
    const url: string = args.url;
    const method: string = args.method;
    const callTab = typeof args.tabId === "number" && args.tabId >= 0 ? tabScope(args.tabId) : undefined;
    // "" means unknown (helper strategy, uncorrelated request): ctx says "other" and routes' `resourceTypes` aren't checked.
    const known: string | undefined = args.resourceType === undefined ? "xmlhttprequest" : args.resourceType || undefined;
    const resourceType: string = known ?? "other";
    const reqBody = requestBodyCtx(args.requestBody);
    // onRequest: what the earlier handlers' header edits made of the request headers
    let requestHeaders: Record<string, string> = args.requestHeaders || {};
    const replacedBy: { tweak: string; handler: string } | undefined = args.replacedBy;
    const base = (h: Routed) => ({
        url,
        method,
        tabUrl: args.tabUrl || url,
        resourceType,
        requestHeaders,
        groups: routeGroups(h.route, url),
        ...reqBody,
    });
    const ranOnMock = (s: OpScript, h: Routed) => {
        if (replacedBy && mockFlowThrottle(`${replacedBy.tweak}|${replacedBy.handler}|${s.id}|${h.route.kind}|${h.route.index}`)) env.log(s.id, "info", mockFlowLine(s.name, routeLabel(h.route), replacedBy, url));
    };
    const binaryBody = op === "transform" && args.body instanceof Uint8Array;
    const filter: OpFilter = { url, method, resourceType: known, tier: args.tier, onlyIds: args.onlyIds };
    const list = matching(scripts, op, op === "transform" ? { ...filter, binary: binaryBody } : filter, env);
    if (op === "transform") {
        // A script whose every matching route opted out of this kind of body: say so (no "never ran" warning).
        const ran = new Set(list.map((m) => m.s.id));
        const skipped = new Map<OpScript, Routed[]>();
        for (const { s, h } of matching(scripts, op, filter, { log: env.log })) if (!ran.has(s.id)) skipped.set(s, [...(skipped.get(s) || []), h]);
        for (const [s, handlers] of skipped) {
            if (handlers.every((h) => h.route.binary !== undefined)) env.log(s.id, "debug", kindSkipLine(s.name, url, binaryBody), "observed");
        }
    }
    const observed = (s: OpScript, handler: string, why?: string) => env.log(s.id, "debug", observedLine(s.name, handler, url, why), "observed");

    // A mock goes through the response handlers like a network response would, with ctx.replacedBy set.
    const flowMock = async (d: any, handler: string) => {
        const status: number = d.status || 200;
        const by = { tweak: d.scriptName as string, handler };
        const set: Record<string, string> = d.headers || {};
        let pairs: { name: string; value?: string }[] = [
            ...(Object.keys(set).some((k) => k.toLowerCase() === "content-type") ? [] : [{ name: "content-type", value: d.mime }]),
            ...Object.entries(set).map(([name, v]) => ({ name, value: String(v) })),
        ];
        const next = { ...args, requestHeaders, status, statusLine: `HTTP/1.1 ${status}`, replacedBy: by };
        const edits = await runOp(scripts, "responseHeaders", { ...next, responseHeaders: pairs }, env);
        if (edits) pairs = editPairs(pairs, edits);
        const ct = pairs.find((p) => p.name.toLowerCase() === "content-type")?.value;
        const body = await runOp(scripts, "transform", { ...next, responseHeaders: undefined, body: d.content, contentType: ct ?? d.mime }, env);
        const headers: Record<string, string> = {};
        for (const p of pairs) if (p.name.toLowerCase() !== "content-type") headers[p.name] = p.value ?? "";
        return {
            ...d,
            mime: ct ?? d.mime,
            content: body === null || body === undefined ? d.content : typeof body === "string" ? body : new TextDecoder().decode(body),
            headers: Object.keys(headers).length ? headers : undefined,
            replacedBy: by,
        };
    };

    if (op === "requestDecision") {
        const stack = new HeaderStack();
        type Decision = { who: Who & { outcome: RequestDecision }; h: Routed; result: any };
        let decision: Decision | null = null;
        for (const { s, h, layer } of list) {
            const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onRequest", index: h.route.index, layer };
            try {
                const single = singleRequestResult(await withPage(args.page, () => h.fn(base(h)), callTab));
                const result: any = single.result;
                if (!result) {
                    observed(s, "onRequest");
                    continue;
                }
                if (single.dropped.length && mixedThrottle(`${s.id}|${h.route.index}`)) {
                    env.log(s.id, "warn", mixedResultLine(s.name, routeLabel(h.route), single.kept!, single.dropped, url));
                }
                const outcome: RequestDecision | null = result.replaceResponse ? "replace" : result.redirect ? "redirect" : result.block === true ? "block" : result.allow === true ? "allow" : null;
                if (outcome) {
                    const next: Decision = { who: { ...who, outcome }, h, result };
                    if (outcome === "replace") {
                        const r = result.replaceResponse;
                        const { mime, content }: { mime: string; content: string | Uint8Array } = r.body instanceof Uint8Array && args.rawMock ? { mime: replacementBody({ ...r, body: "" }, url, resourceType).mime, content: r.body } : replacementBody(r, url, resourceType);
                        next.result = { kind: "respond", mime, content, status: r.status, headers: r.headers?.set, scriptId: s.id, scriptName: s.name, who };
                        env.log(s.id, "info", `[${s.name}] onRequest → replaceResponse ${r.status || 200} ${mime} (${content.length}b) ${url}`);
                    } else if (outcome === "redirect") {
                        next.result = { kind: "redirect", url: result.redirect, who };
                        env.log(s.id, "info", `[${s.name}] onRequest → redirect ${url} → ${result.redirect}`);
                    } else if (outcome === "block") {
                        next.result = { kind: "cancel", who };
                        env.log(s.id, "info", `[${s.name}] onRequest → block ${url}`);
                    } else if (decision) env.log(s.id, "info", `[${s.name}] onRequest → allow ${url}`);
                    else observed(s, "onRequest", "allow, and nothing to undo");
                    if (decision) {
                        const o = decision.who;
                        if (overruledThrottle(`${o.scriptId}|${o.index}|${s.id}|${h.route.index}`)) env.log(o.scriptId, "warn", overruledLine(o, next.who, url));
                    }
                    decision = outcome === "allow" ? null : next;
                    continue;
                }
                if (hasHeaderMods(result.headers)) {
                    const parts: string[] = [];
                    if (result.headers.set && Object.keys(result.headers.set).length) parts.push(`set ${Object.keys(result.headers.set).join(", ")}`);
                    if (result.headers.remove && result.headers.remove.length) parts.push(`remove ${result.headers.remove.join(", ")}`);
                    env.log(s.id, "info", `[${s.name}] onRequest → request headers (${parts.join("; ")}) ${url}`);
                    stackHeaders(stack, result.headers, who, "request", url, env);
                    requestHeaders = editRecord(requestHeaders, result.headers);
                } else observed(s, "onRequest");
            } catch (e: any) {
                env.log(s.id, "error", formatScriptError(s.name, e, "onRequest"));
            }
        }
        if (decision?.result.kind === "respond") {
            if (args.mockFlows !== false) return flowMock(decision.result, routeLabel(decision.h.route));
            return { ...decision.result, replacedBy: { tweak: decision.result.scriptName, handler: routeLabel(decision.h.route) }, ...(stack.empty ? {} : { changes: stack.result() }) };
        }
        // an earlier handler's request header edits still apply to the redirected request (webRequest keeps its requestId)
        if (decision) return stack.empty ? decision.result : { ...decision.result, changes: stack.result() };
        return stack.empty ? null : { kind: "headers", changes: stack.result() };
    }

    if (op === "responseHeaders") {
        const stack = new HeaderStack();
        // each handler sees the earlier ones' edits
        let responseHeaders: { name: string; value?: string }[] = args.responseHeaders || [];
        for (const { s, h, layer } of list) {
            const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onResponseHeaders", index: h.route.index, layer };
            try {
                ranOnMock(s, h);
                const result = await withPage(args.page, () => h.fn({ ...base(h), status: args.status, statusLine: args.statusLine || "", responseHeaders, ...(replacedBy ? { replacedBy } : {}) }), callTab);
                if (hasHeaderMods(result?.headers)) {
                    env.log(s.id, "info", `[${s.name}] onResponseHeaders → ${[Object.keys(result.headers.set || {}).length ? `set ${Object.keys(result.headers.set).join(", ")}` : "", result.headers.remove?.length ? `remove ${result.headers.remove.join(", ")}` : ""].filter(Boolean).join("; ")} ${url}`);
                    stackHeaders(stack, result.headers, who, "response", url, env);
                    responseHeaders = editPairs(responseHeaders, result.headers);
                } else observed(s, "onResponseHeaders");
            } catch (e: any) {
                env.log(s.id, "error", formatScriptError(s.name, e, "onResponseHeaders"));
            }
        }
        return stack.empty ? null : stack.result();
    }

    if (op === "transform") {
        let out: string | Uint8Array = args.body || "";
        let touched = false;
        for (const { s, h } of list) {
            try {
                // A text-only handler only ever sees text.
                if (out instanceof Uint8Array && !takesBinary(h.route)) out = new TextDecoder().decode(out);
                ranOnMock(s, h);
                const result: any = await withPage(args.page, () => h.fn({ ...base(h), contentType: args.contentType, status: args.status, ...(replacedBy ? { replacedBy } : {}) }, out), callTab);
                if (result !== undefined && result !== null) {
                    const before = typeof out === "string" ? out.length : out.byteLength;
                    const next = typeof result === "string" ? result : result instanceof Uint8Array ? result : JSON.stringify(result);
                    const after = typeof next === "string" ? next.length : next.byteLength;
                    out = next;
                    env.log(s.id, "info", `[${s.name}] onResponseBody applied (${before}b → ${after}b) ${url}`);
                    touched = true;
                } else observed(s, "onResponseBody");
            } catch (e: any) {
                env.log(s.id, "error", formatScriptError(s.name, e, "onResponseBody"));
            }
        }
        // Every handler returned nothing (void or null): no change, the strategy keeps the original bytes.
        if (!touched) return null;
        // A raw or binary body: bytes stay bytes.
        return typeof out === "string" || args.raw || binaryBody ? out : new TextDecoder().decode(out);
    }

    return null;
}
