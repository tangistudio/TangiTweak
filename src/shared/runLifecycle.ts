/**
 * A script's run lifecycle in one frame (docs/scripting.md, "Hot reload";
 * GLOSSARY: Run, Claim, Trampoline).
 *
 * Each compile of the script is a generation; each handler invocation is a
 * Run with its own `ctx.signal`. What a run sets up through `ctx.once`,
 * `ctx.patch`, `ctx.style` and `ctx.mount` is a claim on a key. On reload
 * the new run starts first; when it returns, the old run's signal aborts,
 * and once the new run settles (its promise too) the old run's claims are
 * released: keys the new run claimed again stay (a mount re-renders, a
 * patch swaps its implementation), the rest are torn down. A new run that
 * throws ends alone: the old one keeps running.
 *
 * A generation's handles (`Remote`s) call with its signal: it aborts once
 * a newer compile replaced it and none of its runs is alive.
 */
import { AbortError } from "./rpc";
import { hookSignature, notHot } from "./hotRefresh";
import { HOST_ATTR, checkSelector, findElements, followIframes, type FrameEnd, type Watch, watch } from "./domElements";

export interface ReactDomClient {
    createRoot(el: Element): { render(node: unknown): void; unmount(): void };
    /** React's, for a render-function `ui` */
    createElement?(type: any, props: any): unknown;
}

/** a script's `react-dom/client` and `createElement`, as its React (or Preact) is */
export function reactOf(require: (spec: string) => any): ReactDomClient {
    const dom = require("react-dom/client");
    return { createRoot: (el) => dom.createRoot(el), createElement: require("react").createElement };
}

export interface LifeOptions {
    doc: Document;
    /** `react-dom/client` for `ctx.mount` (throws when React isn't loaded); absent: no `ctx.mount` (onSite) */
    react?: () => ReactDomClient;
    /** mount hosts get a closed shadow root (default true; the overlay frame is isolated already) */
    shadow?: boolean;
    /** a teardown, or a ctx.mount that followed the page (a new match, autoRestore), failed */
    onError?: (e: unknown) => void;
    /** what `ctx.iframes` adds to an iframe's ctx (onPage: `f.shortcut`, listening in that iframe) */
    frameCtx?: (doc: Document, signal: AbortSignal) => object;
    /** offer `ctx.iframes` (default true; the overlay has no page iframes to follow) */
    iframes?: boolean;
}

/** what a run adds to its handler's ctx */
export interface RunCtx {
    signal: AbortSignal;
    once<T>(key: string, fn: () => T): T;
    patch(obj: object, prop: PropertyKey, wrap: (orig: any) => any): void;
    style(css: string): void;
    mount?: (a: unknown, b?: unknown, c?: unknown) => () => void;
    each<A extends any[], T>(fn: (...args: A) => Promise<T>, ...args: A): AsyncIterableIterator<T>;
    iframes?: (a: unknown, b?: unknown, c?: unknown) => () => void;
    elements(selector: unknown, b?: unknown, c?: unknown): any;
}

/** what `ctx.iframes` passes its `fn` for one iframe: a run in the iframe's document */
export interface IframeCtx extends RunCtx {
    iframe: HTMLIFrameElement;
    document: Document;
    window: Window;
}

export interface Generation {
    readonly signal: AbortSignal;
}

interface Gen extends Generation {
    ctl: AbortController;
    runs: Set<Run>;
    /** handlers this generation tried to run (a throw included: the old run is kept on purpose) */
    tried: Set<string>;
    ended: boolean;
    readonly signal: AbortSignal;
}

interface Run {
    h: string;
    gen: Gen;
    ctl: AbortController;
    claims: Set<string>;
    released: boolean;
    /** the run's setup is done (it returned, settled, or started a ctx.each loop): the previous run's leftovers go */
    settle?: () => void;
    /** ctx.each was called before the handler returned */
    looping?: boolean;
    /** reports the run's async errors (ctx.iframes runs its fn later, for new iframes) */
    report: (e: unknown) => void;
}

interface Owner {
    claimers: Set<Run>;
    teardown(): void;
}

interface Trampoline {
    fn: (...args: any[]) => any;
    orig: (...args: any[]) => any;
    impl: (...args: any[]) => any;
    n: number;
}

export type MountPosition = "inside-last" | "inside-first" | "before" | "after" | "overlay";
const POSITIONS: readonly MountPosition[] = ["inside-last", "inside-first", "before", "after", "overlay"];

