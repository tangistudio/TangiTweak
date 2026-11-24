/**
 * Blocking-webRequest strategy: Firefox and MV2-capable Chromium browsers
 * (ungoogled-chromium, Brave, Opera…). Redirect/block, request/response
 * headers and a synchronous onRequest `replaceResponse` result work
 * everywhere with no debugger involvement.
 *
 * Runs only handler routes whose strategy is "extension".
 *
 * How a replacement (the onRequest `replaceResponse` result) is served:
 * - Firefox: in place — the request proceeds and filterResponseData swaps
 *   the body, so the URL is kept (the upstream status code is, too). The
 *   mock goes through onResponseHeaders and onResponseBody first, with
 *   `ctx.replacedBy` set.
 * - Chromium: webRequest can't touch bodies, so the only way is a redirect —
 *   to a data: URL, or for page loads to the extension's serve.html (the
 *   address bar shows the extension URL and the page loses its origin).
 *   Neither can carry a status: non-200 replacements aren't served here,
 *   and this layer's response handlers never see the mock.
 *
 * Response-body streaming (onResponseBody via filterResponseData) and
 * awaiting async handlers are Firefox-only. MV3 has no blocking webRequest
 * at all.
 */
import { withPage } from "../../../shared/currentPage";
import { tabScope } from "../../../shared/storeOps";
import { pages } from "../pages";
import { recordNetBody } from "../../network";
import { isThenable, type Routed } from "../../../shared/compile";
import { effectiveStrategy, indexRoutes, routeGroups, routeLabel, takesBinary, takesText, type RouteMeta } from "../../../shared/route";
import { formatScriptError } from "../../../shared/scriptError";
import type { HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log, logObserved, noteBodySkip, scriptError } from "../logs";
import { bodyKind } from "../../../shared/bodyKind";
import { kindSkipLine } from "../../../shared/netTypes";
import { dlogLevel } from "../../../shared/debugLog";
import { IS_FIREFOX } from "./helperState";
import { wsNotApplied } from "../../../shared/websocketLimits";
import { compileMv2, ownsAny } from "./strategyScripts";
import { HeaderStack, mergeHeaderEdits, mixedResultLine, mockFlowLine, overrideLine, overruledLine, singleRequestResult, type ReplacedBy, type RequestDecision, type Who, type Winner } from "../../../shared/precedence";
import { editPairs, editRecord, replacementBody } from "../../../shared/bodyOps";
import { makeMissedThrottle } from "../../../shared/missedTap";
import { reportSkipped } from "../skipped";
import { requestBodyCtx, requestBodyFromWebRequest, type RequestBody } from "../../../shared/requestBody";

/** the page a webRequest event is for (`tweak.pageStore`) */
const pageOf = (d: { tabId: number; type?: string; requestId: string; frameId?: number }) => pages.forRequest({ tabId: d.tabId, type: d.type, requestId: d.requestId, frameId: d.frameId, documentId: (d as any).documentId, documentLifecycle: (d as any).documentLifecycle });
const tabOf = (d: { tabId: number }) => (typeof d.tabId === "number" && d.tabId >= 0 ? tabScope(d.tabId) : null);

type Kind = "onRequest" | "onResponseHeaders" | "onResponseBody";

/** a script's webrequest-owned handlers (each with its route) */
interface Entry {
    id: string;
    name: string;
    handlers: Record<Kind, Routed[]>;
}

const KINDS: Kind[] = ["onRequest", "onResponseHeaders", "onResponseBody"];

/** what the onRequest handlers so far made of a request */
interface RequestState {
    /** the request headers with the earlier handlers' edits */
    headers: Record<string, string>;
    /** the last decision, or null (none, or an `allow` undid it) */
    decision: { who: Who & { outcome: RequestDecision }; entry: Entry; h: Routed; result: any } | null;
}

export class ExtensionStrategy implements InterceptionStrategy {
    readonly name = "extension";

