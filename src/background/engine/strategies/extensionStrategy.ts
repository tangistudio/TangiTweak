/**
 * Blocking-webRequest strategy (Firefox): redirect/block, request and
 * response headers, onRequest `replaceResponse` and onResponseBody, with no
 * debugger involvement. Chrome MV3 has no blocking webRequest, so the
 * strategy runs nothing there.
 *
 * Runs only handler routes whose strategy is "extension". Matching the
 * request is synchronous (most requests match nothing and go on at once);
 * the handlers run where scripts compile: the sandbox (MV3,
 * compileHost.runBodyOp) or in process (unit tests), both through runOp.
 *
 * A replacement (the onRequest `replaceResponse` result) is served in
 * place: the request proceeds and filterResponseData swaps the body, so the
 * URL is kept (the upstream status code is, too). The mock goes through
 * onResponseHeaders and onResponseBody first, with `ctx.replacedBy` set.
 * Firefox's blocking listeners take promises, so handlers may be async.
 */
import { pages } from "../pages";
import { recordNetBody } from "../../network";
import { indexRoutes, routeLabel, takesBinary } from "../../../shared/route";
import type { HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log, noteBodySkip, scriptError } from "../logs";
import { bodyKind } from "../../../shared/bodyKind";
import { dlogLevel } from "../../../shared/debugLog";
import { compileMv2, ownedRoutes, ownsAny, type OwnedRoute } from "./strategyScripts";
import { mergeHeaderEdits, winnerOf, type ReplacedBy } from "../../../shared/precedence";
import { editPairs, replacementBody, runOp, type BodyOp, type OpScript } from "../../../shared/bodyOps";
import { reportSkipped } from "../skipped";
import { requestBodyFromWebRequest, type RequestBody } from "../../../shared/requestBody";
import { runBodyOp } from "../../compileHost";
import { formatScriptError } from "../../../shared/scriptError";

/** the page a webRequest event is for (`tweak.pageStore`) */
const pageOf = (d: { tabId: number; type?: string; requestId: string; frameId?: number }) => pages.forRequest({ tabId: d.tabId, type: d.type, requestId: d.requestId, frameId: d.frameId, documentId: (d as any).documentId, documentLifecycle: (d as any).documentLifecycle });

type Kind = "onRequest" | "onResponseHeaders" | "onResponseBody";

export class ExtensionStrategy implements InterceptionStrategy {
    readonly name = "extension";