/** one root of a ctx.mount: at one anchor (or floating) */
interface Slot {
    /** where it goes (null: floating) */
    anchor: Element | null;
    host: Element;
    container: Element;
    root: { render(node: unknown): void; unmount(): void };
    /** ctx.style copies in its shadow root */
    styleEls: Element[];
    /** it made its overlay anchor `position: relative` */
    positioned?: Element;
}

/** a ctx.mount key's owner: its UI on every anchor */
interface MountOwner extends Owner {
    /** what was asked for */
    target: string | Element | undefined;
    pos: MountPosition;
    /** one root, moving to the current match (`first`, an element, floating) */
    single: boolean;
    autoRestore: boolean;
    ui: unknown;
    client: ReactDomClient;
    /** renders a render-function `ui` (stable, so its state stays across saves) */
    Fn: (p: { anchor?: Element }) => unknown;
    slots: Map<Element | null, Slot>;
    /** look inside shadow roots for anchors */
    shadow: boolean;
    /** follows the page: a selector's matches, or (autoRestore) the page removing the UI */
    watch?: Watch;
    /** autoRestore re-insertions in the last second (a page fighting back) */
    restores: number[];
    restoreOff?: boolean;
}

/** one iframe document a ctx.iframes runs in: it gets its own runs and claims */
interface FrameSlot {
    el: HTMLIFrameElement;
    doc: Document;
    life: ScriptLife;
}

/** a ctx.iframes key's owner: its fn in every matching same-origin iframe */
interface IframesOwner extends Owner {
    fn: (f: IframeCtx) => unknown;
    report: (e: unknown) => void;
    frames: Set<FrameSlot>;
    stop: () => void;
}

/** a ctx.elements(selector, fn) key's owner: fn on each match while it matches */
interface ElementsOwner extends Owner {
    selector: string;
    first: boolean;
    fn: (el: Element, signal: AbortSignal) => unknown;
    report: (e: unknown) => void;
    active: Map<Element, { ctl: AbortController; cleanup?: () => void }>;
    watch: Watch;
}
/** autoRestore gives up after this many re-insertions in a second */
const MAX_RESTORES = 20;

const isAbort = (e: any) => e?.name === "AbortError";

/** FNV-1a, for style keys */
function hash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ":" + s.length;
}

export class ScriptLife {
    private readonly owners = new Map<string, Owner>();
    private readonly current = new Map<string, Run>();
    private readonly gens = new Set<Gen>();
    private latest: Gen | null = null;
    private readonly tramps = new WeakMap<object, Map<string, Trampoline>>();
    private trampN = 0;
    /** ctx.style elements, mirrored into each mount's shadow root */
    private readonly styles = new Map<string, { css: string; els: Element[] }>();
    private readonly slots = new Set<Slot>();
    /** element targets of ctx.mount: a stable id each, so a mount there keeps its key */
    private readonly targetIds = new WeakMap<object, number>();
    /** overlay anchors made `position: relative`: by how many mounts, and their own inline position */
    private readonly positioned = new WeakMap<Element, { n: number; prev: string }>();
    private nextTargetId = 0;
    private stopped = false;

    constructor(private readonly o: LifeOptions) {}

    /** a new compile; the previous one ends once none of its runs is alive */
    begin(): Generation {
        const ctl = new AbortController();
        const g: Gen = { ctl, runs: new Set(), tried: new Set(), ended: false, signal: ctl.signal };
        if (this.stopped) {
            g.ended = true;
            ctl.abort(new AbortError("the script stopped"));
        }
        this.gens.add(g);
        this.latest = g;
        return g;
    }

    /** the compile failed: the previous generation stays the live one */
    discard(gen: Generation): void {
        const g = gen as Gen;
        this.endGen(g, "the script didn't compile");
        if (this.latest === g) this.latest = [...this.gens].pop() ?? null;
    }