    private entries: Entry[] = [];

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        // MV3: no blocking webRequest — the pipeline warns per handler (strategyUnavailable)
        if (__MV3__) {
            this.entries = [];
            return;
        }
        this.entries = compileMv2(scripts, paramValues, (s) => ownsAny(s, "extension")).map(({ id, name, compiled }) => {
            // a compile error is a problem (Problems view), not a Log line
            const handlers = {} as Record<Kind, Routed[]>;
            for (const k of KINDS) handlers[k] = compiled.handlers[k].filter((h) => effectiveStrategy(h.route) === "extension");
            dlogLevel("extension", "debug", `loaded "${name}" routes: ${KINDS.flatMap((k) => handlers[k].map((h) => `${routeLabel(h.route)} ${JSON.stringify(h.route.url)}`)).join(", ") || "none"}${compiled.error ? ` ERROR: ${compiled.error}` : ""}`);
            return { id, name, handlers };
        });
    }

    /** names of the scripts this strategy runs for `url` (diagnostics) */
    matchingNames(url: string): string[] {
        return this.entries.filter((e) => KINDS.some((k) => indexRoutes(e.handlers[k], (h) => h.route).some(url))).map((e) => e.name);
    }

    /** Free per-request caches (also called by the pipeline on error/complete). */
    pruneRequest(requestId: string): void {
        pendingFirefoxStreams.delete(requestId);
        pendingFirefoxReplace.delete(requestId);
        pendingRequestHeaderMods.delete(requestId);
        pendingRequestBodies.delete(requestId);
    }

    supportsBodyModification(): boolean {
        return IS_FIREFOX;
    }

    /** the entry's `kind` handlers whose route matches this request */
    private hits(e: Entry, kind: Kind, details: WebRequestDetailsLike): Routed[] {
        return indexRoutes(e.handlers[kind], (h) => h.route).match(details.url, details.method, details.type);
    }

    /**
     * Same order as every strategy (precedence.ts): every script's onRequest
     * runs and the last decision wins. Firefox awaits async handlers in
     * place and carries on with the rest.
     */
    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition> {
        const matched = this.entries.filter((e) => KINDS.some((k) => this.hits(e, k, details).length));
        if (!matched.length) return { kind: "allow" };
        rememberRequestBody(details);
        trace(details, `onBeforeRequest ${details.type} ${details.method} ${details.url} (tab url: ${tabUrl ?? "unknown"}) → scripts: ${matched.map((m) => `"${m.name}"`).join(", ")}`);
        const steps: { entry: Entry; h: Routed }[] = [];
        for (const entry of matched) for (const h of this.hits(entry, "onRequest", details)) steps.push({ entry, h });
        const state: RequestState = { headers: makeCtx(details, tabUrl).requestHeaders, decision: null };
        const run = (i: number): MaybePromise<HookDisposition> => {
            for (; i < steps.length; i++) {
                const step = steps[i];
                let result: any;
                try {
                    result = withPage(pageOf(details), () => step.h.fn({ ...ctxFor(details, tabUrl, step.h.route), requestHeaders: { ...state.headers } }), tabOf(details));
                } catch (e: any) {
                    scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onRequest"));
                    continue;
                }
                if (isThenable(result)) {
                    if (!IS_FIREFOX) {
                        // Chrome: blocking webRequest cannot await — the result would be decided too late
                        scriptError(step.entry.id, `async ${routeLabel(step.h.route)}: Chrome's blocking webRequest cannot await. Return synchronously, or set strategy: "debugger" or "helper" on this route.`);
                        continue;
                    }
                    // Firefox blocking listeners accept promises natively
                    const next = i + 1;
                    return Promise.resolve(result).then(
                        (r) => (this.decide(details, step, r, state), run(next)),
                        (e: any) => {
                            scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onRequest"));
                            return run(next);
                        }
                    );
                }
                this.decide(details, step, result, state);
            }
            return this.finish(details, tabUrl, matched, state);
        };
        return run(0);
    }

    /** Firefox: mark the request so the header-phase hook wires the onResponseBody stream filter */
    private queueStreams(details: WebRequestDetailsLike, tabUrl: string | null, matched: Entry[]): void {
        // (Chromium can't read bodies here — the pipeline warns at load.)
        if (!IS_FIREFOX) return;
        for (const entry of matched) {
            const transforms = this.hits(entry, "onResponseBody", details);
            if (!transforms.length) continue;
            const list = pendingFirefoxStreams.get(details.requestId)?.list ?? [];
            list.push({ id: entry.id, name: entry.name, handlers: transforms });
            pendingFirefoxStreams.set(details.requestId, { list, tabUrl });
        }
    }

    /** the last decision, served */
    private finish(details: WebRequestDetailsLike, tabUrl: string | null, matched: Entry[], state: RequestState): HookDisposition {
        const d = state.decision;
        const req = { url: details.url, method: details.method, type: details.type };
        if (!d) {
            this.queueStreams(details, tabUrl, matched);
            trace(details, `onBeforeRequest ${details.url} → allow (no final decision)`);
            return { kind: "allow" };
        }
        const w: Winner = { ...d.who, strategy: "extension", outcome: d.who.outcome as Winner["outcome"], target: d.who.outcome === "redirect" ? d.result.redirect : undefined };
        if (d.who.outcome !== "replace") {
            reportSkipped(details.tabId, req, w, details.requestId);
            return normalize(d.result);
        }
        const rep = d.result.replaceResponse;
        const status = rep.status ?? 200;
        if (status !== 200) {
            log(details.tabId, `[${d.entry.name}] onRequest → replaceResponse ${status} not served: webRequest can't set a response status (only 200). Set strategy: "debugger" or "helper" on this route ${details.url}`, "warn", d.entry.id, undefined, undefined, details.requestId);
            this.queueStreams(details, tabUrl, matched);
            return { kind: "allow" };
        }
        const { mime, content } = replacementContent(details, rep);
        const by: ReplacedBy = { tweak: d.entry.name, handler: routeLabel(d.h.route) };
        if (IS_FIREFOX) {
            this.queueStreams(details, tabUrl, matched);
            pendingFirefoxReplace.set(details.requestId, { content, mime, headers: rep.headers?.set, scriptId: d.entry.id, scriptName: d.entry.name, by });
            reportSkipped(details.tabId, req, w, details.requestId);
            return { kind: "allow" };
        }
        if (details.type === "websocket") {
            log(details.tabId, `[${d.entry.name}] onRequest → ${wsNotApplied("replaceResponse", "extension", details.url)}`, "warn", d.entry.id, undefined, undefined, details.requestId);
            return { kind: "allow" };
        }
        reportSkipped(details.tabId, req, w, details.requestId, { mockFlows: false });
        return this.redirectServe(details, content, mime);
    }

    /** one handler's result: updates the decision and the request header edits */
    private decide(details: WebRequestDetailsLike, step: { entry: Entry; h: Routed }, result: any, state: RequestState): void {
        const { entry, h } = step;
        const who: Who = { scriptId: entry.id, scriptName: entry.name, kind: "onRequest", index: h.route.index };
        const single = singleRequestResult(result);
        if (single.dropped.length && overrideThrottle(`mixed|${entry.id}|${h.route.index}`)) {
            log(details.tabId, mixedResultLine(entry.name, routeLabel(h.route), single.kept!, single.dropped, details.url), "warn", entry.id, undefined, undefined, details.requestId);
        }
        result = single.result;
        const say = (msg: string) => log(details.tabId, `[${entry.name}] onRequest → ${msg}`, "info", entry.id, undefined, undefined, details.requestId);
        if (result && result.redirect && !result.block && details.type === "websocket" && !IS_FIREFOX) {
            log(details.tabId, `[${entry.name}] onRequest → ${wsNotApplied("redirect", "extension", details.url, result.redirect)}`, "warn", entry.id, undefined, undefined, details.requestId);
            return;
        }
        const outcome: RequestDecision | null = !result ? null : result.replaceResponse ? "replace" : result.redirect ? "redirect" : result.block === true ? "block" : result.allow === true ? "allow" : null;
        if (outcome) {
            if (outcome === "replace") {
                const rep = result.replaceResponse;
                const { mime, content } = replacementContent(details, rep);
                say(`replaceResponse ${rep.status ?? 200} ${mime} (${content.length}b) ${details.url}`);
            } else if (outcome === "redirect") say(`redirect ${details.url} → ${result.redirect}`);
            else if (outcome === "block") say(`block ${details.url}`);
            else if (state.decision) say(`allow ${details.url}`);
            else logObserved(details.tabId, entry.name, "onRequest", details.url, entry.id, details.requestId);
            const next = { who: { ...who, outcome }, entry, h, result };
            const o = state.decision?.who;
            if (o && overrideThrottle(`over|${o.scriptId}|${o.index}|${entry.id}|${h.route.index}`)) {
                log(details.tabId, overruledLine(o, next.who, details.url), "warn", o.scriptId, undefined, undefined, details.requestId);
            }
            state.decision = outcome === "allow" ? null : next;
            return;
        }
        if (result && result.headers && (result.headers.set || result.headers.remove)) {
            say(`request headers (${describeHeaderMods(result.headers)}) ${details.url}`);
            // cached so onBeforeSendHeaders doesn't re-run the handler; the later handler wins per header
            const stack = pendingRequestHeaderMods.get(details.requestId) ?? new HeaderStack();
            for (const o of stack.add(result.headers, who)) {
                if (overrideThrottle(`${o.header}|${o.by.scriptId}|${o.by.index}|${o.over.scriptId}|${o.over.index}`)) log(details.tabId, overrideLine(o, "request", details.url), "warn", entry.id, undefined, undefined, details.requestId);
            }
            pendingRequestHeaderMods.set(details.requestId, stack);
            state.headers = editRecord(state.headers, result.headers);
            return;
        }
        trace(details, `[${entry.name}] onRequest returned ${describeResult(result)} (no redirect/block/replaceResponse) for ${details.url}`);
        logObserved(details.tabId, entry.name, "onRequest", details.url, entry.id, details.requestId);
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, _tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        // request-phase header mods were computed once in handleBeforeRequest
        const cached = pendingRequestHeaderMods.get(details.requestId);
        return cached && !cached.empty ? cached.result() : null;
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        const pending = pendingFirefoxStreams.get(details.requestId);
        // Firefox in-place replacement: the mock goes through the response handlers, then replaces the body
        const rep = pendingFirefoxReplace.get(details.requestId);
        if (rep && IS_FIREFOX && !isRedirectStatus(details.statusCode)) {
            pendingFirefoxReplace.delete(details.requestId);
            pendingFirefoxStreams.delete(details.requestId);
            const own = rep.headers ? { set: rep.headers } : undefined;
            const mockHeaders = editPairs([{ name: "Content-Type", value: rep.mime }], own || {});
            const mock = { ...details, statusCode: 200, statusLine: "HTTP/1.1 200 OK", responseHeaders: mockHeaders };
            const serve = (changes: HeaderChanges | null): HeaderChanges => {
                const all = own ? mergeHeaderEdits(own, changes || {}) : changes;
                const ct = Object.entries(all?.set || {}).find(([n]) => n.toLowerCase() === "content-type")?.[1];
                const mime = ct ?? rep.mime;
                this.wireFirefoxReplace(mock, { ...rep, mime }, pending?.list ?? [], pending?.tabUrl ?? tabUrl);
                return mergeReplacementHeaders(all, replacementHeaders(mime, rep.content));
            };
            const changes = this.responseHeaderChanges(mock, tabUrl, rep.by);
            return isThenable(changes) ? Promise.resolve(changes).then(serve) : serve(changes);
        }
        const changes = this.responseHeaderChanges(details, tabUrl);
        // Firefox streaming: wire the filter when response headers arrive.
        if (pending && IS_FIREFOX && !isRedirectStatus(details.statusCode)) {
            pendingFirefoxStreams.delete(details.requestId);
            // a binary Content-Type with no `binary: true` route: don't buffer it at all
            const ct = contentTypeOf(details.responseHeaders) || "";
            const binaryOk = pending.list.some((e) => e.handlers.some((h) => takesBinary(h.route)));
            if (bodyKind(ct, null) === "binary" && !binaryOk) {
                noteBodySkip("extension", details.url, "binary", ct, details.requestId);
                trace(details, `binary body (${ct}), no binary: true route — onResponseBody skipped ${details.url}`);
            } else this.wireFirefoxStream(details, pending.list, pending.tabUrl ?? tabUrl);
        }
        return changes;
    }

    dispose(): void {
        this.entries = [];
    }

    /**
     * Chromium only: webRequest can't write a body, so the replacement is
     * served by redirecting — the URL changes (see the header comment).
     */
    private redirectServe(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string): HookDisposition {
        recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200, requestId: details.requestId });
        // Chrome blocks top-level data: navigations — serve main frames from an extension page instead
        if (details.type === "main_frame") {
            const rid = "serve_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            serveStore.set(rid, { content: typeof content === "string" ? content : new TextDecoder().decode(content), mime });
            return { kind: "redirect", url: chrome.runtime.getURL("serve.html?rid=" + rid) };
        }
        return { kind: "redirect", url: toDataUrl(mime, content) };
    }

    /** Firefox: the upstream body is never read; the mock, after the onResponseBody handlers, is written once */
    private wireFirefoxReplace(details: WebRequestDetailsLike, rep: FirefoxReplacement, list: StreamEntry[], tabUrl: string | null): void {
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
            filter.ondata = () => {};
            filter.onstart = async () => {
                const binary = rep.content instanceof Uint8Array;
                const { body, modified } = list.length ? await this.runBodyHandlers(details, list, tabUrl, rep.content, rep.mime, binary, rep.by) : { body: rep.content, modified: false };
                filter.write(typeof body === "string" ? new TextEncoder().encode(body) : body);
                filter.close();
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: body, mime: rep.mime, status: 200, requestId: details.requestId });
                if (modified) trace(details, `mock from [${rep.scriptName}] changed by onResponseBody ${details.url}`);
            };
        } catch (e: any) {
            scriptError(rep.scriptId, formatScriptError(rep.scriptName, e, "filterResponseData"));
        }
    }

    /** onResponseHeaders in list order; the later handler wins per header and sees the earlier edits. Firefox awaits async ones in place. */
    private responseHeaderChanges(details: WebRequestDetailsLike, tabUrl: string | null, replacedBy?: ReplacedBy): MaybePromise<HeaderChanges | null> {
        const steps: { entry: Entry; h: Routed }[] = [];
        for (const entry of this.entries) for (const h of this.hits(entry, "onResponseHeaders", details)) steps.push({ entry, h });
        if (!steps.length) return null;
        const stack = new HeaderStack();
        let seen: { name: string; value?: string }[] = details.responseHeaders || [];
        const apply = ({ entry, h }: { entry: Entry; h: Routed }, result: any) => {
            const mods = result?.headers;
            if (!(mods && (mods.set || mods.remove))) return logObserved(details.tabId, entry.name, "onResponseHeaders", details.url, entry.id, details.requestId);
            log(details.tabId, `[${entry.name}] onResponseHeaders → ${describeHeaderMods(mods)} ${details.url}`, "info", entry.id, undefined, undefined, details.requestId);
            for (const o of stack.add(mods, { scriptId: entry.id, scriptName: entry.name, kind: "onResponseHeaders", index: h.route.index })) {
                if (overrideThrottle(`r|${o.header}|${o.by.scriptId}|${o.by.index}|${o.over.scriptId}|${o.over.index}`)) log(details.tabId, overrideLine(o, "response", details.url), "warn", entry.id, undefined, undefined, details.requestId);
            }
            seen = editPairs(seen, mods);
        };
        const done = (): HeaderChanges | null => (stack.empty ? null : stack.result());
        const run = (i: number): MaybePromise<HeaderChanges | null> => {
            for (; i < steps.length; i++) {
                const step = steps[i];
                let result: any;
                try {
                    const ctx = ctxFor(details, tabUrl, step.h.route);
                    (ctx as any).statusLine = details.statusLine || "";
                    (ctx as any).responseHeaders = seen.map((p) => ({ ...p }));
                    if (replacedBy) {
                        ctx.replacedBy = replacedBy;
                        ranOnMock(details, step.entry, step.h, replacedBy);
                    }
                    result = withPage(pageOf(details), () => step.h.fn(ctx), tabOf(details));
                } catch (e: any) {
                    scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onResponseHeaders"));
                    continue;
                }
                if (isThenable(result)) {
                    if (!IS_FIREFOX) {
                        scriptError(step.entry.id, `async ${routeLabel(step.h.route)}: Chrome's blocking webRequest cannot await. Return synchronously, or set strategy: "debugger" or "helper" on this route.`);
                        continue;
                    }
                    const next = i + 1;
                    return Promise.resolve(result).then(
                        (r) => (apply(step, r), run(next)),
                        (e: any) => (scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onResponseHeaders")), run(next))
                    );
                }
                apply(step, result);
            }
            return done();
        };
        return run(0);
    }

    private wireFirefoxStream(details: WebRequestDetailsLike, list: StreamEntry[], tabUrl: string | null): void {
        const first = list[0];
        // onstop may come after onCompleted pruned the cache
        const requestBody = pendingRequestBodies.get(details.requestId);
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
            const decoder = new TextDecoder("utf-8");
            const encoder = new TextEncoder();
            const chunks: Uint8Array[] = [];
            filter.ondata = (e: { data: ArrayBuffer }) => {
                chunks.push(new Uint8Array(e.data));
            };
            filter.onstop = async () => {
                const total = chunks.reduce((n, c) => n + c.length, 0);
                const bytes = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    bytes.set(c, off);
                    off += c.length;
                }
                // text → string; binary → bytes, to `binary: true` routes only
                const contentType = contentTypeOf(details.responseHeaders);
                const binary = bodyKind(contentType, bytes) === "binary";
                const original: string | Uint8Array = binary ? bytes : decoder.decode(bytes);
                const { body, modified } = await this.runBodyHandlers(details, list, tabUrl, original, contentType, binary, undefined, requestBody);
                // no change: the original bytes (a decode/encode round trip drops a BOM)
                const outBytes = !modified ? bytes : typeof body === "string" ? encoder.encode(body) : body;
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, original, modified: modified ? body : null, requestId: details.requestId });
                filter.write(outBytes);
                filter.close();
            };
        } catch (e: any) {
            scriptError(first.id, formatScriptError(first.name, e, "filterResponseData"));
        }
    }

    /** onResponseBody handlers in list order, each on the previous one's output (a void / null result: no change) */
    private async runBodyHandlers(details: WebRequestDetailsLike, list: StreamEntry[], tabUrl: string | null, body: string | Uint8Array, contentType: string | undefined, binary: boolean, replacedBy?: ReplacedBy, requestBody = pendingRequestBodies.get(details.requestId)): Promise<{ body: string | Uint8Array; modified: boolean }> {
        const decoder = new TextDecoder("utf-8");
        const page = pageOf(details);
        const tab = tabOf(details);
        let modified = false;
        if (binary && !list.some((e) => e.handlers.some((h) => takesBinary(h.route)))) noteBodySkip("extension", details.url, "binary", contentType || "", details.requestId);
        for (const entry of list) {
            const { id: scriptId, name: scriptName, handlers } = entry;
            const runs = handlers.filter((h) => (binary ? takesBinary(h.route) : takesText(h.route)));
            // every route opted out of this kind of body: say so (no "never ran" warning)
            if (!runs.length && handlers.every((h) => h.route.binary !== undefined)) log(details.tabId, kindSkipLine(scriptName, details.url, binary), "debug", scriptId, "observed", undefined, details.requestId);
            for (const h of runs) {
                const ctx: any = { ...ctxFor(details, tabUrl, h.route, requestBody), contentType };
                if (replacedBy) {
                    ctx.replacedBy = replacedBy;
                    ranOnMock(details, entry, h, replacedBy);
                }
                // a text body an earlier binary route returned as bytes is still text here
                if (typeof body !== "string" && !takesBinary(h.route)) body = decoder.decode(body);
                try {
                    const out = await withPage(page, () => h.fn(ctx, body), tab);
                    if (out !== undefined && out !== null) {
                        const size = (b: any) => (typeof b === "string" ? b.length : (b?.byteLength ?? 0));
                        log(details.tabId, `[${scriptName}] onResponseBody applied (${size(body)}b → ${size(out)}b) ${details.url}`, "info", scriptId, undefined, undefined, details.requestId);
                        body = out;
                        modified = true;
                    } else logObserved(details.tabId, scriptName, "onResponseBody", details.url, scriptId, details.requestId);
                } catch (e: any) {
                    scriptError(scriptId, formatScriptError(scriptName, e, "onResponseBody"));
                }
            }
        }
        return { body, modified };
    }
}

