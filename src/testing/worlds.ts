/**
 * The globals each copy of a tweak sees in tests (ScriptScope): its tab's
 * own `window`, `document` and `location`, and none of Node's globals, so
 * code that needs a polyfill fails here as it does in the extension. The
 * MAIN world (`onSite`) is the page's own `window`; the isolated world
 * (`onPage`) shares the tab's DOM but has a `globalThis` of its own, which
 * doesn't see what the page or `onSite` add to `window` — as in Chrome.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as vm from "node:vm";
import { setScriptScopeProvider, type ScriptScope } from "../shared/scriptScope";

const current = new AsyncLocalStorage<ScriptScope>();
setScriptScopeProvider(() => current.getStore());

/** run `fn` with code it compiles (scripts, packages) seeing `scope`'s globals; async work it starts keeps them */
export function inScope<T>(scope: ScriptScope, fn: () => T): T {
    return current.run(scope, fn);
}

/** Node's globals a browser lacks (a tweak's bundle provides them itself, §7.4 of the plan) */
export const NODE_GLOBALS = new Set(["Buffer", "process", "global", "setImmediate", "clearImmediate"]);

// the language's own globals: always the realm's, so values stay comparable (instanceof Array, Promise)
const JS_GLOBALS = new Set<string>(vm.runInNewContext("Object.getOwnPropertyNames(globalThis)"));

let seq = 0;

/** every name `obj` has now, its prototypes' too */
function namesOf(obj: object): Set<string> {
    const out = new Set<string>();
    for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) out.add(k);
    }
    return out;
}

/**
 * A world's `globalThis`: reads fall through to `base` (then the realm),
 * writes stay in this world. `base`'s functions are bound to it, so
 * `globalThis.addEventListener(…)` works on the proxy. With `seen`, only
 * those names of `base` show through (what the page adds later doesn't).
 */
function worldGlobal(base: object, selfNames: Set<string>, overrides: Record<string, unknown>, seen?: Set<string>) {
    const own = new Map<string | symbol, unknown>();
    const bound = new Map<PropertyKey, { from: Function; fn: Function }>();
    let proxy: any;
    const realm = globalThis as any;
    const fromBase = (k: string | symbol) => {
        const v = Reflect.get(base, k);
        if (typeof v !== "function" || typeof k !== "string" || !/^[a-z]/.test(k)) return v;
        let b = bound.get(k);
        if (!b || b.from !== v) bound.set(k, (b = { from: v, fn: v.bind(base) }));
        return b.fn;
    };
    const read = (k: string | symbol): unknown => {
        if (own.has(k)) return own.get(k);
        if (typeof k === "string") {
            if (selfNames.has(k)) return proxy;
            if (NODE_GLOBALS.has(k)) return undefined;
            if (k in overrides) return overrides[k];
            if (JS_GLOBALS.has(k)) return realm[k];
        }
        return inBase(k) ? fromBase(k) : realm[k];
    };
    const inBase = (k: string | symbol) => (seen && typeof k === "string" ? seen.has(k) : k in base);
    const has = (k: string | symbol) =>
        own.has(k) || (typeof k === "string" && (selfNames.has(k) || k in overrides || (!NODE_GLOBALS.has(k) && (inBase(k) || k in realm))));
    proxy = new Proxy(Object.create(null), {
        get: (_t, k) => read(k),
        set: (_t, k, v) => {
            own.set(k, v);
            return true;
        },
        has: (_t, k) => has(k),
        deleteProperty: (_t, k) => {
            own.delete(k);
            return true;
        },
        defineProperty: (_t, k, d) => {
            own.set(k, d.get ? d.get.call(proxy) : d.value);
            return true;
        },
        getOwnPropertyDescriptor: (_t, k) => (has(k) ? { value: read(k), writable: true, enumerable: true, configurable: true } : undefined),
        ownKeys: () => [...new Set([...Reflect.ownKeys(base).filter((k) => inBase(k)), ...own.keys()])].filter((k) => typeof k !== "string" || !NODE_GLOBALS.has(k)),
    });
    return { proxy, own, read, inBase, isMine: (k: string) => own.has(k) || selfNames.has(k) || NODE_GLOBALS.has(k) || k in overrides };
}

function scopeOver(g: ReturnType<typeof worldGlobal>, intercept: (k: string) => boolean, key: string): ScriptScope {
    // the `with` object: a name it has is read and written on this world's globalThis
    const vars = new Proxy(Object.create(null), {
        has: (_t, k) => typeof k === "string" && intercept(k),
        get: (_t, k) => (k === Symbol.unscopables ? undefined : g.read(k)),
        set: (_t, k, v) => {
            g.own.set(k, v);
            return true;
        },
    });
    return { vars, key, global: g.proxy };
}

/** network handlers' world: the realm's globals, minus Node's */
export function backgroundScope(): ScriptScope {
    const g = worldGlobal(globalThis, new Set(["globalThis", "self", "window"]), {});
    return scopeOver(g, (k) => g.isMine(k), `bg${++seq}`);
}

/** an isolated world's globals (`onPage`, the overlay's frame): `win`'s own, as it was made, and a `globalThis` of its own */
export function windowScope(win: object, opts: { label?: string } = {}): ScriptScope {
    const g = worldGlobal(win, new Set(["globalThis", "self", "window", "top", "parent", "frames"]), {}, namesOf(win));
    return scopeOver(g, (k) => g.isMine(k) || (!JS_GLOBALS.has(k) && g.inBase(k)), `${opts.label ?? "world"}${++seq}`);
}

/** the MAIN world's globals (`onSite`): the page's `window` itself, minus Node's */
export function pageScope(win: object, opts: { label?: string } = {}): ScriptScope {
    const w = win as any;
    const vars = new Proxy(Object.create(null), {
        has: (_t, k) => typeof k === "string" && (NODE_GLOBALS.has(k) || (!JS_GLOBALS.has(k) && k in w) || Object.prototype.hasOwnProperty.call(w, k)),
        get: (_t, k) => {
            if (k === Symbol.unscopables) return undefined;
            if (typeof k === "string" && NODE_GLOBALS.has(k) && !Object.prototype.hasOwnProperty.call(w, k)) return undefined;
            const v = w[k];
            return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(w) : v;
        },
        set: (_t, k, v) => {
            w[k] = v;
            return true;
        },
    });
    return { vars, key: `${opts.label ?? "page"}${++seq}`, global: w };
}