    /**
     * Run handler `h` of `gen`: `body` gets the ctx members and a reporter
     * for its async errors (aborts after the run ended are quiet). A sync
     * throw ends the new run alone and is rethrown.
     */
    fire(gen: Generation, h: string, report: (e: unknown) => void, body: (ctx: RunCtx, report: (e: unknown) => void) => unknown): void {
        const g = gen as Gen;
        // a handler scheduled by a generation that was replaced since
        if (g.ended || g !== this.latest) return;
        g.tried.add(h);
        const quiet = (e: unknown) => {
            if (!(run.ctl.signal.aborted && isAbort(e))) report(e);
        };
        const run: Run = { h, gen: g, ctl: new AbortController(), claims: new Set(), released: false, report: quiet };
        g.runs.add(run);
        let out: unknown;
        try {
            out = body(this.ctxFor(run), quiet);
        } catch (e) {
            this.end(run, "the handler threw");
            this.release(run);
            throw e;
        }
        const old = this.current.get(h);
        this.current.set(h, run);
        if (!old) return;
        this.end(old, "the script reloaded");
        const release = () => {
            run.settle = undefined;
            this.release(old);
        };
        if (out && typeof (out as any).then === "function" && !run.looping) {
            // a handler that ends in a ctx.each loop never settles: starting the loop counts
            run.settle = release;
            (out as Promise<unknown>).then(release, release);
        } else release();
    }

    /** `gen` fired its due handlers: old runs of handlers it no longer has (or that don't match) end */
    commit(gen: Generation): void {
        const g = gen as Gen;
        if (g !== this.latest) return;
        for (const [h, run] of [...this.current])
            if (run.gen !== g && !g.tried.has(h)) {
                this.current.delete(h);
                this.end(run, "the script reloaded");
                this.release(run);
            }
        this.sweep();
    }

    /** the script stopped here (disabled, deleted, no longer matches): every run ends, every claim is torn down */
    stop(why = "the script stopped"): void {
        this.stopped = true;
        for (const run of [...this.current.values()]) {
            this.end(run, why);
            this.release(run);
        }
        this.current.clear();
        for (const g of [...this.gens]) this.endGen(g, why);
        for (const [k, o] of [...this.owners]) {
            this.owners.delete(k);
            this.teardown(o);
        }
    }

    /** the live run of handler `h` (tests) */
    runOf(h: string): { signal: AbortSignal } | undefined {
        const r = this.current.get(h);
        return r && { signal: r.ctl.signal };
    }

    /** live `ctx.mount` slots — gives tests access to containers inside closed shadow roots */
    mountSlots(): { anchor: Element | null; host: Element; container: Element }[] {
        return [...this.slots].map(({ anchor, host, container }) => ({ anchor, host, container }));
    }

    private end(run: Run, why: string): void {
        if (!run.ctl.signal.aborted) run.ctl.abort(new AbortError(why));
        this.sweep();
    }

    /** a replaced generation with no live run ends: its handles' pending calls abort */
    private sweep(): void {
        for (const g of [...this.gens]) {
            if (g === this.latest) continue;
            if ([...g.runs].every((r) => r.ctl.signal.aborted)) this.endGen(g, "the script reloaded");
        }
    }

    private endGen(g: Gen, why: string): void {
        this.gens.delete(g);
        if (g.ended) return;
        g.ended = true;
        g.ctl.abort(new AbortError(why));
    }

    private release(run: Run): void {
        if (run.released) return;
        run.released = true;
        run.gen.runs.delete(run);
        for (const k of run.claims) {
            const o = this.owners.get(k);
            if (!o) continue;
            o.claimers.delete(run);
            if (o.claimers.size) continue;
            this.owners.delete(k);
            this.teardown(o);
        }
        run.claims.clear();
    }

    private teardown(o: Owner): void {
        try {
            o.teardown();
        } catch (e) {
            this.o.onError?.(e);
        }
    }

    /** `run` claims `key` (made by `create` the first time) */
    private claim<O extends Owner>(run: Run, key: string, create: () => O): O {
        const sig = run.ctl.signal;
        if (sig.aborted) throw sig.reason;
        let o = this.owners.get(key) as O | undefined;
        if (!o) {
            o = create();
            this.owners.set(key, o);
        }
        o.claimers.add(run);
        run.claims.add(key);
        return o;
    }