const mockFlowThrottle = makeMissedThrottle();

/** INFO once per mock and response handler pair: the handler ran on a mock */
function ranOnMock(details: WebRequestDetailsLike, entry: { id: string; name: string }, h: Routed, by: ReplacedBy): void {
    if (mockFlowThrottle(`${by.tweak}|${by.handler}|${entry.id}|${h.route.kind}|${h.route.index}`)) log(details.tabId, mockFlowLine(entry.name, routeLabel(h.route), by, details.url), "info", entry.id, undefined, undefined, details.requestId);
}

// ---- shared helpers ----

/** request-level diagnostics: visible in the LOG panel at logLevel: debug */
function trace(details: WebRequestDetailsLike, msg: string): void {
    log(details.tabId, `[extension] ${msg}`, "debug");
}

function describeResult(r: any): string {
    if (r === undefined) return "undefined";
    if (r === null) return "null";
    try {
        const json = JSON.stringify(r);
        return json.length > 200 ? json.slice(0, 197) + "..." : json;
    } catch {
        return String(r);
    }
}

function describeHeaderMods(m: { set?: Record<string, string>; remove?: string[] }): string {
    const parts: string[] = [];
    if (m.set && Object.keys(m.set).length) parts.push(`set ${Object.keys(m.set).join(", ")}`);
    if (m.remove?.length) parts.push(`remove ${m.remove.join(", ")}`);
    return parts.join("; ");
}

