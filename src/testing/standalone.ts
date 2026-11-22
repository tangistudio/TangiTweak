/**
 * `import { tweak } from "tangitweak"` in plain Vitest tests (plain
 * component tests and plain functions, §6.3–6.4 of the plan): the code is
 * imported by Vitest, not run by the test loader, so nothing here reaches a
 * browser. Stores are plain Valtio objects, params return their defaults,
 * and handlers are recorded but never called.
 *
 * Each store remembers which store it is (StoreIdentity): fixture tests use
 * it to find their own copy of an imported store (`tweak.store(store,
 * page)`), and `renderTweak` to reset stores between tests.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import { proxy } from "valtio/vanilla";
import { resolveParamValues, type ParamTree } from "../shared/scriptDef";
import { scriptEnv } from "../shared/scriptEnv";
import { checkStoreId } from "../shared/tweakApi";
import type { StoreIdentity } from "./index";

export interface StoreRecord {
    identity: StoreIdentity;
    /** the starting value, for resets */
    initial: object;
}

export interface RecordedHandler {
    api: string;
    route: unknown;
    handler: unknown;
}

interface Registry {
    stores: WeakMap<object, StoreRecord>;
    /** every store made, in order (resets) */
    all: object[];
    handlers: RecordedHandler[];
}

const REGISTRY = Symbol.for("tangitweak.stores");

/** the stores made by this package in this test file (one Vitest module graph) */
export function storeRegistry(): Registry {
    const g = globalThis as any;
    return (g[REGISTRY] ??= { stores: new WeakMap(), all: [], handlers: [] });
}

function clone<T>(v: T): T {
    try {
        return structuredClone(v);
    } catch {
        return Array.isArray(v) ? ([...v] as T) : ({ ...(v as object) } as T);
    }
}

/** put every store made here back to its starting value */
export function resetStores(): void {
    const reg = storeRegistry();
    for (const s of reg.all) {
        const rec = reg.stores.get(s)!;
        setStore(s, clone(rec.initial));
    }
}

/** replace a store's contents (keeping the object: components hold it) */
export function setStore(store: object, value: object): void {
    for (const k of Object.keys(store)) if (!(k in value)) delete (store as any)[k];
    Object.assign(store, value);
}

const SELF = nodeUrl.fileURLToPath(import.meta.url);
const bundleOfDir = new Map<string, string | null>();

/** the folder of the nearest tweak package.json above `dir` (one listing "tangitweak" in its dependencies, or with a "tangitweak" block; as packageMetadata's isTweakPackage) */
export function bundleDirOf(dir: string): string | null {
    const hit = bundleOfDir.get(dir);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    try {
        const pkg = JSON.parse(fs.readFileSync(nodePath.join(dir, "package.json"), "utf8"));
        const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
        if (obj(pkg) && (obj(pkg.tangitweak) || (obj(pkg.dependencies) && typeof pkg.dependencies.tangitweak === "string"))) found = dir;
    } catch {}
    if (!found) {
        const up = nodePath.dirname(dir);
        found = up === dir ? null : bundleDirOf(up);
    }
    bundleOfDir.set(dir, found);
    return found;
}

/** the source files on the current call stack, innermost first */
export function stackFiles(stack = new Error().stack || ""): string[] {
    const out: string[] = [];
    for (const line of stack.split("\n").slice(1)) {
        const m = /(?:\(|\s)((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^():?]+)(?:\?[^:)]*)?:\d+:\d+\)?\s*$/.exec(line);
        if (!m) continue;
        const file = m[1].startsWith("file://") ? nodeUrl.fileURLToPath(m[1]) : m[1];
        if (!out.includes(file)) out.push(file);
    }
    return out;
}

/** the calling tweak file, as the loader names it: its path in its bundle, without the extension */
function callerFile(): string {
    for (const file of stackFiles()) {
        if (file === SELF || file.includes(`${nodePath.sep}node_modules${nodePath.sep}`)) continue;
        const bundle = bundleDirOf(nodePath.dirname(file));
        if (!bundle) continue;
        return nodePath.relative(bundle, file).split(nodePath.sep).join("/").replace(/\.[cm]?[jt]sx?$/i, "");
    }
    return "";
}

const counts = new Map<string, number>();
const globalIds = new Set<string>();

function makeStore(identity: StoreIdentity, initial: object): object {
    const reg = storeRegistry();
    const store = proxy(clone(initial));
    reg.stores.set(store, { identity, initial: clone(initial) });
    reg.all.push(store);
    return store;
}

function unnamed(kind: "tabStore" | "pageStore" | "siteStore") {
    return (initial: object) => {
        const file = callerFile();
        const n = counts.get(file) ?? 0;
        counts.set(file, n + 1);
        return makeStore({ kind, file, n }, initial);
    };
}

function record(api: string) {
    return (route: unknown, handler: unknown, maybe?: unknown) => {
        storeRegistry().handlers.push({ api, route, handler: maybe ?? handler });
        if (api === "onSite" || api === "onPage" || api === "onOverlay") return notRunning(api);
        return undefined;
    };
}

/** what a place handler returns here: its calls fail, nothing runs it */
function notRunning(api: string): any {
    return new Proxy(
        {},
        {
            get: (_t, k) =>
                k === "then"
                    ? undefined
                    : () => Promise.reject(new Error(`tweak.${api}: handlers don't run in plain tests — use the "tangitweak/test" fixtures (page, mount) to run them`)),
        }
    );
}

const storage = new Map<string, unknown>();

export const tweak: any = {
    onRequest: record("onRequest"),
    onResponseHeaders: record("onResponseHeaders"),
    replaceResponse: record("replaceResponse"),
    onResponseBody: record("onResponseBody"),
    onSite: record("onSite"),
    onPage: record("onPage"),
    onOverlay: record("onOverlay"),
    params: (defs: ParamTree) => Object.freeze(resolveParamValues(defs, undefined)),
    storage: {
        get: async (key: string) => clone(storage.get(key)),
        set: async (key: string, value: unknown) => void storage.set(key, clone(value)),
    },
    fetch: (input: any, init?: any) => fetch(input, init),
    log: (...args: unknown[]) => console.log("[TangiTweak] tweak.log:", ...args),
    ...scriptEnv(true, false),
    globalStore: (id: string, initial: object) => {
        checkStoreId(id);
        if (globalIds.has(id)) throw new Error(`tweak.globalStore("${id}"): a store ID is used once per tweak — declare it once, in one module, and import it`);
        globalIds.add(id);
        return makeStore({ kind: "globalStore", id }, initial);
    },
    tabStore: unnamed("tabStore"),
    pageStore: unnamed("pageStore"),
    siteStore: unnamed("siteStore"),
};
