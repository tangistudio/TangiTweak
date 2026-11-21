/**
 * `import { tweak } from "tangitweak"`: the authoring API, next to the
 * `tt` parameter every script gets. A shim builder (compile.ts makeShim,
 * pageShim.ts makePageShim) makes `tt` and registers how to make the file's
 * `tweak` (provideTweak). scriptFunction wraps each file's `require` so
 * `require("tangitweak")` hands that file its own `tweak` (tweakRequire):
 * it knows its file's path, which names its unnamed stores. Nothing is
 * downloaded; it's never a package.
 *
 * What `tweak` differs in from `tt`:
 * - no `metadata`, no `defineParam`;
 * - `globalStore(id, …)`'s id is a file-name-safe string (checkStoreId);
 * - `tabStore` / `pageStore` / `siteStore` take no name (tweakStores);
 * - its onSite / onPage / onOverlay handlers are keyed by registration
 *   order, per file and API (`onPage:1`: the 2nd onPage registered by that
 *   file's code), not by keyPlaceCalls' source rewrite — every world runs
 *   the same code in the same order, so the keys agree;
 * - its messages say `tweak.onPage`, not `tt.onPage`.
 */

export const TWEAK_MODULE = "tangitweak";

/** which API a call came through: the `tt` parameter or the imported `tweak` (labels its messages) */
export type Via = "tt" | "tweak";

const providers = new WeakMap<object, { make: (file: string) => object; modules: Map<string, object> }>();

/** a file run with `tt` gets `make(file)` as its `tweak` (made once per file, on its first import) */
export function provideTweak(tt: object, make: (file: string) => object): void {
    providers.set(tt, { make, modules: new Map() });
}

/** `require` for `file`'s code run with `tt`: "tangitweak" is that file's `tweak`, anything else `require`'s */
export function tweakRequire(tt: unknown, file: string, require: unknown): (spec: string) => any {
    return (spec) => {
        const p = spec === TWEAK_MODULE && tt && typeof tt === "object" ? providers.get(tt) : undefined;
        if (p) {
            let m = p.modules.get(file);
            if (!m) p.modules.set(file, (m = Object.freeze({ __esModule: true, tweak: p.make(file) })));
            return m;
        }
        if (typeof require !== "function") throw new Error(`cannot import "${spec}" here`);
        return require(spec);
    };
}

const STORE_ID = /^[a-z0-9_-][a-z0-9._-]*$/;

/** `tweak.globalStore`'s id: it becomes a file name */
export function checkStoreId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !STORE_ID.test(id)) {
        const shown = typeof id === "string" ? JSON.stringify(id) : String(id);
        throw new TypeError(`tweak.globalStore(${shown}): a store's ID is lowercase letters, digits, "-", "_" and "." (not first) — e.g. "seen-items"`);
    }
}

/** a world's stores, by name, with `tweak.*` in their messages */
export interface NamedStores {
    globalStore(name: string, initial: object, opts?: unknown): object;
    tabStore(name: string, initial: object): object;
    pageStore(name: string, initial: object): object;
    siteStore(name: string, initial: object): object;
}

export interface TweakStores {
    globalStore(id: string, initial: object, opts?: unknown): object;
    tabStore(initial: object): object;
    pageStore(initial: object): object;
    siteStore(initial: object): object;
}

/**
 * `tweak`'s stores for `file`. `tabStore` / `pageStore` / `siteStore` take
 * no name: a store is named after its file and its position among those
 * calls — counted across the three kinds together, in call order, per load
 * of the file (`features/state.ts#1`: the 2nd unnamed store that file's code
 * made). Every world runs the same code in the same order, and counts a
 * call even where the store can't be used, so the names agree; that name
 * goes through the same machinery as `tt`'s named stores. `globalStore`
 * isn't counted (its id names it).
 */
export function tweakStores(file: string, s: NamedStores, isStub: (x: unknown) => boolean = () => false): TweakStores {
    let n = 0;
    const next = () => `${file}#${n++}`;
    return {
        globalStore: (id: string, initial: object, opts?: unknown) => {
            if (!isStub(id)) checkStoreId(id);
            return s.globalStore(id, initial, opts);
        },
        tabStore: (initial: object) => s.tabStore(next(), initial),
        pageStore: (initial: object) => s.pageStore(next(), initial),
        siteStore: (initial: object) => s.siteStore(next(), initial),
    };
}