    private ctxFor(run: Run): RunCtx {
        const ctx: RunCtx = {
            signal: run.ctl.signal,
            once: (key, fn) => {
                if (typeof key !== "string") throw new TypeError("ctx.once: the key must be a string");
                if (typeof fn !== "function") throw new TypeError("ctx.once: the second argument must be a function");
                return this.claim(run, "once:" + key, () => ({ claimers: new Set<Run>(), value: fn(), teardown() {} })).value;
            },
            patch: (obj, prop, wrap) => this.patch(run, obj, prop, wrap),
            style: (css) => this.style(run, css),
            each: (fn, ...args) => {
                run.looping = true;
                run.settle?.();
                return each(run.ctl.signal, fn, args);
            },
            elements: (selector, b, c) => this.elements(run, selector, b, c),
        };
        if (this.o.iframes !== false) ctx.iframes = (a, b, c) => (typeof a === "function" ? this.iframes(run, undefined, a, b) : this.iframes(run, a, b, c));
        if (this.o.react) ctx.mount = (...args: unknown[]) => (args.length < 2 ? this.mount(run, undefined, args[0], undefined) : this.mount(run, args[0], args[1], args[2]));
        return ctx;
    }

    private patch(run: Run, obj: any, prop: PropertyKey, wrap: (orig: any) => any): void {
        if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("ctx.patch: the first argument must be an object");
        if (typeof wrap !== "function") throw new TypeError("ctx.patch: the third argument must be a function");
        const name = String(prop);
        let byProp = this.tramps.get(obj);
        if (!byProp) this.tramps.set(obj, (byProp = new Map()));
        // one trampoline per (object, property, handler): two handlers patching the same function each get a layer
        const tk = run.h + "\u0000" + (typeof prop === "symbol" ? prop.toString() : name);
        let t = byProp.get(tk);
        if (!t) {
            const orig = obj[prop];
            if (typeof orig !== "function") throw new TypeError(`ctx.patch: ${name} isn't a function`);
            const tr: Trampoline = {
                orig,
                impl: orig,
                n: ++this.trampN,
                fn: null as any,
            };
            // Proxy keeps static constants/methods (e.g. WebSocket.OPEN), prototype, instanceof, name and length intact
            tr.fn = new Proxy(orig, {
                apply(_target, thisArg, args) {
                    return Reflect.apply(tr.impl, thisArg, args);
                },
                construct(_target, args, newTarget) {
                    return Reflect.construct(tr.impl, args, newTarget === tr.fn ? tr.impl : newTarget);
                },
            });
            obj[prop] = tr.fn;
            if (obj[prop] !== tr.fn) throw new TypeError(`ctx.patch: ${name} can't be replaced (read-only)`);
            byProp.set(tk, (t = tr));
        }
        const tr = t;
        const impl = wrap(tr.orig);
        if (typeof impl !== "function") throw new TypeError("ctx.patch: the wrapper must return a function");
        // the trampoline stays installed (the site may hold it); unclaimed, it passes through
        this.claim(run, "patch:" + tr.n, () => ({ claimers: new Set<Run>(), teardown: () => void (tr.impl = tr.orig) }));
        tr.impl = impl;
    }

    private style(run: Run, css: string): void {
        if (typeof css !== "string") throw new TypeError("ctx.style: the argument must be a CSS string");
        const key = "style:" + hash(css);
        this.claim(run, key, () => {
            const doc = this.o.doc;
            const els = [this.styleEl(css)];
            (doc.head || doc.documentElement).appendChild(els[0]);
            const entry = { css, els };
            this.styles.set(key, entry);
            for (const m of this.slots) this.mirror(m, entry);
            return {
                claimers: new Set<Run>(),
                teardown: () => {
                    this.styles.delete(key);
                    for (const el of entry.els) el.remove();
                },
            };
        });
    }

    private styleEl(css: string): Element {
        const el = this.o.doc.createElement("style");
        el.textContent = css;
        return el;
    }

    private mirror(m: Slot, entry: { css: string; els: Element[] }): void {
        if (m.host === m.container) return;
        const el = this.styleEl(entry.css);
        entry.els.push(el);
        m.styleEls.push(el);
        m.container.parentNode!.insertBefore(el, m.container);
    }

    /** `run` drops its claim on `key` (a ctx.mount's dispose) */
    private unclaim(run: Run, key: string): void {
        if (!run.claims.delete(key)) return;
        const o = this.owners.get(key);
        if (!o) return;
        o.claimers.delete(run);
        if (o.claimers.size) return;
        this.owners.delete(key);
        this.teardown(o);
    }

