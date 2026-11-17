/**
 * Finding page elements and following them (docs/scripting.md, `ctx.elements`):
 * what `ctx.elements`, `ctx.mount`, `ctx.iframes` and shortcut iframes share.
 *
 * One MutationObserver per watched root (the document, usually) serves every
 * subscription in this world; with `shadow`, it also observes each shadow
 * root found inside (MutationObserver doesn't cross into them). Changes
 * inside TangiTweak's own mounts aren't the page's and are ignored.
 */

/** marks a mount's host: page changes there are ours, and elements inside aren't matches */
export const HOST_ATTR = "data-tangitweak-mount";

/** an element's closed shadow root, where this world can read it (null: none, or unreadable) */
type ShadowResolver = (el: Element) => ShadowRoot | null;

let resolver: ShadowResolver | null = null;
/** closed roots reported as they were made (an attachShadow patch) */
const known = new WeakMap<Element, ShadowRoot>();
/** elements attachShadow accepts (and custom elements: a "-" in the name) */
const HOSTABLE = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);

/** how this world reads closed shadow roots (chrome.dom.openOrClosedShadowRoot in a content script) */
export function setShadowResolver(fn: ShadowResolver | null): void {
    resolver = fn;
}

/** `host` got shadow root `root` (open or closed): watchers with `shadow` subscriptions follow it now */
export function noteShadowRoot(host: Element, root: ShadowRoot): void {
    known.set(host, root);
    for (const w of watchers) w.noteRoot(host, root);
}

/** `el`'s shadow root, open or (where readable) closed; not our mounts' */
export function shadowRootOf(el: Element): ShadowRoot | null {
    if (el.hasAttribute(HOST_ATTR)) return null;
    const open = el.shadowRoot;
    if (open) return open;
    const k = known.get(el);
    if (k) return k;
    if (!resolver || !(HOSTABLE.has(el.localName) || el.localName.includes("-"))) return null;
    try {
        return resolver(el);
    } catch {
        return null;
    }
}

/** a mount's host, or inside one */
export function isOurs(n: Node): boolean {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    return !!el?.closest(`[${HOST_ATTR}]`);
}

export function inHost(el: Element): boolean {
    return !!el.closest(`[${HOST_ATTR}]`);
}

/** throws a SyntaxError naming `api` when `selector` isn't one */
export function checkSelector(doc: Document, selector: string, api: string): void {
    try {
        doc.createDocumentFragment().querySelector(selector);
    } catch {
        throw new SyntaxError(`${api}: "${selector}" isn't a valid selector`);
    }
}

export interface FindOptions {
    /** look inside open and (where readable) closed shadow roots too */
    shadow?: boolean;
    /** only the first match */
    first?: boolean;
}

/** the elements under `root` matching `selector` now, in tree order (not inside our mounts) */
export function findElements(root: ParentNode, selector: string, opts: FindOptions = {}): Element[] {
    const roots: ParentNode[] = [root];
    if (opts.shadow) collectRoots(root, roots, new Set());
    return query(roots, selector, !!opts.first);
}

/** the shadow roots inside `n` (and inside those), in `into` */
function collectRoots(n: ParentNode, into: ParentNode[], seen: Set<ShadowRoot>): void {
    const els: Element[] = n.nodeType === 1 ? [n as Element, ...n.querySelectorAll("*")] : [...n.querySelectorAll("*")];
    for (const el of els) {
        const sr = shadowRootOf(el);
        if (!sr || seen.has(sr)) continue;
        seen.add(sr);
        into.push(sr);
        collectRoots(sr, into, seen);
    }
}

function query(roots: ParentNode[], selector: string, first: boolean): Element[] {
    const out: Element[] = [];
    for (const r of roots) {
        if (first) {
            for (const el of r.querySelectorAll(selector))
                if (!inHost(el)) {
                    out.push(el);
                    break;
                }
        } else for (const el of r.querySelectorAll(selector)) if (!inHost(el)) out.push(el);
    }
    if (roots.length > 1) out.sort(treeOrder);
    return first ? out.slice(0, 1) : out;
}

