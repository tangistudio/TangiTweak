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
 * - `requestDecision`: `tweak.onRequest` handlers in order. The first
 *   terminal result (`replaceResponse`, `redirect` or `block`) wins and ends
 *   the chain; header edits stack (the later handler wins per header).
 * - `replace`: `tweak.replaceResponse` handlers; the first non-null result
 *   wins.
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
import { effectiveStrategy, routeGroups, routeLabel, routeMatches, takesBinary, takesText, type Strategy } from "./route";
import type { Routed, ScriptHandlers } from "./compile";
import { kindSkipLine, observedLine, type NetKind } from "./netTypes";
import { HeaderStack, mixedResultLine, overrideLine, singleRequestResult, type Who } from "./precedence";
import { makeMissedThrottle } from "./missedTap";
import { requestBodyCtx } from "./requestBody";

/**
 * Which handler chain {@link runOp} runs: `requestDecision` (`onRequest`),
 * `replace` (`replaceResponse`), `transform` (`onResponseBody`) or
 * `responseHeaders` (`onResponseHeaders`).
 */
export type BodyOp = "requestDecision" | "transform" | "replace" | "responseHeaders";

/** A compiled script whose handlers {@link runOp} may run. */
export interface OpScript {
    /** The script's id: log lines and `who` results are attributed to it. */
    id: string;
    /** The script's name, used in log lines. */
    name: string;
    /** The handlers its compile collected (`CompiledScript.handlers`). */
    handlers: ScriptHandlers;
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
    replace: "replaceResponse",
    responseHeaders: "onResponseHeaders",
};