    private mount(run: Run, target: unknown, ui: unknown, opts: unknown): () => void {
        if (target !== undefined && typeof target !== "string" && !isTarget(target)) throw new TypeError("ctx.mount: the target must be a selector or an element");
        if (opts !== undefined && (opts === null || typeof opts !== "object")) throw new TypeError("ctx.mount: the options must be an object");
        const o = (opts ?? {}) as { position?: unknown; key?: unknown; first?: unknown; autoRestore?: unknown; shadow?: unknown };
        const pos = (o.position ?? "inside-last") as MountPosition;
        if (!POSITIONS.includes(pos)) throw new TypeError(`ctx.mount: position must be one of ${POSITIONS.map((p) => `"${p}"`).join(", ")}`);
        if (o.key !== undefined && typeof o.key !== "string") throw new TypeError("ctx.mount: the key must be a string");
        const doc = this.o.doc;
        if (typeof target === "string") checkSelector(doc, target, "ctx.mount");
        const shadow = !!o.shadow;
        let client: ReactDomClient;
        try {
            client = this.o.react!();
        } catch {
            throw new Error("ctx.mount needs React: write the UI with JSX (it loads the built-in React)");
        }
        if (typeof ui === "function" && !client.createElement) throw new TypeError("ctx.mount: a render-function UI needs React's createElement");
        const single = typeof target !== "string" || !!o.first;
        // one mount per (handler, target, position, key): mounting there again re-renders it
        const where = typeof target === "string" ? ":" + target : target ? "@" + this.targetId(target as Element) : "";
        const key = "mount:" + run.h + where + (target === undefined ? "" : "|" + pos + (single ? "|first" : "") + (shadow ? "|shadow" : "")) + (o.key ? "#" + o.key : "");
        const owner = this.claim(run, key, (): MountOwner => {
            const m: MountOwner = {
                claimers: new Set<Run>(),
                target: target as string | Element | undefined,
                pos,
                single,
                autoRestore: !!o.autoRestore,
                ui,
                client,
                Fn: notHot((p: { anchor?: Element }) => (m.ui as (a?: Element) => unknown)(p.anchor)),
                slots: new Map(),
                shadow,
                restores: [],
                teardown: () => {
                    m.watch?.stop();
                    const errs: unknown[] = [];
                    for (const sl of [...m.slots.values()])
                        try {
                            this.dropSlot(m, sl);
                        } catch (e) {
                            errs.push(e);
                        }
                    if (errs.length) throw errs[0];
                },
            };
            // a selector follows the page; autoRestore watches for the page removing the UI
            if (typeof target === "string" || m.autoRestore) {
                const onError = (e: unknown) => this.o.onError?.(e);
                m.watch = watch(doc, { shadow, selectors: typeof target === "string" ? [target] : [] }, () => this.syncMount(m, false), onError);
            }
            return m;
        });
        owner.ui = ui;
        owner.client = client;
        owner.autoRestore = !!o.autoRestore;
        owner.restoreOff = false;
        this.syncMount(owner, true);
        return () => this.unclaim(run, key);
    }

    private iframes(run: Run, selector: unknown, fn: unknown, opts: unknown): () => void {
        if (selector !== undefined && typeof selector !== "string") throw new TypeError("ctx.iframes: the selector must be a string");
        if (typeof fn !== "function") throw new TypeError("ctx.iframes: the function must come after the selector");
        if (opts !== undefined && (opts === null || typeof opts !== "object")) throw new TypeError("ctx.iframes: the options must be an object");
        const o = (opts ?? {}) as { shadow?: unknown; crossOrigin?: unknown };
        if (o.crossOrigin) throw new TypeError("ctx.iframes: crossOrigin isn't supported (only shortcuts follow cross-origin iframes: ctx.shortcut(keys, fn, { iframes: { crossOrigin: true } }))");
        const sel = selector ?? "iframe";
        checkSelector(this.o.doc, sel, "ctx.iframes");
        const shadow = !!o.shadow;
        const key = "iframes:" + run.h + ":" + (selector ?? "") + (shadow ? "|shadow" : "");
        let fresh = false;
        const owner = this.claim(run, key, (): IframesOwner => {
            fresh = true;
            const m: IframesOwner = {
                claimers: new Set<Run>(),
                fn: fn as IframesOwner["fn"],
                report: run.report,
                frames: new Set(),
                stop: () => {},
                teardown: () => m.stop(),
            };
            m.stop = followIframes(
                this.o.doc,
                { selector: sel, shadow },
                ({ iframe, document: doc }) => {
                    const s: FrameSlot = { el: iframe, doc, life: new ScriptLife({ doc, react: this.o.react, shadow: this.o.shadow, onError: this.o.onError, frameCtx: this.o.frameCtx }) };
                    m.frames.add(s);
                    this.runFrame(m, s);
                    return (why: FrameEnd) => {
                        m.frames.delete(s);
                        s.life.stop(why === "stopped" ? "the script stopped" : why);
                    };
                },
                (e) => this.o.onError?.(e)
            );
            return m;
        });
        owner.fn = fn as IframesOwner["fn"];
        owner.report = run.report;
        // a later run (a save) runs the new fn in every iframe; the iframes' mounts and claims carry over
        if (!fresh) for (const s of [...owner.frames]) this.runFrame(owner, s);
        return () => this.unclaim(run, key);
    }

