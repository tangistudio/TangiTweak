/**
 * The `tweak` a script sees when its page handlers compile in the site's
 * JavaScript world (hook.ts: `tweak.onSite` handlers; bridge.ts: the same
 * when the page CSP forbids eval there) or the isolated world (bridge.ts in
 * MV2, isolated.ts in MV3: `tweak.onPage` handlers). Network
 * registrations and overlay handlers are inert here (they run in the
 * background / the overlay); this world's handlers are collected with
 * their routes (the other world's are skipped), and params resolve to the
 * raw values the background shipped in the bundle (each def's `parse`
 * runs here, in the page).
 *
 * Each onSite / onPage / onOverlay registration is a handle named by its
 * route's `key` (`"onPage:0"`, shared/rpc.ts). With an `exposer`, this
 * world's handlers expose what they return (`firePageHandler`). In the
 * isolated world a handle calls its handler wherever it runs (`call`); in
 * the site's world no handle can be called (siteRemote), and the stores
 * aren't there.
 */
import { isDebuggerSafeOverlay, normalizeRoute, placeKeyer, placeKind, routeMatches, type DocumentWhen, type PageWorld, type PlaceApi, type RouteMeta } from "./route";
import { inertRemote, LIB_SITE_STORE, siteRemote, SITE_NO_STORES, unusableStore, type SiteCannotCallError } from "./remote";
import type { Exposer } from "./rpc";
import { fromWireResponse, splitFetchInit, toWireRequest, type WtFetchInit } from "./ttFetch";
import type { WireRequest, WireResponse } from "./wire";
import type { Generation, ScriptLife } from "./runLifecycle";
import { isParamDef, isParamGroup, type ParamTree } from "./scriptDef";
import { libBodyRunning } from "./scriptImports";
import { paramsProxy, PARAM_AT_TOP, PARAM_NOT_HERE, PARAM_ON_SITE } from "./paramsProxy";
import { scriptEnv } from "./scriptEnv";
import { claimStoreName, storePersist } from "./storeOps";
import { toastCaller, TOAST_AT_TOP, type ToastResult, type ToastSpec } from "./toast";
import { removedReplaceResponse, storeRun, tweakHost, tweakStores, type NamedStores, type StoreRun, type TweakHost } from "./tweakApi";

export interface PageDocumentHandler {
    /** its RPC handle id: the route's key (`"onPage:0"`) */
    h: string;
    route: RouteMeta;
    when: DocumentWhen;
    fn: (ctx: any) => any;
}

export interface PageShimOptions {
    /** resolved RAW param values (from the bundle) */
    params: Record<string, any>;
    /** `tweak.log` (`source`) */
    log: (source: string, ...args: any[]) => void;
    storage: { get(key: string): any; set(key: string, value: any): any };
    /** which handlers this shim collects: "page" (tweak.onSite, the default) or "isolated" (tweak.onPage) */
    world?: PageWorld;
    /** answers calls into this world's handles */
    exposer?: Exposer;
    /**
     * isolated world: a handle → what calls it (`api`: where its handler
     * runs, `route`: its route); absent: handles are inert (a library's)
     */
    call?: (api: PlaceApi, key: string, route: RouteMeta) => any;
    /** site's world: a handle's function was called (it throws SiteCannotCallError; its stack is the caller's) */
    onSiteCall?: (e: SiteCannotCallError) => void;
    /** the script's store replicas (`tweak.pageStore`: this page's copy): the isolated world only */
    stores?: PageStores;
    /** `tweak.siteStore`: the site's world's store (onSite code) or a mirror of it (absent: a library's, which throws when used) */
    siteStore?: (name: string, initial: object) => object;
    /**
     * a library's shim (its name): what its code registers while a
     * script's top level runs (`top`) — a function it exports, called by
     * the script — is the script's; its own top level's isn't
     */
    lib?: string;
    /**
     * a param the code assigned (`cfg.on = false`), to be saved — `lib`:
     * a library's (this shim's `lib`). Absent: params can't change here
     * (onSite code never can).
     */
    setParam?: (key: string, value: any, lib?: string) => Promise<void>;
    /** `tweak.fetch` in onPage code: the background fetches, to the tweak's `"tangitweak.connect"` hosts only (absent: it rejects) */
    fetch?: (request: WireRequest, bypass: boolean) => Promise<WireResponse>;
    /** `tweak.toast` in onPage code: the background's toast center shows it (absent: it rejects; onSite code never has it) */
    toast?: (spec: ToastSpec) => Promise<ToastResult>;
    /** isolated world (top frame only): also collect `onOverlay({ debuggerSafe: true })` handlers to mount in a closed shadow root */
    debuggerSafeOverlays?: boolean;
}