export function makeCtx(details: WebRequestDetailsLike, tabUrl: string | null): any {
    const headers: { [n: string]: string } = {};
    for (const h of details.requestHeaders || []) {
        headers[h.name.toLowerCase()] = h.value || "";
    }
    return {
        url: details.url,
        method: details.method,
        tabUrl: tabUrl || "",
        resourceType: details.type,
        requestHeaders: headers,
    };
}

/** ctx for a matched route: + `groups` (named URL-pattern captures) */
function ctxFor(details: WebRequestDetailsLike, tabUrl: string | null, route: RouteMeta, requestBody = pendingRequestBodies.get(details.requestId)): any {
    return { ...makeCtx(details, tabUrl), groups: routeGroups(route, details.url), ...requestBodyCtx(requestBody) };
}

/** only onBeforeRequest carries the body: keep it for the later stages */
function rememberRequestBody(details: WebRequestDetailsLike): void {
    const body = requestBodyFromWebRequest(details.requestBody);
    if (body === undefined) return;
    pendingRequestBodies.set(details.requestId, body);
    if (pendingRequestBodies.size > 200) pendingRequestBodies.delete(pendingRequestBodies.keys().next().value!);
}

export function normalize(result: any): HookDisposition {
    if (result.replaceResponse) return { kind: "respond", serve: result.replaceResponse } as any;
    if (result.block) return { kind: "cancel" };
    if (result.redirect) return { kind: "redirect", url: result.redirect };
    if (result.headers) return { kind: "headers", changes: result.headers };
    return { kind: "allow" };
}

