/**
 * In-place navigation (pushState, back/forward, #hash) for onSite / onPage /
 * onOverlay handlers. A route with `navigation: "match" | "every"` is
 * re-checked on each URL change: its run starts when the URL starts
 * matching and ends when it stops ("every" also restarts it on each change
 * while it matches). `NavRoutes` keeps one script's such handlers in one
 * world, and the `ctx.onNavigate` listeners of its runs.
 */
import { followsNav, routeMatches, type DocumentWhen, type RouteMeta } from "./route";
import type { Exposer } from "./rpc";

export interface NavHandler {
    h: string;
    route: RouteMeta;
    when: DocumentWhen;
}

export interface NavSet<D extends NavHandler> {
    /** the compile's handlers (only those following navigation are kept) */
    dom: readonly D[];
    /** the URL now */
    url: string;
    /** run the matching ones now rather than at their `when` (a hot reload) */
    now?: boolean;
    /** start a run of `d` for `url` (replacing its live run, if any) */
    fire: (d: D, url: string) => void;
    /** end `d`'s live run: the URL stopped matching */
    stop: (d: D) => void;
    /** its handles: waiting while scheduled, `not running` while the URL doesn't match */
    exposer?: Exposer;
    /** run `run` at `when` (now, if that's passed or `now`) */
    schedule: (when: DocumentWhen, run: () => void, now: boolean) => void;
}

interface Item<D> {
    d: D;
    on: boolean;
    url: string;
    token: number;
}

export class NavRoutes<D extends NavHandler = NavHandler> {
    private items: Item<D>[] = [];
    private set_: NavSet<D> | null = null;
    private readonly listeners = new Set<(url: string) => void>();
    private url = "";
    private watching = false;

    /** `watch` starts watching the URL (once, when something needs it): it calls `nav` on changes */
    constructor(private readonly watch: () => void) {}

    /** a compile's handlers (replacing the last compile's): the matching ones are scheduled */
    set(s: NavSet<D>): void {
        for (const it of this.items) it.token++;
        this.set_ = s;
        this.url = s.url;
        this.items = s.dom.filter((d) => followsNav(d.route)).map((d) => ({ d, on: false, url: s.url, token: 0 }));
        if (this.items.length) this.startWatching();
        for (const it of this.items) {
            if (routeMatches(it.d.route, s.url)) this.start(it, s.url, !!s.now);
            else s.exposer?.fail(it.d.h);
        }
    }

    /** the URL changed in place */
    nav(url: string): void {
        if (url === this.url) return;
        this.url = url;
        const fns = [...this.listeners];
        const s = this.set_;
        if (s) {
            for (const it of this.items) {
                const m = routeMatches(it.d.route, url);
                if (m && (!it.on || (it.d.route.navigation === "every" && it.url !== url))) this.start(it, url, false);
                else if (!m && it.on) {
                    it.on = false;
                    it.token++;
                    s.stop(it.d);
                    s.exposer?.fail(it.d.h);
                }
            }
        }
        // listeners of runs that ended above are gone; ones added by runs started above see this URL already
        for (const fn of fns) if (this.listeners.has(fn)) fn(url);
    }

    /** `ctx.onNavigate` for a run whose signal is `signal` */
    onNavigate(signal: AbortSignal, report: (e: unknown) => void): (fn: (url: string) => void) => () => void {
        return (fn) => {
            if (typeof fn !== "function") throw new TypeError("ctx.onNavigate: the argument must be a function");
            if (signal.aborted) return () => {};
            this.startWatching();
            const call = (url: string) => {
                try {
                    fn(url);
                } catch (e) {
                    report(e);
                }
            };
            const off = () => {
                this.listeners.delete(call);
                signal.removeEventListener("abort", off);
            };
            this.listeners.add(call);
            signal.addEventListener("abort", off, { once: true });
            return off;
        };
    }

    private start(it: Item<D>, url: string, now: boolean): void {
        const s = this.set_!;
        it.on = true;
        it.url = url;
        const t = ++it.token;
        s.exposer?.register(it.d.h);
        s.schedule(it.d.when, () => t === it.token && s.fire(it.d, url), now);
    }

    private startWatching(): void {
        if (this.watching) return;
        this.watching = true;
        this.watch();
    }
}

const subs = new Set<(url: string) => void>();
let lastHref = "";
let urlWatched = false;

/** read location.href now (a nudge, e.g. from the hook's history patch): subscribers hear a change */
export function checkUrl(): void {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    for (const fn of [...subs]) fn(href);
}

/**
 * Call `fn` with the new URL on each in-place navigation of this frame:
 * popstate, hashchange and the Navigation API (pushState / replaceState,
 * from any world); without it, a poll.
 */
export function watchUrl(fn: (url: string) => void): () => void {
    subs.add(fn);
    if (!urlWatched) {
        urlWatched = true;
        lastHref = location.href;
        addEventListener("popstate", checkUrl);
        addEventListener("hashchange", checkUrl);
        const navigation = (globalThis as any).navigation;
        if (typeof navigation?.addEventListener === "function") navigation.addEventListener("currententrychange", checkUrl);
        else setInterval(checkUrl, 500);
    }
    return () => void subs.delete(fn);
}