/** onPage's `tweak.fetch`: from the background (relative URLs resolve against the page) */
const pageTweakFetch =
    (f: NonNullable<PageShimOptions["fetch"]>) =>
    async (input: RequestInfo | URL, init?: WtFetchInit): Promise<Response> => {
        const { init: rest, from, bypass } = splitFetchInit(init);
        if (from === "page") throw new Error(`tweak.fetch: from: "page" fetches as the page, which only an overlay (tweak.onOverlay) can do — onPage code uses the page's own fetch for that`);
        return fromWireResponse(await f(await toWireRequest(input, rest, location.href), bypass));
    };

type Register = (api: PlaceApi) => (route: unknown, fn: unknown, lib?: string) => any;
/** the script whose top level is running (PageShim.top): where libraries' registrations and unnamed stores go */
let running: { register: Register; run: StoreRun } | null = null;

export interface PageStores {
    store(name: string, initial: object, persist: boolean | string[]): object;
    tabStore(name: string, initial: object): object;
    pageStore(name: string, initial: object): object;
}

const noStore = unusableStore(SITE_NO_STORES);
const libSiteStore = unusableStore(LIB_SITE_STORE);
const NO_TOAST = "tweak.toast isn't available in onSite code (the page's own scripts could use it); call it from onPage code";
const NO_FETCH = "tweak.fetch isn't available in onSite code (the page's own scripts could use it) — fetch from onPage code, or use the page's fetch";
/** a library's handles: its handlers don't run */
const LIB_HANDLE = "handles from an imported library don't connect; register the handler in the script itself";

export interface PageShim {
    /** what the script's code runs with (scriptFunction) */
    host: TweakHost;
    dom: PageDocumentHandler[];
    /** opt-in `onOverlay({ debuggerSafe: true })` handlers collected in the isolated world */
    shadowOverlays: PageDocumentHandler[];
    /** run the script's top level (`run`): libraries' functions it calls register into it, like the background's */
    top<T>(run: () => T): T;
}

export function makePageShim(o: PageShimOptions): PageShim {
    const dom: PageDocumentHandler[] = [];
    const shadowOverlays: PageDocumentHandler[] = [];
    const world = o.world || "page";
    const mine: PlaceApi = world === "page" ? "onSite" : "onPage";
    const inert = () => {};
    // handlers: numbered by registration order, like the background's
    const keyOf = placeKeyer();
    // registrations always count, so indexes match the background's
    let pageIndex = 0;
    let overlayIndex = 0;
    const own: Register = (api) => (route, fn, lib) => {
        if (typeof fn !== "function") throw new Error(`tweak.${api}: second argument must be the handler function`);
        const kind = placeKind(api);
        const r = normalizeRoute(kind, route, kind === "onOverlay" ? overlayIndex++ : pageIndex++, api);
        const k = keyOf(api, lib);
        r.key = k.key;
        if (lib !== undefined) {
            r.lib = lib;
            r.n = k.n;
        } else if (api !== "onOverlay" && k.n !== r.index) r.n = k.n;
        if (api === mine) {
            o.exposer?.register(k.key);
            dom.push({ h: k.key, route: r, when: r.when || "document_end", fn: fn as any });
        } else if (world === "isolated" && o.debuggerSafeOverlays && isDebuggerSafeOverlay(r)) {
            o.exposer?.register(k.key);
            shadowOverlays.push({ h: k.key, route: r, when: r.when || "document_end", fn: fn as any });
        }
        if (world === "page") return siteRemote(o.onSiteCall);
        return o.call ? o.call(api, k.key, r) : inertHandle();
    };
    // a library's code run by a script's top level: the script's (not the library's own top level)
    const callerRun = () => (o.lib !== undefined && running && !libBodyRunning() ? running : undefined);
    const register = (api: PlaceApi) => (route: unknown, fn: unknown) => {
        const c = callerRun();
        return c ? c.register(api)(route, fn, o.lib) : own(api)(route, fn);
    };
    const stores = world === "isolated" ? o.stores : undefined;
    const names = new Map<string, string>();
    const siteNames = new Map<string, string>();
    // without stores, declaring one at top level is fine (that code runs here too); using it isn't
    const named: NamedStores = {
        globalStore: (name, initial, opts) => {
            if (!stores) return noStore;
            claimStoreName(names, `tweak.globalStore`, name, initial);
            names.set(name, `tweak.globalStore`);
            return stores.store(name, initial, storePersist(name, opts, `tweak.globalStore`));
        },
        tabStore: (name, initial) => {
            if (!stores) return noStore;
            claimStoreName(names, `tweak.tabStore`, name, initial);
            names.set(name, `tweak.tabStore`);
            return stores.tabStore(name, initial);
        },
        pageStore: (name, initial) => {
            if (!stores) return noStore;
            claimStoreName(names, `tweak.pageStore`, name, initial);
            names.set(name, `tweak.pageStore`);
            return stores.pageStore(name, initial);
        },
        siteStore: (name, initial) => {
            if (!o.siteStore) return libSiteStore;
            claimStoreName(siteNames, `tweak.siteStore`, name, initial);
            siteNames.set(name, `tweak.siteStore`);
            return o.siteStore(name, initial);
        },
    };
    const self = { register: own, run: storeRun(named) };
    const host = tweakHost((file) => ({
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: removedReplaceResponse,
        onResponseBody: inert,
        fetch: o.fetch ? pageTweakFetch(o.fetch) : () => Promise.reject(new Error(NO_FETCH)),
        // background-only registrations: the background's compile collects them
        every: inert,
        onToastAction: inert,
        toastPane: inert,
        toastStyle: inert,
        toast: toastCaller({
            send: world === "page" ? undefined : o.toast,
            blocked: () => (world === "page" ? NO_TOAST : running || libBodyRunning() ? TOAST_AT_TOP : undefined),
            defaultWhere: "this",
        }),
        onSite: register("onSite"),
        onPage: register("onPage"),
        onOverlay: register("onOverlay"),
        site: register("site"),
        params: (defs: ParamTree) => {
            const split = (obj: Record<string, any>): { known: ParamTree; unknown: Record<string, any> } => {
                const known: ParamTree = {};
                const unknown: Record<string, any> = {};
                for (const [k, d] of Object.entries(obj || {})) {
                    if (isParamDef(d)) known[k] = d;
                    else if (isParamGroup(d)) {
                        const sub = split(d);
                        known[k] = sub.known;
                        if (Object.keys(sub.unknown).length) unknown[k] = sub.unknown;
                    } else unknown[k] = o.params?.[k];
                }
                return { known, unknown };
            };
            const { known, unknown } = split(defs || {});
            return paramsProxy(known, o.params, unknown, {
                blocked: () => (world === "page" ? PARAM_ON_SITE : running || libBodyRunning() ? PARAM_AT_TOP : o.setParam ? undefined : PARAM_NOT_HERE),
                send: (k, v) => void o.setParam!(k, v, o.lib).catch(() => {}),
            });
        },
        log: (...args: any[]) => o.log("tweak.log", ...args),
        storage: o.storage,
        ...scriptEnv(),
        ...tweakStores(file, self.run, () => callerRun()?.run),
    }));
    const top = <T>(run: () => T): T => {
        const prev = running;
        running = self;
        try {
            return run();
        } finally {
            running = prev;
        }
    };
    return { host, dom, shadowOverlays, top };
}