export function toDataUrl(mime: string, content: string | Uint8Array): string {
    if (typeof content === "string") {
        return "data:" + mime + ";charset=UTF-8," + encodeURIComponent(content);
    }
    let bin = "";
    for (let i = 0; i < content.length; i++) bin += String.fromCharCode(content[i]);
    return "data:" + mime + ";base64," + btoa(bin);
}

function contentTypeOf(headers: { name: string; value?: string }[] | undefined): string | undefined {
    const h = headers?.find((x) => x.name.toLowerCase() === "content-type");
    return h?.value;
}

/** in-memory store for main-frame served replacements */
export const serveStore = new Map<string, { content: string; mime: string }>();

/** Merge stacked header mods: the later edit wins per header (set or remove). */
export function mergeHeaderMods(base: HeaderChanges | undefined, add: HeaderChanges): HeaderChanges {
    return mergeHeaderEdits(base, add);
}

const overrideThrottle = makeMissedThrottle();

interface FirefoxReplacement {
    content: string | Uint8Array;
    mime: string;
    /** the result's `headers.set` */
    headers?: Record<string, string>;
    scriptId: string;
    scriptName: string;
    by: ReplacedBy;
}

/** requestId → a replacement body Firefox writes in place at onHeadersReceived */
const pendingFirefoxReplace = new Map<string, FirefoxReplacement>();