    private runFrame(m: IframesOwner, s: FrameSlot): void {
        const life = s.life;
        const doc = s.doc;
        const gen = life.begin();
        try {
            life.fire(gen, "iframes", m.report, (ctx, report) => {
                const out = m.fn({ ...this.o.frameCtx?.(doc, ctx.signal), ...ctx, iframe: s.el, document: doc, window: doc.defaultView! });
                if (out && typeof (out as any).then === "function") (out as Promise<unknown>).then(undefined, report);
                return out;
            });
        } catch (e) {
            // one iframe failing doesn't stop the others (its previous run is kept)
            m.report(e);
        }
        life.commit(gen);
    }

    /** ctx.elements: the matches now, or (with fn) fn on each match while it matches */
    private elements(run: Run, selector: unknown, b: unknown, c: unknown): any {
        if (typeof selector !== "string") throw new TypeError("ctx.elements: the selector must be a string");
        const observing = typeof b === "function";
        const opts = observing ? c : b;
        if (opts !== undefined && (opts === null || typeof opts !== "object")) throw new TypeError("ctx.elements: the options must be an object");
        const o = (opts ?? {}) as { shadow?: unknown; first?: unknown; root?: unknown; key?: unknown };
        if (o.root !== undefined && !isRoot(o.root)) throw new TypeError("ctx.elements: root must be a document, element or shadow root");
        if (o.key !== undefined && typeof o.key !== "string") throw new TypeError("ctx.elements: the key must be a string");
        checkSelector(this.o.doc, selector, "ctx.elements");
        const root = (o.root ?? this.o.doc) as ParentNode;
        const shadow = !!o.shadow;
        const first = !!o.first;
        if (!observing) return findElements(root, selector, { shadow, first });
        // one per (handler, selector, options, key): calling it again (a save) restarts it with the new fn
        const key = "elements:" + run.h + ":" + selector + (first ? "|first" : "") + (shadow ? "|shadow" : "") + (o.root ? "@" + this.targetId(o.root as object) : "") + (o.key ? "#" + o.key : "");
        let fresh = false;
        const owner = this.claim(run, key, (): ElementsOwner => {
            fresh = true;
            const m: ElementsOwner = {
                claimers: new Set<Run>(),
                selector,
                first,
                fn: b as ElementsOwner["fn"],
                report: run.report,
                active: new Map(),
                watch: null as any,
                teardown: () => {
                    m.watch.stop();
                    for (const el of [...m.active.keys()]) this.leave(m, el, "the script stopped");
                },
            };
            m.watch = watch(root, { shadow, selectors: [selector] }, () => this.syncElements(m), (e) => m.report(e));
            return m;
        });
        owner.fn = b as ElementsOwner["fn"];
        owner.report = run.report;
        if (!fresh) for (const el of [...owner.active.keys()]) this.leave(owner, el, "the script reloaded");
        this.syncElements(owner);
        return () => this.unclaim(run, key);
    }

    private syncElements(m: ElementsOwner): void {
        const cur = m.first ? ([...m.active.keys()][0] ?? null) : null;
        const want = m.watch.find(m.selector, m.first, cur);
        const live = new Set(want);
        for (const el of [...m.active.keys()]) if (!live.has(el)) this.leave(m, el, "the element left");
        for (const el of want) if (!m.active.has(el)) this.arrive(m, el);
    }

    private arrive(m: ElementsOwner, el: Element): void {
        const a: { ctl: AbortController; cleanup?: () => void } = { ctl: new AbortController() };
        m.active.set(el, a);
        try {
            const out = m.fn(el, a.ctl.signal);
            if (typeof out === "function") a.cleanup = out as () => void;
            else if (out && typeof (out as any).then === "function") (out as Promise<unknown>).then(undefined, m.report);
        } catch (e) {
            m.report(e);
        }
    }

