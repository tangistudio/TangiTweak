/**
 * Page strategy: a MAIN-world content script overrides
 * fetch/XHR and asks the background to run the hook-owned handlers for
 * page-initiated requests — onRequest decisions (mocks included) and
 * onResponseBody (streamed body). Banner-free. The page claims each request
 * it handles so the other strategies skip it.
 *
 * Only routes whose strategy is "page" run here; navigations, subresources,
 * workers and anything the page didn't fetch itself never reach this strategy.
 */
import { withOpPage } from "../pages";
import type { HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { runBodyOp } from "../../compileHost";
import type { RequestBody } from "../../../shared/requestBody";
import { ownsAny } from "./strategyScripts";

type Decision = { kind: "respond"; mime: string; content: string; status?: number; headers?: any; scriptId?: string; scriptName?: string } | { kind: "redirect"; url: string } | { kind: "cancel" } | { kind: "headers"; changes: any } | null;

export class PageStrategy implements InterceptionStrategy {
    readonly name = "page";

    /** plain script data for the sandbox RPCs (no local compilation) */
    private sandboxScripts: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    private params: { [scriptId: string]: Record<string, any> } = {};
    private hookOwners = 0;
    private claimedUrls = new Map<string, number>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        const owners = scripts.filter((s) => s.enabled && ownsAny(s, "page"));
        this.hookOwners = owners.length;
        // the background cannot compile: handlers execute in the sandbox, which
        // needs every enabled script (imports)
        this.sandboxScripts = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true, layers: s.layers }));
        this.params = paramValues || {};
    }

    /** does any enabled script own a hook route? */
    hasOwners(): boolean {
        return this.hookOwners > 0;
    }

    private async run(op: "requestDecision" | "transform", args: Record<string, any>, tabId: number): Promise<any> {
        const a = await withOpPage({ ...args, tabId, tier: "page", resourceType: "xmlhttprequest" }, tabId);
        return runBodyOp(this.sandboxScripts, this.params, op, a);
    }

    /** onRequest handlers ONCE: the last decision (replaceResponse | redirect | block; a mock already went through onResponseBody) or merged headers; null = none. */
    runRequestDecision(url: string, method: string, tabId = -1, requestBody?: RequestBody): Promise<Decision> {
        return this.run("requestDecision", { url, method, requestBody }, tabId);
    }

    /** chained onResponseBody over the body (async handlers awaited); requestId: its webRequest request, when known */
    runTransform(url: string, method: string, body: string | Uint8Array, extra?: { status?: number; contentType?: string; requestId?: string; requestBody?: RequestBody }, tabId = -1): Promise<string | Uint8Array | null> {
        return this.run("transform", { url, method, body, status: extra?.status, contentType: extra?.contentType, requestId: extra?.requestId, requestBody: extra?.requestBody }, tabId);
    }

    supportsBodyModification(): boolean {
        return true;
    }

    /** Called by the hook (via background messaging) to claim a request. */
    claimRequest(url: string): void {
        this.claimedUrls.set(url, Date.now());
        if (this.claimedUrls.size > 500) {
            const cutoff = Date.now() - 30_000;
            for (const [u, t] of this.claimedUrls) {
                if (t < cutoff) this.claimedUrls.delete(u);
            }
        }
    }

    isClaimed(url: string): boolean {
        const t = this.claimedUrls.get(url);
        return t !== undefined && Date.now() - t < 10_000;
    }

    forgetTab(_tabId: number): void {}

    handleBeforeRequest(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HookDisposition> {
        return { kind: "allow" }; // the hook runs in the page, not in webRequest
    }

    handleBeforeSendHeaders(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null;
    }

    handleHeadersReceived(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null;
    }

    dispose(): void {
        this.sandboxScripts = [];
        this.claimedUrls.clear();
    }
}