function inertHandle(): any {
    return inertRemote(LIB_HANDLE);
}

/** the handlers whose route matches this frame's URL (the others' handles answer `not running`) */
export function domHandlersFor(dom: PageDocumentHandler[], url: string, exposer?: Exposer): PageDocumentHandler[] {
    return dom.filter((h) => {
        const on = routeMatches(h.route, url);
        if (!on) exposer?.fail(h.h);
        return on;
    });
}

/**
 * Run a handler; what it returns is what its handle exposes. A throw is
 * rethrown, and the handle answers from the previous run when there's one
 * still alive (a failed reload), else `not running`.
 */
export function firePageHandler(d: PageDocumentHandler, ctx: any, exposer?: Exposer, onError?: (e: unknown) => void): unknown {
    let out: unknown;
    try {
        out = d.fn(ctx);
    } catch (e) {
        exposer?.revert(d.h);
        throw e;
    }
    if (out && typeof (out as any).then === "function") {
        // an async handler's rejection: an error like a thrown one
        if (onError) (out as Promise<unknown>).then(undefined, onError);
        // a run that ended before its promise settled (replaced, navigated away) exposes nothing
        const signal: AbortSignal | undefined = ctx?.signal;
        if (signal) {
            exposer?.expose(
                d.h,
                (out as Promise<unknown>).then(
                    (v) => (signal.aborted ? new Promise(() => {}) : v),
                    (e) => (signal.aborted ? new Promise(() => {}) : Promise.reject(e))
                )
            );
            return out;
        }
    }
    exposer?.expose(d.h, out);
    return out;
}

/** run `run` at the handler's `when` (immediately when `now`) */
export function scheduleDocument(when: DocumentWhen, run: () => void, now = false): void {
    if (now || when === "document_start") run();
    else if (when === "document_idle") {
        if (document.readyState === "complete") run();
        else window.addEventListener("load", run, { once: true });
    } else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else run();
}

/** the ctx every page handler starts from */
export const pageCtxBase = (url: string) => ({ url, method: "GET", tabUrl: url, resourceType: "main_frame", requestHeaders: {}, groups: {} });

/** run handler `d` as a run of `gen` (shared/runLifecycle.ts): its ctx gets signal, once, patch, style, mount, each */
export function fireRun(life: ScriptLife, gen: Generation, d: PageDocumentHandler, base: object | ((signal: AbortSignal) => object), exposer: Exposer | undefined, report: (e: unknown) => void): void {
    life.fire(
        gen,
        d.h,
        report,
        (ctx, quiet) => {
            const b = typeof base === "function" ? base(ctx.signal) : base;
            const merged = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(b), ...Object.getOwnPropertyDescriptors(ctx) });
            return firePageHandler(d, merged, exposer, quiet);
        },
        d.route
    );
}