    private leave(m: ElementsOwner, el: Element, why: string): void {
        const a = m.active.get(el);
        if (!a) return;
        m.active.delete(el);
        a.ctl.abort(new AbortError(why));
        try {
            a.cleanup?.();
        } catch (e) {
            m.report(e);
        }
    }

    /** the anchors `m` goes on now */
    private anchorsOf(m: MountOwner): Element[] {
        const t = m.target;
        if (t === undefined) return [];
        if (typeof t !== "string") return [t];
        // the current match stays while it's still one
        if (m.watch) return m.watch.find(t, m.single, m.slots.get(null)?.anchor);
        return findElements(this.o.doc, t, { shadow: m.shadow, first: m.single });
    }

    /**
     * Bring `m`'s roots in line with the page: a root on each anchor (a
     * gone anchor's root unmounts; `single` keeps its root and moves it).
     * `rendered`: a ctx.mount call, which re-renders and re-places them all;
     * otherwise (the page changed) only new roots render, and a host the page
     * removed goes back only with autoRestore.
     */
    private syncMount(m: MountOwner, rendered: boolean): void {
        const doc = this.o.doc;
        if (m.target === undefined) {
            const sl = m.slots.get(null) ?? this.addSlot(m, null, null);
            const base = this.o.shadow !== false ? doc.documentElement : doc.body || doc.documentElement;
            if (sl.host.parentNode !== base) base.appendChild(sl.host);
            sl.root.render(this.uiOf(m, undefined));
            return;
        }
        const anchors = this.anchorsOf(m);
        if (m.single) {
            const a = anchors[0];
            let sl = m.slots.get(null);
            if (!a) {
                if (rendered && sl) sl.root.render(this.uiOf(m, sl.anchor ?? undefined));
                return;
            }
            const fresh = !sl;
            if (!sl) sl = this.addSlot(m, null, a);
            else if (sl.anchor !== a) {
                this.unposition(sl);
                sl.anchor = a;
            }
            this.place(m, sl, rendered || fresh);
            if (rendered || fresh) sl.root.render(this.uiOf(m, a));
            return;
        }
        const live = new Set(anchors);
        for (const [a, sl] of [...m.slots]) if (!live.has(a!)) this.dropSlot(m, sl);
        for (const a of anchors) {
            let sl = m.slots.get(a);
            const fresh = !sl;
            if (!sl) sl = this.addSlot(m, a, a);
            this.place(m, sl, rendered || fresh);
            if (rendered || fresh) sl.root.render(this.uiOf(m, a));
        }
    }

    private uiOf(m: MountOwner, anchor: Element | undefined): unknown {
        if (typeof m.ui !== "function") return m.ui;
        // a hook-call change remounts it (rather than throwing)
        return m.client.createElement!(m.Fn, { key: hookSignature(m.ui as Function), anchor });
    }

    private addSlot(m: MountOwner, at: Element | null, anchor: Element | null): Slot {
        const doc = this.o.doc;
        const shadow = this.o.shadow !== false;
        const overlay = m.pos === "overlay";
        let host: Element;
        let container: Element;
        if (shadow) {
            host = doc.createElement("tangitweak-mount");
            const root = host.attachShadow({ mode: "closed" });
            container = doc.createElement("div");
            root.appendChild(container);
            if (m.target === undefined) (host as HTMLElement).style.cssText = "all:initial;position:fixed;top:0;left:0;z-index:2147483646";
            else if (overlay) {
                (host as HTMLElement).style.cssText = "display:block;position:absolute;inset:0;pointer-events:none";
                (container as HTMLElement).style.cssText = "display:contents;pointer-events:auto";
            } else {
                // inline in the page's layout: a label next to text stays on its line
                (host as HTMLElement).style.cssText = "display:contents";
                (container as HTMLElement).style.cssText = "display:contents";
            }
        } else {
            host = container = doc.createElement("div");
            if (overlay) (host as HTMLElement).style.cssText = "position:absolute;inset:0;pointer-events:none";
            else if (m.target !== undefined) (host as HTMLElement).style.cssText = "display:contents";
        }
        host.setAttribute(HOST_ATTR, "");
        const sl: Slot = { anchor, host, container, root: m.client.createRoot(container), styleEls: [] };
        m.slots.set(at, sl);
        this.slots.add(sl);
        for (const entry of this.styles.values()) this.mirror(sl, entry);
        return sl;
    }