/** The handlers matching `f` for `op`, grouped per script, in script list order then registration order. */
function matching(scripts: OpScript[], op: BodyOp, f: OpFilter, env: OpEnv): { s: OpScript; handlers: Routed[] }[] {
    const kind = HANDLER_OF[op];
    const out: { s: OpScript; handlers: Routed[] }[] = [];
    for (const s of scripts) {
        if (f.onlyIds && !f.onlyIds.includes(s.id)) continue;
        const handlers = ((s.handlers as any)[kind] as Routed[] || []).filter((h) => handlerRuns(h, f));
        if (handlers.length) out.push({ s, handlers });
    }
    env.debug?.(`run ${op} ${f.url}${f.tier ? ` [${f.tier}]` : ""} → ${out.length} matching script(s) [${out.map((m) => m.s.name).join(", ")}]`);
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
 * (a string or `Uint8Array`), `contentType`, `status` and `raw`.
 *
 * @returns `null` when no handler changed anything. Otherwise, by op:
 * - `requestDecision`: `{ kind: "respond", mime, content, status, headers,
 *   scriptId, scriptName, who }`, `{ kind: "redirect", url, who }`,
 *   `{ kind: "cancel", who }` or `{ kind: "headers", changes }` with the
 *   stacked request header edits.
 * - `replace`: `{ mime, content, who }`.
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
    const base = (h: Routed) => ({
        url,
        method,
        tabUrl: args.tabUrl || url,
        resourceType,
        requestHeaders: args.requestHeaders || {},
        groups: routeGroups(h.route, url),
        ...reqBody,
    });
    const binaryBody = op === "transform" && args.body instanceof Uint8Array;
    const filter: OpFilter = { url, method, resourceType: known, tier: args.tier, onlyIds: args.onlyIds };
    const list = matching(scripts, op, op === "transform" ? { ...filter, binary: binaryBody } : filter, env);
    if (op === "transform") {
        // A script whose every matching route opted out of this kind of body: say so (no "never ran" warning).
        const ran = new Set(list.map((m) => m.s.id));
        for (const { s, handlers } of matching(scripts, op, filter, { log: env.log })) {
            if (!ran.has(s.id) && handlers.every((h) => h.route.binary !== undefined)) env.log(s.id, "debug", kindSkipLine(s.name, url, binaryBody), "observed");
        }
    }
    const observed = (s: OpScript, handler: string, why?: string) => env.log(s.id, "debug", observedLine(s.name, handler, url, why), "observed");

    if (op === "requestDecision") {
        const stack = new HeaderStack();
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onRequest", index: h.route.index };
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
                    if (result.replaceResponse) {
                        const r = result.replaceResponse;
                        const mime = r.mime || guessMimeFromUrl(url);
                        const content = serializeRespondBody(r.body);
                        env.log(s.id, "info", `[${s.name}] onRequest → replaceResponse ${r.status || 200} ${mime} (${content.length}b) ${url}`);
                        return { kind: "respond", mime, content, status: r.status, headers: r.headers?.set, scriptId: s.id, scriptName: s.name, who };
                    }
                    if (result.redirect) {
                        env.log(s.id, "info", `[${s.name}] onRequest → redirect ${url} → ${result.redirect}`);
                        return { kind: "redirect", url: result.redirect, who };
                    }
                    if (result.block) {
                        env.log(s.id, "info", `[${s.name}] onRequest → block ${url}`);
                        return { kind: "cancel", who };
                    }
                    if (hasHeaderMods(result.headers)) {
                        const parts: string[] = [];
                        if (result.headers.set && Object.keys(result.headers.set).length) parts.push(`set ${Object.keys(result.headers.set).join(", ")}`);
                        if (result.headers.remove && result.headers.remove.length) parts.push(`remove ${result.headers.remove.join(", ")}`);
                        env.log(s.id, "info", `[${s.name}] onRequest → request headers (${parts.join("; ")}) ${url}`);
                        stackHeaders(stack, result.headers, who, "request", url, env);
                    } else observed(s, "onRequest");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onRequest"));
                }
            }
        }
        return stack.empty ? null : { kind: "headers", changes: stack.result() };
    }

    if (op === "responseHeaders") {
        const stack = new HeaderStack();
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onResponseHeaders", index: h.route.index };
                try {
                    const result = await withPage(args.page, () => h.fn({ ...base(h), status: args.status, statusLine: args.statusLine || "", responseHeaders: args.responseHeaders || [] }), callTab);
                    if (hasHeaderMods(result?.headers)) {
                        env.log(s.id, "info", `[${s.name}] onResponseHeaders → ${Object.keys(result.headers.set || {}).length} set, ${(result.headers.remove || []).length} removed ${url}`);
                        stackHeaders(stack, result.headers, who, "response", url, env);
                    } else observed(s, "onResponseHeaders");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onResponseHeaders"));
                }
            }
        }
        return stack.empty ? null : stack.result();
    }

    if (op === "transform") {
        let out: string | Uint8Array = args.body || "";
        let touched = false;
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                try {
                    // A text-only handler only ever sees text.
                    if (out instanceof Uint8Array && !takesBinary(h.route)) out = new TextDecoder().decode(out);
                    const result: any = await withPage(args.page, () => h.fn({ ...base(h), contentType: args.contentType, status: args.status }, out), callTab);
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
        }
        // Every handler returned nothing (void or null): no change, the strategy keeps the original bytes.
        if (!touched) return null;
        // A raw or binary body: bytes stay bytes.
        return typeof out === "string" || args.raw || binaryBody ? out : new TextDecoder().decode(out);
    }

    if (op === "replace") {
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                try {
                    const out = await withPage(args.page, () => h.fn(base(h)), callTab);
                    if (out !== undefined && out !== null) {
                        const isFile = out && typeof out === "object" && typeof out.file === "string";
                        const { mime, content: body } = isFile ? resolveFileRef(out.file, url) : { mime: guessMimeFromUrl(url, TYPE_MIME[resourceType]), content: typeof out === "string" ? out : typeof out === "object" ? JSON.stringify(out) : String(out) };
                        env.log(s.id, "info", `[${s.name}] replaceResponse → ${mime} (${body.length}b) ${url}`);
                        return { mime, content: body, who: { scriptId: s.id, scriptName: s.name, kind: "replaceResponse", index: h.route.index } satisfies Who };
                    }
                    observed(s, "replaceResponse");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "replaceResponse"));
                }
            }
        }
        return null;
    }

    return null;
}
