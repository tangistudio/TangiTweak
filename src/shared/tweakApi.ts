/**
 * `import { tweak } from "tangitweak"`: the authoring API. A shim builder
 * (compile.ts makeShim, pageShim.ts makePageShim) makes a TweakHost: how
 * each file's `tweak` is made. scriptFunction wraps each file's `require`
 * so `require("tangitweak")` hands that file its own `tweak` (tweakRequire):
 * it knows its file's path, which names its unnamed stores. Nothing is
 * downloaded; it's never a package.
 *
 * - `globalStore(id, …)`'s id is a file-name-safe string (checkStoreId);
 * - `tabStore` / `pageStore` / `siteStore` take no name (tweakStores);
 * - onSite / onPage / onOverlay handlers are keyed by registration order,
 *   per file and API (`onPage:1`: the 2nd onPage registered by that file's
 *   code, route.ts placeKeyer) — every world runs the same code in the same
 *   order, so the keys agree.
 */

export const TWEAK_MODULE = "tangitweak";

/** what a file's code runs with (scriptFunction): makes that file's `"tangitweak"` module, once per file */
export interface TweakHost {
    module(file: string): { readonly __esModule: true; readonly tweak: any };
}

export function tweakHost(make: (file: string) => object): TweakHost {
    const modules = new Map<string, { readonly __esModule: true; readonly tweak: any }>();
    return {
        module(file) {
            let m = modules.get(file);
            if (!m) modules.set(file, (m = Object.freeze({ __esModule: true as const, tweak: make(file) })));
            return m;
        },
    };
}

/** `require` for `file`'s code run with `host`: "tangitweak" is that file's `tweak`, anything else `require`'s */
export function tweakRequire(host: TweakHost | undefined, file: string, require: unknown): (spec: string) => any {
    return (spec) => {
        if (spec === TWEAK_MODULE && host && typeof host.module === "function") return host.module(file);
        if (typeof require !== "function") throw new Error(`cannot import "${spec}" here`);
        return require(spec);
    };
}

export const STORE_ID = /^[a-z0-9_-][a-z0-9._-]*$/;

/** `tweak.globalStore`'s id: it becomes a file name */
export function checkStoreId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !STORE_ID.test(id)) {
        const shown = typeof id === "string" ? JSON.stringify(id) : String(id);
        throw new TypeError(`tweak.globalStore(${shown}): a store's ID is lowercase letters, digits, "-", "_" and "." (not first) — e.g. "seen-items"`);
    }
}

/** a world's stores, by name */
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
 * The script top level that's running: the stores its unnamed stores go to
 * and how many each file's code has made in it. A library's exported
 * function called from a script's top level makes the script's stores, like
 * it registers the script's handlers.
 */
export interface StoreRun {
    stores: NamedStores;
    counts: Map<string, number>;
}

export const storeRun = (stores: NamedStores): StoreRun => ({ stores, counts: new Map() });

// each tweak's global store IDs (its run: every file of a bundle runs with its entry's): the file that declared each
const globalIds = new WeakMap<StoreRun, Map<string, string>>();

/**
 * `tweak`'s stores for `file`. `tabStore` / `pageStore` / `siteStore` take
 * no name: a store is named after its file and its position among those
 * calls — counted across the three kinds together, in call order, per file
 * per run (`features/state.ts#1`: the 2nd unnamed store that file's code
 * made). Every world runs the same code in the same order, and counts a call
 * even where the store can't be used, so the names agree. `run()`: the
 * script top level running now; none (the file's own top level, a late
 * call): `own`, the run of the shim that made this `tweak`. Counting per
 * run, not per loaded file, keeps the names when a library is loaded once
 * for several importers (the background's module cache). `globalStore`
 * isn't counted (its id names it) and stays `own`'s.
 */
export function tweakStores(file: string, own: StoreRun, run: () => StoreRun | undefined, isStub: (x: unknown) => boolean = () => false): TweakStores {
    const unnamed = (kind: "tabStore" | "pageStore" | "siteStore") => (initial: object) => {
        const r = run() ?? own;
        const n = r.counts.get(file) ?? 0;
        r.counts.set(file, n + 1);
        return r.stores[kind](`${file}#${n}`, initial);
    };
    return {
        globalStore: (id: string, initial: object, opts?: unknown) => {
            if (!isStub(id)) {
                checkStoreId(id);
                let ids = globalIds.get(own);
                if (!ids) globalIds.set(own, (ids = new Map()));
                const had = ids.get(id);
                if (had !== undefined)
                    throw new Error(`tweak.globalStore("${id}"): a store ID is used once per tweak — ${had === file ? "this file" : `"${had}"`} already declares it (declare it once, in one module, and import it)`);
                ids.set(id, file);
            }
            return own.stores.globalStore(id, initial, opts);
        },
        tabStore: unnamed("tabStore"),
        pageStore: unnamed("pageStore"),
        siteStore: unnamed("siteStore"),
    };
}