/** shadow-including tree order: a host's shadow content comes before its light children */
function treeOrder(a: Node, b: Node): number {
    const pa = composedPath(a);
    const pb = composedPath(b);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    if (i === pa.length) return -1;
    if (i === pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    if (x.nodeType === 11) return -1;
    if (y.nodeType === 11) return 1;
    return x.compareDocumentPosition(y) & 4 ? -1 : 1;
}

function composedPath(n: Node): Node[] {
    const p: Node[] = [];
    for (let x: Node | null = n; x; x = x.parentNode ?? (x as ShadowRoot).host ?? null) p.unshift(x);
    return p;
}

/** `n` is `base` or inside it, shadow roots included */
function composedContains(base: Node, n: Node): boolean {
    for (let x: Node | null = n; x; x = x.parentNode ?? (x as ShadowRoot).host ?? null) if (x === base) return true;
    return false;
}

/**
 * The attributes a selector's match can depend on (null: any of them).
 * Focus, hover and properties set by code don't change attributes: those
 * selectors don't follow such changes (docs/scripting.md).
 */
export function selectorAttrs(selector: string): Set<string> | null {
    const s = selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
    if (/:has\(/i.test(s)) return null;
    const out = new Set<string>();
    if (s.includes(".")) out.add("class");
    if (s.includes("#")) out.add("id");
    for (const m of s.matchAll(/\[\s*(?:[\w*-]*\|)?([\w-]+)/g)) {
        out.add(m[1]);
        out.add(m[1].toLowerCase());
    }
    for (const m of s.matchAll(/:([\w-]+)/g)) for (const a of PSEUDO_ATTRS[m[1].toLowerCase()] ?? []) out.add(a);
    return out;
}

const PSEUDO_ATTRS: Record<string, string[]> = {
    disabled: ["disabled"],
    enabled: ["disabled"],
    checked: ["checked", "selected"],
    required: ["required"],
    optional: ["required"],
    "read-only": ["readonly", "contenteditable", "disabled"],
    "read-write": ["readonly", "contenteditable", "disabled"],
    "placeholder-shown": ["placeholder"],
    link: ["href"],
    "any-link": ["href"],
    lang: ["lang"],
    dir: ["dir"],
    open: ["open"],
    defined: [],
};

export interface Watch {
    /**
     * The matches now, in tree order (shadow roots: the ones found so far).
     * `first`: one; `keep`, while it still matches, stays the one.
     */
    find(selector: string, first?: boolean, keep?: Element | null): Element[];
    stop(): void;
}

interface Sub {
    shadow: boolean;
    /** null: any attribute */
    attrs: Set<string> | null;
    onChange: () => void;
    onError: (e: unknown) => void;
}

const watchers = new Set<Watcher>();
const byRoot = new WeakMap<Node, Watcher>();

class Watcher {
    readonly subs = new Set<Sub>();
    /** shadow roots found (observed while a subscription wants them) */
    readonly roots = new Set<ShadowRoot>();
    private readonly mo: MutationObserver;
    private opts: MutationObserverInit = { childList: true, subtree: true };
    private pending = false;

    constructor(readonly base: ParentNode) {
        const MO = (base.ownerDocument ?? (base as Document)).defaultView?.MutationObserver ?? MutationObserver;
        this.mo = new MO((records) => this.changed(records));
        this.mo.observe(base, this.opts);
    }

    get shadow(): boolean {
        for (const s of this.subs) if (s.shadow) return true;
        return false;
    }

    add(sub: Sub): void {
        const hadShadow = this.shadow;
        this.subs.add(sub);
        if (sub.shadow && !hadShadow) this.scan(this.base);
        this.reobserve();
    }

    remove(sub: Sub): void {
        this.subs.delete(sub);
        if (!this.subs.size) {
            this.mo.disconnect();
            watchers.delete(this);
            byRoot.delete(this.base);
            return;
        }
        if (!this.shadow && this.roots.size) {
            this.roots.clear();
            this.mo.disconnect();
            this.mo.observe(this.base, this.opts);
        }
        this.reobserve();
    }

    noteRoot(host: Element, root: ShadowRoot): void {
        if (!this.shadow || this.roots.has(root) || !composedContains(this.base, host)) return;
        this.roots.add(root);
        this.mo.observe(root, this.opts);
        this.scan(root);
        // nothing changed in the light tree: tell the subscriptions ourselves
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
            this.pending = false;
            this.notify(() => true);
        });
    }

    find(selector: string, first: boolean, keep: Element | null | undefined, shadow: boolean): Element[] {
        if (first && keep && this.holds(keep, shadow) && keep.matches(selector) && !inHost(keep)) return [keep];
        return query(shadow ? [this.base, ...this.roots] : [this.base], selector, first);
    }

    private holds(el: Element, shadow: boolean): boolean {
        if (!el.isConnected) return false;
        if (!shadow) return this.base.contains(el);
        return composedContains(this.base, el);
    }

    /** start observing the shadow roots inside `n` */
    private scan(n: ParentNode): void {
        const found: ParentNode[] = [];
        collectRoots(n, found, this.roots);
        for (const r of found) this.mo.observe(r, this.opts);
    }

    /** attributes: the union of what the subscriptions' selectors depend on */
    private reobserve(): void {
        let all = false;
        const attrs = new Set<string>();
        for (const s of this.subs) {
            if (!s.attrs) all = true;
            else for (const a of s.attrs) attrs.add(a);
        }
        const next: MutationObserverInit = { childList: true, subtree: true };
        if (all) next.attributes = true;
        else if (attrs.size) next.attributeFilter = [...attrs].sort();
        if (sameInit(next, this.opts)) return;
        this.opts = next;
        // re-observe from scratch (some DOMs ignore new options on a second observe()); keep what was pending
        const pending = this.mo.takeRecords();
        this.mo.disconnect();
        this.mo.observe(this.base, next);
        for (const r of this.roots) this.mo.observe(r, next);
        if (pending.length) queueMicrotask(() => this.subs.size && this.changed(pending));
    }

    private changed(records: MutationRecord[]): void {
        // changes inside our UI, and our own insertions, aren't the page's (a removal of ours may be: autoRestore)
        const page = records.filter(
            (r) => !(isOurs(r.target) || (r.type === "childList" && !r.removedNodes.length && ([...r.addedNodes] as Node[]).every(isOurs)))
        );
        if (!page.length) return;
        if (this.shadow) {
            if (page.some((r) => r.removedNodes.length)) this.prune();
            for (const r of page) for (const n of r.addedNodes) if (n.nodeType === 1 && !isOurs(n)) this.scan(n as Element);
        }
        const childList = page.some((r) => r.type === "childList");
        const names = new Set(page.filter((r) => r.type === "attributes").map((r) => r.attributeName!));
        this.notify((s) => childList || !s.attrs || [...names].some((n) => s.attrs!.has(n)));
    }

    /** shadow roots whose host left */
    private prune(): void {
        let gone = false;
        for (const r of this.roots)
            if (!r.host.isConnected || !composedContains(this.base, r.host)) {
                this.roots.delete(r);
                gone = true;
            }
        if (!gone) return;
        this.mo.disconnect();
        this.mo.observe(this.base, this.opts);
        for (const r of this.roots) this.mo.observe(r, this.opts);
    }

    private notify(wants: (s: Sub) => boolean): void {
        for (const s of [...this.subs]) {
            if (!this.subs.has(s) || !wants(s)) continue;
            try {
                s.onChange();
            } catch (e) {
                s.onError(e);
            }
        }
    }
}

function sameInit(a: MutationObserverInit, b: MutationObserverInit): boolean {
    return a.attributes === b.attributes && (a.attributeFilter ?? []).join() === (b.attributeFilter ?? []).join();
}

/**
 * Call `onChange` after the page changes under `root` (elements added or
 * removed, or attributes `selectors` depend on); one observer per root is
 * shared by every watch on it.
 */
export function watch(root: ParentNode, opts: { shadow?: boolean; selectors?: string[] }, onChange: () => void, onError: (e: unknown) => void): Watch {
    let w = byRoot.get(root);
    if (!w) {
        w = new Watcher(root);
        byRoot.set(root, w);
        watchers.add(w);
    }
    let attrs: Set<string> | null = new Set();
    for (const s of opts.selectors ?? []) {
        const a = selectorAttrs(s);
        if (!a) {
            attrs = null;
            break;
        }
        for (const x of a) attrs.add(x);
    }
    const sub: Sub = { shadow: !!opts.shadow, attrs, onChange, onError };
    const watcher = w;
    watcher.add(sub);
    let live = true;
    return {
        find: (selector, first = false, keep) => watcher.find(selector, first, keep, sub.shadow),
        stop: () => {
            if (!live) return;
            live = false;
            watcher.remove(sub);
        },
    };
}

/** one same-origin iframe's current document */
export interface FrameDoc {
    iframe: HTMLIFrameElement;
    document: Document;
    window: Window;
}

/** why a frame's document stopped being followed */
export type FrameEnd = "the iframe navigated" | "the iframe was removed" | "stopped";

interface Tracked {
    el: HTMLIFrameElement;
    doc: Document | null;
    /** the root `ready` ran under: a document.open() swaps it (same document, wiped page) */
    root: Element | null;
    cleanup: ((why: FrameEnd) => void) | null;
    onLoad: () => void;
    /** sees a document.open() wipe and the new page arriving (no load event comes for those) */
    mo?: MutationObserver;
    /** `each`'s cleanup */
    untrack?: () => void;
}

/**
 * Follow the same-origin iframes matching `selector` under `doc`: `ready`
 * runs for each one's document, now and as iframes are added, and again
 * after one navigates or a document.open() replaces its page; the cleanup
 * it returns runs when that document goes (or the iframe does). A
 * cross-origin iframe is skipped (its document isn't readable here).
 */
/**
 * `each`: also called for every matched iframe element as it arrives,
 * cross-origin ones included (whatever it returns runs when it leaves)
 */
export function followIframes(
    doc: Document,
    opts: { selector?: string; shadow?: boolean },
    ready: (f: FrameDoc) => ((why: FrameEnd) => void) | void,
    onError: (e: unknown) => void,
    each?: (el: HTMLIFrameElement) => () => void
): () => void {
    const selector = opts.selector ?? "iframe";
    const frames = new Map<Element, Tracked>();
    let stopped = false;

    const end = (t: Tracked, why: FrameEnd) => {
        const c = t.cleanup;
        t.cleanup = null;
        if (!c) return;
        try {
            c(why);
        } catch (e) {
            onError(e);
        }
    };

    const load = (t: Tracked, settled: boolean) => {
        if (stopped) return;
        let d: Document | null = null;
        try {
            d = t.el.contentDocument;
        } catch {}
        // the empty document an iframe starts with while its real one loads isn't the one wanted
        if (d && !settled && (d.readyState === "loading" || (d.URL === "about:blank" && loadsOther(t.el)))) d = null;
        const root = d?.documentElement ?? null;
        if (d === t.doc && root === t.root) return;
        end(t, "the iframe navigated");
        if (d !== t.doc) {
            t.mo?.disconnect();
            t.mo = undefined;
            const MO = d?.defaultView?.MutationObserver;
            if (d && MO) {
                t.mo = new MO(() => load(t, true));
                t.mo.observe(d, { childList: true });
            }
        }
        t.doc = d;
        t.root = root;
        // cross-origin, still loading, or wiped by document.open() with no page yet: wait
        if (!d || !root || !d.defaultView) return;
        try {
            t.cleanup = ready({ iframe: t.el, document: d, window: d.defaultView }) || null;
        } catch (e) {
            onError(e);
        }
    };

    const drop = (t: Tracked, why: FrameEnd) => {
        frames.delete(t.el);
        t.el.removeEventListener("load", t.onLoad);
        t.mo?.disconnect();
        end(t, why);
        try {
            t.untrack?.();
        } catch (e) {
            onError(e);
        }
    };

    const sync = () => {
        const want = new Set(w.find(selector).filter((el) => el.localName === "iframe"));
        for (const [el, t] of [...frames]) if (!want.has(el)) drop(t, "the iframe was removed");
        for (const el of want) {
            if (frames.has(el)) continue;
            const t: Tracked = { el: el as HTMLIFrameElement, doc: null, root: null, cleanup: null, onLoad: () => load(t, true) };
            frames.set(el, t);
            el.addEventListener("load", t.onLoad);
            if (each)
                try {
                    t.untrack = each(t.el);
                } catch (e) {
                    onError(e);
                }
            load(t, false);
        }
    };

    const w = watch(doc, { shadow: opts.shadow, selectors: [selector] }, sync, onError);
    sync();
    return () => {
        if (stopped) return;
        w.stop();
        for (const t of [...frames.values()]) drop(t, "stopped");
        stopped = true;
    };
}

/** the iframe has a document of its own coming (srcdoc, or a src that isn't about:blank) */
function loadsOther(el: HTMLIFrameElement): boolean {
    if (el.hasAttribute("srcdoc")) return true;
    const src = (el.getAttribute("src") ?? "").trim();
    return src !== "" && !/^about:blank$/i.test(src);
}