    /** the enabled scripts' extension-owned request routes */
    private owned: OwnedRoute[] = [];
    /** in process: the compiled scripts runOp runs */
    private ops: OpScript[] = [];
    /** MV3: what the sandbox compiles and runs */
    private plain: { id: string; name: string; code: string; updatedAt: number; enabled: boolean; layers?: Script["layers"] }[] = [];
    private params: { [scriptId: string]: Record<string, any> } = {};

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        // Chrome MV3: no blocking webRequest — the pipeline warns per handler (strategyUnavailable)
        if (__MV3__ && !__FIREFOX__) {
            this.owned = [];
            return;
        }
        this.owned = ownedRoutes(scripts, "extension");
        if (__MV3__) {
            this.plain = scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: s.enabled, layers: s.layers }));
            this.params = paramValues || {};
        } else {
            this.ops = compileMv2(scripts, paramValues, (s) => ownsAny(s, "extension")).map((c) => ({ id: c.id, name: c.name, handlers: c.compiled.handlers, layers: c.layers }));
        }
        dlogLevel("extension", "debug", `loaded routes: ${this.owned.map((o) => `"${o.name}" ${routeLabel(o.route)} ${JSON.stringify(o.route.url)}`).join(", ") || "none"}`);
    }

    /** names of the scripts this strategy runs for `url` (diagnostics) */
    matchingNames(url: string): string[] {
        return [...new Set(indexRoutes(this.owned, (o) => o.route).match(url).map((o) => o.name))];
    }

    /** Free per-request caches (also called by the pipeline on error/complete). */
    pruneRequest(requestId: string): void {
        pendingFirefoxStreams.delete(requestId);
        pendingFirefoxReplace.delete(requestId);
        pendingRequestHeaderMods.delete(requestId);
        pendingRequestBodies.delete(requestId);
    }

    supportsBodyModification(): boolean {
        return true;
    }

    /** this request's owned routes (of `kind`, when given) */
    private hits(details: { url: string; method?: string; type?: string }, kind?: Kind): OwnedRoute[] {
        const all = indexRoutes(this.owned, (o) => o.route).match(details.url, details.method, details.type);
        return kind ? all.filter((o) => o.route.kind === kind) : all;
    }

    /** one op's handler chain, for this request */
    private async run(op: BodyOp, details: WebRequestDetailsLike, tabUrl: string | null, extra: Record<string, any> = {}, requestBody = pendingRequestBodies.get(details.requestId)): Promise<any> {
        const args = { url: details.url, method: details.method, tabId: details.tabId, resourceType: details.type, tabUrl: tabUrl || "", requestHeaders: requestHeadersOf(details), requestId: details.requestId, requestBody, page: pageOf(details), tier: "extension", ...extra };
        if (__MV3__) return runBodyOp(this.plain, this.params, op, args);
        return runOp(this.ops, op, args, { log: (scriptId, level, msg, kind) => log(details.tabId, msg, level, scriptId, kind, undefined, details.requestId) });
    }

    /**
     * Same order as every strategy (precedence.ts): every script's onRequest
     * runs and the last decision wins.
     */
    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition> {
        const matched = this.hits(details);
        if (!matched.length) return { kind: "allow" };
        rememberRequestBody(details);
        trace(details, `onBeforeRequest ${details.type} ${details.method} ${details.url} (tab url: ${tabUrl ?? "unknown"}) → scripts: ${[...new Set(matched.map((m) => `"${m.name}"`))].join(", ")}`);
        if (!matched.some((o) => o.route.kind === "onRequest")) return this.finish(details, tabUrl, null);
        return this.run("requestDecision", details, tabUrl, { mockFlows: false, rawMock: true }).then(
            (d) => this.finish(details, tabUrl, d),
            (e: any) => {
                dlogLevel("extension", "error", `onRequest failed for ${details.url}: ${e?.message || e}`);
                return this.finish(details, tabUrl, null);
            }
        );
    }

    /** mark the request so the header-phase hook wires the onResponseBody stream filter */
    private queueStreams(details: WebRequestDetailsLike, tabUrl: string | null): void {
        const routes = this.hits(details, "onResponseBody");
        if (routes.length) pendingFirefoxStreams.set(details.requestId, { routes, tabUrl });
    }

    /** the last decision, served */
    private finish(details: WebRequestDetailsLike, tabUrl: string | null, d: any): HookDisposition {
        const req = { url: details.url, method: details.method, type: details.type };
        // cached so onBeforeSendHeaders doesn't re-run the handlers
        if (d?.changes) pendingRequestHeaderMods.set(details.requestId, d.changes);
        if (d?.kind === "headers") d = null;
        if (!d) {
            this.queueStreams(details, tabUrl);
            trace(details, `onBeforeRequest ${details.url} → allow (no final decision)`);
            return { kind: "allow" };
        }
        if (d.kind === "redirect" || d.kind === "cancel") {
            reportSkipped(details.tabId, req, winnerOf(d, "extension"), details.requestId);
            return d.kind === "redirect" ? { kind: "redirect", url: d.url } : { kind: "cancel" };
        }
        const status = d.status ?? 200;
        if (status !== 200) {
            log(details.tabId, `[${d.scriptName}] onRequest → replaceResponse ${status} not served: webRequest can't set a response status (only 200). Set strategy: "debugger" or "helper" on this route ${details.url}`, "warn", d.scriptId, undefined, undefined, details.requestId);
            this.queueStreams(details, tabUrl);
            return { kind: "allow" };
        }
        this.queueStreams(details, tabUrl);
        pendingFirefoxReplace.set(details.requestId, { content: d.content, mime: d.mime, headers: d.headers, scriptId: d.scriptId, scriptName: d.scriptName, by: d.replacedBy });
        reportSkipped(details.tabId, req, winnerOf(d, "extension"), details.requestId);
        return { kind: "allow" };
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, _tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        // request-phase header mods were computed once in handleBeforeRequest
        return pendingRequestHeaderMods.get(details.requestId) ?? null;
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        const pending = pendingFirefoxStreams.get(details.requestId);
        // in-place replacement: the mock goes through the response handlers, then replaces the body
        const rep = pendingFirefoxReplace.get(details.requestId);
        if (rep && !isRedirectStatus(details.statusCode)) {
            pendingFirefoxReplace.delete(details.requestId);
            pendingFirefoxStreams.delete(details.requestId);
            const own = rep.headers ? { set: rep.headers } : undefined;
            const mockHeaders = editPairs([{ name: "Content-Type", value: rep.mime }], own || {});
            const mock = { ...details, statusCode: 200, statusLine: "HTTP/1.1 200 OK", responseHeaders: mockHeaders };
            const serve = (changes: HeaderChanges | null): HeaderChanges => {
                const all = own ? mergeHeaderEdits(own, changes || {}) : changes;
                const ct = Object.entries(all?.set || {}).find(([n]) => n.toLowerCase() === "content-type")?.[1];
                const mime = ct ?? rep.mime;
                this.wireFirefoxReplace(mock, { ...rep, mime }, !!pending, pending?.tabUrl ?? tabUrl);
                return mergeReplacementHeaders(all, replacementHeaders(mime, rep.content));
            };
            const changes = this.responseHeaderChanges(mock, tabUrl, rep.by);
            return changes ? changes.then(serve) : serve(null);
        }
        const changes = this.responseHeaderChanges(details, tabUrl);
        // streaming: wire the filter when response headers arrive
        if (pending && !isRedirectStatus(details.statusCode)) {
            pendingFirefoxStreams.delete(details.requestId);
            // a binary Content-Type with no `binary: true` route: don't buffer it at all
            const ct = contentTypeOf(details.responseHeaders) || "";
            if (bodyKind(ct, null) === "binary" && !pending.routes.some((o) => takesBinary(o.route))) {
                noteBodySkip("extension", details.url, "binary", ct, details.requestId);
                trace(details, `binary body (${ct}), no binary: true route — onResponseBody skipped ${details.url}`);
            } else this.wireFirefoxStream(details, pending.routes, pending.tabUrl ?? tabUrl);
        }
        return changes;
    }

    dispose(): void {
        this.owned = [];
        this.ops = [];
        this.plain = [];
    }

    /** onResponseHeaders, when one matches: null (synchronously) when none does */
    private responseHeaderChanges(details: WebRequestDetailsLike, tabUrl: string | null, replacedBy?: ReplacedBy): Promise<HeaderChanges | null> | null {
        if (!this.hits(details, "onResponseHeaders").length) return null;
        return this.run("responseHeaders", details, tabUrl, { status: details.statusCode, statusLine: details.statusLine || "", responseHeaders: details.responseHeaders || [], ...(replacedBy ? { replacedBy } : {}) }).catch((e: any) => {
            dlogLevel("extension", "error", `onResponseHeaders failed for ${details.url}: ${e?.message || e}`);
            return null;
        });
    }

    /** onResponseBody on `body`: the new body, or null (no change) */
    private async transform(details: WebRequestDetailsLike, tabUrl: string | null, body: string | Uint8Array, contentType: string | undefined, extra: Record<string, any>, requestBody?: RequestBody): Promise<string | Uint8Array | null> {
        try {
            return (await this.run("transform", details, tabUrl, { body, contentType, status: details.statusCode, ...extra }, requestBody)) ?? null;
        } catch (e: any) {
            dlogLevel("extension", "error", `onResponseBody failed for ${details.url}: ${e?.message || e}`);
            return null;
        }
    }

    /** the upstream body is never read; the mock, after the onResponseBody handlers, is written once */
    private wireFirefoxReplace(details: WebRequestDetailsLike, rep: FirefoxReplacement, transform: boolean, tabUrl: string | null): void {
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
            filter.ondata = () => {};
            filter.onstart = async () => {
                const out = transform ? await this.transform(details, tabUrl, rep.content, rep.mime, { replacedBy: rep.by, raw: rep.content instanceof Uint8Array }) : null;
                const body = out ?? rep.content;
                filter.write(typeof body === "string" ? new TextEncoder().encode(body) : body);
                filter.close();
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: body, mime: rep.mime, status: 200, requestId: details.requestId });
                if (out !== null) trace(details, `mock from [${rep.scriptName}] changed by onResponseBody ${details.url}`);
            };
        } catch (e: any) {
            scriptError(rep.scriptId, formatScriptError(rep.scriptName, e, "filterResponseData"));
        }
    }

    private wireFirefoxStream(details: WebRequestDetailsLike, routes: OwnedRoute[], tabUrl: string | null): void {
        // onstop may come after onCompleted pruned the cache
        const requestBody = pendingRequestBodies.get(details.requestId);
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
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
                if (binary && !routes.some((o) => takesBinary(o.route))) noteBodySkip("extension", details.url, "binary", contentType || "", details.requestId);
                const original: string | Uint8Array = binary ? bytes : new TextDecoder("utf-8").decode(bytes);
                const out = await this.transform(details, tabUrl, original, contentType, {}, requestBody);
                // no change: the original bytes (a decode/encode round trip drops a BOM)
                filter.write(out === null ? bytes : typeof out === "string" ? new TextEncoder().encode(out) : out);
                filter.close();
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, original, modified: out, requestId: details.requestId });
            };
        } catch (e: any) {
            scriptError(routes[0].id, formatScriptError(routes[0].name, e, "filterResponseData"));
        }
    }
}