/** the mime + body an onRequest `replaceResponse` result serves (bytes stay bytes) */
export function replacementContent(details: { url: string; type?: string }, rep: any): { mime: string; content: string | Uint8Array } {
    if (rep?.body instanceof Uint8Array) return { mime: replacementBody({ ...rep, body: "" }, details.url, details.type || "").mime, content: rep.body };
    return replacementBody(rep ?? {}, details.url, details.type || "");
}

function isRedirectStatus(status: number | undefined): boolean {
    return status !== undefined && status >= 300 && status < 400 && status !== 304;
}

/**
 * Response headers for an in-place replacement: the new type, and none that
 * describe the upstream bytes (length, encoding, digests, ranges).
 */
export function replacementHeaders(mime: string, content: string | Uint8Array): HeaderChanges {
    const type = typeof content === "string" && !/charset=/i.test(mime) && /^(text\/|application\/(json|javascript|xml)|image\/svg)/i.test(mime) ? `${mime}; charset=utf-8` : mime;
    return {
        set: { "Content-Type": type },
        remove: ["Content-Length", "Content-Encoding", "Content-MD5", "Content-Range", "Digest", "Repr-Digest", "Content-Digest", "ETag"],
    };
}

/** script header changes first, the replacement's own headers win */
function mergeReplacementHeaders(changes: HeaderChanges | null, fix: HeaderChanges): HeaderChanges {
    const removeFix = new Set((fix.remove || []).map((n) => n.toLowerCase()));
    const set = Object.fromEntries(Object.entries(changes?.set || {}).filter(([n]) => !removeFix.has(n.toLowerCase()) && n.toLowerCase() !== "content-type"));
    return { set: { ...set, ...fix.set }, remove: [...(changes?.remove || []), ...(fix.remove || [])] };
}

interface StreamEntry {
    id: string;
    name: string;
    handlers: Routed[];
}

/** requestId → the onResponseBody handlers awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, { list: StreamEntry[]; tabUrl: string | null }>();

/** requestId → request header mods already computed by onRequest (issue: run once) */
const pendingRequestHeaderMods = new Map<string, HeaderStack>();

/** requestId → ctx.requestBody, from onBeforeRequest */
const pendingRequestBodies = new Map<string, RequestBody>();