    private dropSlot(m: MountOwner, sl: Slot): void {
        for (const [k, v] of m.slots) if (v === sl) m.slots.delete(k);
        this.slots.delete(sl);
        if (sl.styleEls.length) for (const entry of this.styles.values()) entry.els = entry.els.filter((el) => !sl.styleEls.includes(el));
        this.unposition(sl);
        try {
            sl.root.unmount();
        } finally {
            sl.host.remove();
        }
    }

    /** put `sl`'s host where `m.pos` says (`force`: also when it's only missing, not just moved) */
    private place(m: MountOwner, sl: Slot, force: boolean): void {
        const a = sl.anchor!;
        const h = sl.host;
        const inside = m.pos === "inside-last" || m.pos === "inside-first" || m.pos === "overlay";
        const parent = inside ? a : a.parentNode;
        if (!parent || h.parentNode === parent) {
            if (m.pos === "overlay") this.position(sl);
            return;
        }
        if (!force) {
            // the page removed it: back only with autoRestore, and not in a fight with the page
            if (!m.autoRestore || m.restoreOff) return;
            const now = Date.now();
            m.restores = m.restores.filter((t) => now - t < 1000);
            m.restores.push(now);
            if (m.restores.length > MAX_RESTORES) {
                m.restoreOff = true;
                this.o.onError?.(new Error(`ctx.mount(${typeof m.target === "string" ? JSON.stringify(m.target) : "element"}): the page keeps removing the UI, so autoRestore stopped (until the next save)`));
                return;
            }
        }
        if (m.pos === "inside-first") a.insertBefore(h, a.firstChild);
        else if (m.pos === "before") parent.insertBefore(h, a);
        else if (m.pos === "after") parent.insertBefore(h, a.nextSibling);
        else a.appendChild(h);
        if (m.pos === "overlay") this.position(sl);
    }

    /** an overlay's anchor gets `position: relative` while it's `static` */
    private position(sl: Slot): void {
        const a = sl.anchor as HTMLElement;
        if (sl.positioned === a || !a.style) return;
        const view = this.o.doc.defaultView;
        const p = this.positioned.get(a);
        if (p) p.n++;
        else {
            const cur = view?.getComputedStyle(a).position;
            if (!view || (cur && cur !== "static")) return;
            this.positioned.set(a, { n: 1, prev: a.style.position });
            a.style.position = "relative";
        }
        sl.positioned = a;
    }

    private unposition(sl: Slot): void {
        const a = sl.positioned as HTMLElement | undefined;
        if (!a) return;
        sl.positioned = undefined;
        const p = this.positioned.get(a);
        if (!p || --p.n > 0) return;
        this.positioned.delete(a);
        if (a.style.position === "relative") a.style.position = p.prev;
    }

    private targetId(el: object): number {
        let id = this.targetIds.get(el);
        if (id === undefined) this.targetIds.set(el, (id = this.nextTargetId++));
        return id;
    }
}

function isTarget(v: unknown): v is Element {
    return !!v && typeof v === "object" && (v as any).nodeType === 1;
}

/** a document, element, or shadow root (a fragment) */
function isRoot(v: unknown): v is ParentNode {
    const t = !!v && typeof v === "object" ? (v as any).nodeType : 0;
    return (t === 1 || t === 9 || t === 11) && typeof (v as any).querySelectorAll === "function";
}

/**
 * `for await (const x of ctx.each(site.next))`: call `fn` again after
 * each answer; a call cut by the callee's reload (ReloadedError) is made
 * again, and the loop ends quietly when the run ends.
 */
async function* each<T>(signal: AbortSignal, fn: (...args: any[]) => Promise<T>, args: any[]): AsyncGenerator<T> {
    if (typeof fn !== "function") throw new TypeError("ctx.each: the first argument must be a function (a handle's)");
    while (!signal.aborted) {
        let v: T;
        try {
            v = await untilAborted(fn(...args), signal);
        } catch (e: any) {
            if (signal.aborted) return;
            if (e?.name === "ReloadedError") continue;
            throw e;
        }
        yield v;
    }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(p).then(
            (v) => {
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener("abort", onAbort);
                reject(e);
            }
        );
    });
}