// ---- shared helpers ----

/** request-level diagnostics: visible in the LOG panel at logLevel: debug */
function trace(details: WebRequestDetailsLike, msg: string): void {
    log(details.tabId, `[extension] ${msg}`, "debug");
}

/** the request headers, lowercased (ctx.requestHeaders) */
function requestHeadersOf(details: WebRequestDetailsLike): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const h of details.requestHeaders || []) headers[h.name.toLowerCase()] = h.value || "";
    return headers;
}

/** only onBeforeRequest carries the body: keep it for the later stages */
function rememberRequestBody(details: WebRequestDetailsLike): void {
    const body = requestBodyFromWebRequest(details.requestBody);
    if (body === undefined) return;
    pendingRequestBodies.set(details.requestId, body);
    if (pendingRequestBodies.size > 200) pendingRequestBodies.delete(pendingRequestBodies.keys().next().value!);
}

function contentTypeOf(headers: { name: string; value?: string }[] | undefined): string | undefined {
    const h = headers?.find((x) => x.name.toLowerCase() === "content-type");
    return h?.value;
}

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

/** requestId → the onResponseBody handlers awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, { routes: OwnedRoute[]; tabUrl: string | null }>();

/** requestId → request header mods already computed by onRequest (issue: run once) */
const pendingRequestHeaderMods = new Map<string, HeaderChanges>();

/** requestId → ctx.requestBody, from onBeforeRequest */
const pendingRequestBodies = new Map<string, RequestBody>();
