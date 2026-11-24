/**
 * Compiles a script's source into a {@link CompiledScript}: its metadata, the
 * handlers its top level registered and its exports.
 *
 * {@link compileScript} runs the code (transpiled by {@link toRunnableJs})
 * with `new Function` and a `tweak` built here (on `tweakApi.ts`'s host),
 * collecting what its top level registers. It runs wherever code can be
 * evaluated from the extension's side: the background (MV2: the background
 * page; MV3: the sandbox page, the only context allowed to eval), the
 * overlay frame (`overlayRuntime.ts`) and the `tangitweak/test` harness.
 * Each passes {@link ResApiOverrides} to wire `tweak`'s storage, stores,
 * fetch and logs to its own context. The page hook and the bridge don't use
 * this module: their `tweak` is `pageShim.ts`.
 *
 * Also here:
 *
 * - Imports between scripts and data files ({@link makeModuleResolver}).
 * - Save-time, meta-only compiles that stub what can't be resolved
 *   ({@link compileWithLibs}, {@link compileManyWithLibs},
 *   {@link makeStubModule}).
 * - Static checks for the Problems view ({@link siteProblems},
 *   {@link rulesProblems}, {@link onSiteUses}).
 *
 * @module
 */

import { defaultMeta, finishMeta, type ResMeta } from "./metaParser";
import { PARAM_TYPES, resolveParamValues, serializableParamTree, type ParamDef, type ParamTree } from "./scriptDef";
import { paramsProxy, PARAM_AT_TOP, PARAM_NOT_HERE } from "./paramsProxy";
import { parseShortcut } from "./shortcut";
import { formatLogArgs, makeScriptConsole, type ScriptLogLevel } from "./scriptLog";
import { scriptFunction } from "./scriptFn";
import { callerLine } from "./scriptError";
import { isNetKind, normalizeRoute, placeKeyer, placeKind, placeOf, routeLabel, type PlaceApi, type RouteKind, type RouteMeta } from "./route";
import { removedReplaceResponse, storeRun, tweakHost, tweakStores, type NamedStores, type StoreRun, type TweakHost } from "./tweakApi";
import { inertRemote, NO_SITE_STORE, REMOTE_FROM_BACKGROUND, SITE_NO_HANDLES, SITE_NO_STORES, unusableStore } from "./remote";
import { scriptEnv } from "./scriptEnv";
import { dataFileValue, importLine, importPath, importResolver, isDataSpec } from "./scriptImports";
import { builtinMessage, finalUrl, isNodeBuiltin, isUrlSpec, makePackageLoader, PackageImportError, urlImportMessage, type PackageModules } from "./packageImports";
import { bareImport, bundleOf, dataReader, dependenciesOf, type Bundle } from "./tweakBundle";
import { builtinModule } from "./builtins";
import { builtinSpec } from "./builtinSpecs";
import { proxy } from "valtio/vanilla";
import { ReplicaHub } from "./storeReplica";
import { claimStoreName, storePersist } from "./storeOps";
import { analyzeScript, lintLineWarning, rulesMessage, type LintAnalysis, type NetAnalysis } from "./scriptLint";
import type { StorePersist, WireRequest, WireResponse } from "./wire";
import { fromWireResponse, splitFetchInit, toWireRequest, type WtFetchInit } from "./ttFetch";

export type { DocumentWhen } from "./route";

/**
 * A registered handler function: called with the handler's context (and,
 * for `onResponseBody`, the body).
 */
export type HandlerFn = (...args: any[]) => any;

/** A registered handler and the route it was registered with. */
export interface Routed {
    /** The handler function, as passed to `tweak.<api>(route, fn)`. */
    fn: HandlerFn;
    /** The normalized route, with its registration index, source line and (for page and overlay handlers) its key. */
    route: RouteMeta;
}

/**
 * The handlers a script registered, by kind, in registration order.
 *
 * Registrations stack within a script: several `tweak.onRequest(…)` calls
 * all run, in registration order (the same semantics as across scripts, see
 * `bodyOps.ts`).
 */
export interface ScriptHandlers {
    /** `tweak.onRequest` handlers. */
    onRequest: Routed[];
    /** `tweak.onResponseHeaders` handlers. */
    onResponseHeaders: Routed[];
    /** `tweak.onResponseBody` handlers. */
    onResponseBody: Routed[];
    /**
     * `tweak.onSite` and `tweak.onPage` handlers, which run in the page: in
     * the site's JavaScript world or the isolated one (`route.world`), at
     * `route.when`.
     */
    onDocument: Routed[];
    /** `tweak.onOverlay` handlers, which run in the script's overlay frame above the page. */
    onOverlay: Routed[];
}

/** What {@link compileScript} returns for one script. */
export interface CompiledScript {
    /**
     * The script's routes, whether it is active (registered at least one
     * handler) and the URLs it matches. Its `name` is the default one: the
     * callers use the stored name.
     */
    meta: ResMeta;
    /** The handlers its top level registered; all empty when the compile failed. */
    handlers: ScriptHandlers;
    /**
     * Null when the top level ran. Otherwise the error: `"SyntaxError: <message>
     * (line N)"` when the code didn't transpile, else the thrown error's stack
     * (or the thrown value as a string). The script is then inactive, with no
     * routes, handlers or exports.
     */
    error: string | null;
    /** The original source, as given. */
    code: string;
    /**
     * The parameter definitions its `tweak.params` calls declared (parsers
     * stripped, so it can be stored and messaged), if any. Kept when the
     * compile failed after declaring them.
     */
    paramDefs?: ParamTree;
    /** The module's exports, importable by other scripts; absent when the compile failed. */
    exports?: any;
}

/** Whether the value looks like a Promise: it has a `then` method. */
export function isThenable(v: any): v is Promise<any> {
    return !!v && typeof v.then === "function";
}

/** Whether the value is a function declared `async` (so it always returns a Promise). */
export function isAsyncFn(fn: any): boolean {
    return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

/**
 * How the context running {@link compileScript} wires the script's `tweak`
 * (and its `console` and `import`s). Every field is optional; the defaults
 * keep everything local to this one compiled instance.
 */
export interface ResApiOverrides {
    /** The script's name: labels its stack frames. Default: `""`. */
    name?: string;
    /**
     * `tweak.storage`, the script's key/value storage. Default: none (`get`
     * gives undefined, `set` stores nothing). Either way, a `set` of a
     * `$store:` key (a `tweak.globalStore`'s persisted copy) logs a warning.
     */
    storage?: {
        /** Reads the value stored under `key`. */
        get(key: string): Promise<any>;
        /** Stores `value` under `key`. */
        set(key: string, value: any): Promise<void>;
    };
    /**
     * Receives the script's `tweak.log` and `console.*` output (`source`:
     * `"tweak.log"`, `"console.warn"`, …) and its late-registration errors.
     * Default: the context's own `console`.
     */
    logSink?: (level: ScriptLogLevel, source: string, text: string) => void;
    /** The stored parameter values, applied over the `tweak.params` defaults. */
    paramValues?: Record<string, any>;
    /**
     * Resolves the script's import specifiers (`"./utils"`, `"utils"`) to the
     * modules' exports: its `require`. Default: every import throws.
     */
    importModule?: (spec: string) => any;
    /** `tweak.globalStore`: the script's replicated store. Default: a plain valtio proxy local to this instance. */
    store?: (name: string, initial: object, persist: StorePersist) => object;
    /** `tweak.tabStore`: the script's per-tab store. Default: per-tab copies local to this instance. */
    tabStore?: (name: string, initial: object) => object;
    /** `tweak.pageStore`: the script's per-page store. Default: per-page copies local to this instance. */
    pageStore?: (name: string, initial: object) => object;
    /** `tweak.siteStore`: a mirror of the site world's store. Default (no page here): a store that throws when used. */
    siteStore?: (name: string, initial: object) => object;
    /**
     * Runs `tweak.fetch(…, { from: "background" })`. Default: this context's
     * own `fetch` with `credentials: "include"` and no bypass.
     */
    fetch?: (request: WireRequest, bypass: boolean) => Promise<WireResponse>;
    /**
     * Runs `tweak.fetch` as the page, the overlay's default: set, every
     * `from` but `"background"` goes here. Unset, `from: "page"` throws.
     */
    pageFetch?: {
        /** The page's URL, which relative request URLs resolve against. */
        url: string;
        /** Sends the request as the page; `bypass` keeps every script's handlers off it. */
        fetch: (request: WireRequest, bypass: boolean) => Promise<WireResponse>;
    };
    /**
     * Makes what a `tweak.onSite`, `tweak.onPage` or `tweak.onOverlay`
     * registration returns (its handle). Default: an inert handle whose
     * calls reject.
     */
    remote?: (route: RouteMeta) => any;
    /**
     * Saves a parameter the code assigned (`cfg.on = false`), as the ⚙ panel
     * would; its rejection is ignored. Unset: assigning a parameter throws.
     * Assigning one during the top level always throws.
     */
    setParam?: (key: string, value: any) => Promise<void>;
}

/**
 * The standard {@link ResApiOverrides} for a stored script: `tweak.storage`
 * and the log sink bound to `scriptId`, plus its parameter values, its
 * import resolver and the `extra` fields as given.
 *
 * @param storage Storage for every script, keyed by script id.
 * @param logSink Log for every script, told which one.
 */
export function makeScriptOverrides(
    scriptId: string,
    storage: {
        /** Reads the value script `scriptId` stored under `key`. */
        get(scriptId: string, key: string): Promise<any>;
        /** Stores `v` under `key` for script `scriptId`. */
        set(scriptId: string, key: string, v: any): Promise<void>;
    },
    logSink: (scriptId: string, level: ScriptLogLevel, source: string, text: string) => void,
    paramValues?: Record<string, any>,
    importModule?: (spec: string) => any,
    extra?: Pick<ResApiOverrides, "store" | "tabStore" | "pageStore" | "fetch" | "setParam">
): ResApiOverrides {
    return {
        ...extra,
        storage: {
            get: (key: string) => storage.get(scriptId, key),
            set: (key: string, value: any) => storage.set(scriptId, key, value),
        },
        logSink: (level, source, text) => logSink(scriptId, level, source, text),
        paramValues,
        importModule,
    };
}

/** Turns a script's TypeScript (and JSX) source into JavaScript; throws on a syntax error. */
type Transpiler = (code: string) => string;
let transpiler: Transpiler | null = null;

/**
 * Registers the transpiler that {@link toRunnableJs} and the compilers use
 * and empties the transpile cache. `transpile.ts` calls it when imported
 * (the background, the MV3 sandbox page, the test harness); contexts that
 * don't import it run code as given.
 */
export function setTranspiler(fn: Transpiler): void {
    transpiler = fn;
    runnable.clear();
    runnableChars = 0;
}

// The same source is transpiled again and again (each dependant's compile,
// each strategy, each frame's bundle): keep the results, most recently used
// last, dropping the least recently used past RUNNABLE_MAX_CHARS.
const runnable = new Map<string, { js: string; syntax: unknown }>();
let runnableChars = 0;
/** The transpile cache's budget: the total length of the sources and their outputs it keeps, in UTF-16 code units. The latest entry is always kept. */
const RUNNABLE_MAX_CHARS = 8_000_000;

/** The transpiled code and the transpiler's error, if any (the code then runs as written), from the cache when possible. */
function runnableOf(code: string): { js: string; syntax: unknown } {
    const hit = runnable.get(code);
    if (hit) {
        runnable.delete(code);
        runnable.set(code, hit);
        return hit;
    }
    let js = code;
    let syntax: unknown = null;
    try {
        if (transpiler) js = transpiler(code);
    } catch (e) {
        syntax = e;
        js = code;
    }
    const out = { js, syntax };
    runnable.set(code, out);
    runnableChars += code.length + out.js.length;
    for (const [k, v] of runnable) {
        if (runnableChars <= RUNNABLE_MAX_CHARS || runnable.size <= 1) break;
        runnable.delete(k);
        runnableChars -= k.length + v.js.length;
    }
    return out;
}

/**
 * Returns a script's source as JavaScript: transpiled where a transpiler is
 * registered ({@link setTranspiler}), with the formatting preserved;
 * unchanged where none is (those contexts receive transpiled code) or when
 * it fails to transpile. Results are cached by source.
 */
export function toRunnableJs(code: string): string {
    return runnableOf(code).js;
}

/**
 * Compiles a script from its full source: runs its top level synchronously
 * with a `tweak` wired by `overrides` and collects what it registers.
 *
 * A script is active when its top level registers at least one handler. One
 * that registers nothing (a module or an entry whose handlers are off for
 * its current params) compiles inactive: its exports are importable and its
 * params allowed. Registrations after the top level has finished (after an
 * `await`, in a callback) are ignored and logged as errors.
 *
 * Never throws: a syntax error or an error thrown by the top level becomes
 * {@link CompiledScript.error}.
 */
export function compileScript(code: string, overrides?: ResApiOverrides): CompiledScript {
    const meta = defaultMeta();
    const owner = createOwner(overrides?.paramValues);
    const store = createCollector();
    let syntax: any = null;
    try {
        const r = runnableOf(code);
        syntax = r.syntax;
        const js = r.js;
        const moduleObj = { exports: {} as any };
        // eslint-disable-next-line no-new-func
        const fn = scriptFunction(js, overrides?.name ?? "");
        const shim = makeShim(owner, overrides, overrides?.name ?? "");
        const requireShim = overrides?.importModule
            ? overrides.importModule
            : (spec: string) => {
                  throw new Error(`cannot import "${spec}" here — imports resolve in the background/hook contexts`);
              };
        withCollector(store, { name: overrides?.name ?? "", remote: overrides?.remote, run: shim.run, host: shim.host }, () => fn(shim.host, makeForwardingConsole(overrides?.logSink), requireShim, moduleObj, moduleObj.exports));
        meta.routes = routesOf(store);
        finishMeta(meta);
        return { meta, handlers: store, error: null, code, paramDefs: owner.defs, exports: moduleObj.exports };
    } catch (e: any) {
        meta.routes = [];
        finishMeta(meta);
        // The raw TS that the failed transpile left is rejected wherever its
        // first type is, without a position: the transpiler's error has the real one.
        const at = e?.name === "SyntaxError" && syntax?.loc?.line;
        const error = at ? `SyntaxError: ${String(syntax.message).replace(/\s*\(\d+:\d+\)$/, "")} (line ${at})` : e && e.stack ? e.stack : String(e);
        return { meta, handlers: emptyHandlers(), error, code, paramDefs: owner.defs };
    }
}

/**
 * Runs a tweak's module (a file its entry imports) with the `tweak` of the
 * tweak whose top level is running, so what it registers, its params and its
 * stores are that tweak's. The overlay uses it for the libraries its entry
 * imports.
 *
 * @param require The module's own `require`.
 * @param moduleObj The module's `module`; its code fills `exports`.
 * @param logSink Receives the module's `console` output. Default: the context's `console`.
 * @returns False, without running anything, when no top level is running.
 */
export function runInTweak(
    code: string,
    name: string,
    require: (spec: string) => any,
    moduleObj: {
        /** The module's exports, set or filled by its code. */
        exports: any;
    },
    logSink?: ResApiOverrides["logSink"]
): boolean {
    const top = collectors[collectors.length - 1];
    const host = top && collectorOf.get(top)?.host;
    if (!host) return false;
    scriptFunction(runnableOf(code).js, name)(host, makeForwardingConsole(logSink), require, moduleObj, moduleObj.exports);
    return true;
}

const stubs = new WeakSet<object>();

/** Whether the value came from a stubbed import (meta-only compiles). */
function isStub(x: unknown): boolean {
    return typeof x === "function" && stubs.has(x as object);
}

/** Whether a route mentions a stubbed import: its real value is only known once imports resolve. */
function mentionsStub(route: unknown): boolean {
    if (isStub(route)) return true;
    const parts: unknown[] = Array.isArray(route) ? route : route && typeof route === "object" ? [(route as any).url, (route as any).exclude] : [];
    return parts.some((p) => isStub(p) || (Array.isArray(p) && p.some(isStub)));
}

/**
 * Makes a module stub for meta-only compiles (save time): an import that
 * can't be resolved gives this, so top-level code that uses its exports
 * doesn't throw before its handlers register.
 *
 * Every property of the stub is the stub, calling it returns the stub and it
 * converts to `""`. The compiler recognizes it: params, stores and routes
 * built from it are left unknown instead of failing.
 */
export function makeStubModule(): any {
    const stub: any = new Proxy(function () {}, {
        get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
        apply: () => stub,
    });
    stubs.add(stub);
    return stub;
}

/** A data file as the compilers see it. */
export interface DataFileSource {
    /** Its path, with its extension (`.json`, `.svg`, …). */
    path: string;
    /** Its stored text (a raster image's `data:` URL). */
    text: string;
}

/**
 * The data files `extra` over `stored`: an `extra` file replaces the stored
 * one with the same path (compared case-insensitively). The `extra` files
 * come first.
 */
export function withData(stored: DataFileSource[], extra: DataFileSource[] | undefined): DataFileSource[] {
    if (!extra?.length) return stored;
    const paths = new Set(extra.map((d) => d.path.toLowerCase()));
    return [...extra, ...stored.filter((d) => !paths.has(d.path.toLowerCase()))];
}

/**
 * Importing a data file failed (missing, invalid JSON). Never stubbed:
 * the importer (transitively) fails to compile, positioned at its import
 * line (`(line N)`, rewritten at each level as it propagates).
 */
class DataFileImportError extends Error {
    fatalImport = true;
}

/** Importing a file outside the importer's bundle (its tweak's folder). Never stubbed. */
class BundleImportError extends Error {
    fatalImport = true;
}

/**
 * Whether an import error must fail the importer's compile, even where
 * unresolved imports are stubbed: a data file, package or bundle import
 * error (see `PackageImportError`).
 */
export function isFatalImportError(e: unknown): boolean {
    return !!(e && (e as any).fatalImport === true);
}

/** Sets `e`'s stack to its message plus the line where `code` imports `spec` (`(line N)`), when found. */
function at(e: any, code: string | undefined, spec: string): any {
    const line = code === undefined ? undefined : importLine(code, spec);
    e.stack = line ? `Error: ${e.message} (line ${line})` : `Error: ${e.message}`;
    return e;
}

/** The offset of the first character `JSON.parse` rejects in `text` (V8's "Unexpected token" message has no position). */
function jsonErrorOffset(text: string): number {
    let i = 0;
    const fail = (): never => {
        throw i;
    };
    const ws = () => {
        while (" \t\n\r".includes(text[i] ?? "x")) i++;
    };
    const str = () => {
        for (i++; text[i] !== '"'; i++) {
            if (i >= text.length || text[i] < " ") fail();
            if (text[i] === "\\") i++;
        }
        i++;
    };
    const value = (): void => {
        ws();
        const c = text[i];
        if (c === '"') return str();
        if (c !== "{" && c !== "[") {
            const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
            if (!m) fail();
            i += m![0].length;
            return;
        }
        const close = c === "{" ? "}" : "]";
        i++;
        ws();
        if (text[i] === close) return void i++;
        for (;;) {
            if (c === "{") {
                ws();
                if (text[i] !== '"') fail();
                str();
                ws();
                if (text[i] !== ":") fail();
                i++;
            }
            value();
            ws();
            if (text[i] === close) return void i++;
            if (text[i] !== ",") fail();
            i++;
        }
    };
    try {
        value();
        ws();
        return i;
    } catch (at) {
        return at as number;
    }
}

/**
 * Formats a `JSON.parse` error as `"<path>:<line>:<col> is not valid JSON"`
 * plus the reason. The position comes from V8's "at position N", Firefox's
 * "line L column C" or, failing both, {@link jsonErrorOffset}.
 */
function jsonError(path: string, text: string, e: any): string {
    const msg = String(e?.message ?? e);
    let line: number;
    let col: number;
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const pos = /at position (\d+)/.exec(msg);
    if (lc) [line, col] = [Number(lc[1]), Number(lc[2])];
    else {
        const off = pos ? Number(pos[1]) : /end of (JSON )?(input|data)/i.test(msg) ? text.length : jsonErrorOffset(text);
        const before = text.slice(0, off).split("\n");
        [line, col] = [before.length, before[before.length - 1].length + 1];
    }
    const clean = msg
        .replace(/^JSON\.parse:\s*/, "")
        .replace(/\s*(in JSON )?at position \d+.*$/, "")
        .replace(/\s*at line \d+ column \d+.*$/, "")
        .replace(/, "[\s\S]*" is not valid JSON$/, "");
    return `${path}:${line}:${col} is not valid JSON — ${clean}`;
}

/**
 * Parses a data file's text, afresh for each import so that handlers
 * mutating the value don't leak into other scripts.
 *
 * @throws DataFileImportError when it isn't valid JSON.
 */
function parseDataFile(spec: string, d: DataFileSource): any {
    try {
        return dataFileValue(d.path, d.text);
    } catch (e) {
        throw new DataFileImportError(`cannot import "${spec}": ${jsonError(d.path, d.text, e)}`);
    }
}

/**
 * Makes a module registry over the stored scripts and data files, which
 * gives each script its `require`.
 *
 * - An import resolves like TypeScript (`scriptImports.ts`): relative to the
 *   importer's folder, bare from the root, case-insensitively; `"./x"` and
 *   `"x.ts"` match the script named "x", `"./a.json"` the data file.
 * - Built-ins (`react`, `valtio`, …) resolve to the extension's own copies,
 *   unless a script or data file has that path.
 * - A bundle's bare import loads its `package.json` dependency's downloaded
 *   package (`packageImports.ts`); a URL import fails.
 * - Libraries run lazily and once, then are cached; during a script's top level
 *   they run with that script's `tweak` and are cached for that run only,
 *   so what they register, their params and their stores are its. A
 *   circular import gets the partially initialized exports.
 *
 * Errors thrown by an import (unknown script, missing data file or bad JSON,
 * a package not downloaded yet, a file outside the tweak's folder) get the
 * importer's `(line N)` when they must fail it ({@link isFatalImportError}).
 *
 * @param scripts The stored scripts; the first one with a given name wins.
 * @param overridesFor The {@link ResApiOverrides} a library runs with outside a top level.
 * @returns `resolveFrom(name)`, the `require` of the script named `name`;
 *   `resolve`, which resolves from the root; and `deps`, which collects the
 *   imported script names, data file paths, `package.json` paths and package
 *   URLs (with a cached library's own deps added for each importer; callers
 *   clear it between scripts).
 */
export function makeModuleResolver(
    scripts: {
        /** The script's id. */
        id: string;
        /** The script's name (its path). */
        name: string;
        /** The script's source. */
        code: string;
    }[],
    overridesFor: (s: {
        /** The library's id. */
        id: string;
        /** The library's name. */
        name: string;
        /** The library's source. */
        code: string;
    }) => ResApiOverrides,
    opts?: {
        /** Meta-only compiles: an unknown script import, a built-in that can't load and a library that throws give a stub ({@link makeStubModule}) instead of an error. */
        stubUnresolved?: boolean;
        /** The data files scripts can import. */
        dataFiles?: DataFileSource[];
        /** The downloaded packages bare imports load. */
        packages?: PackageModules;
    }
): {
    /** The `require` of a script at the root. */
    resolve: (spec: string) => any;
    /** The `require` of the script named `importer` (one per name). */
    resolveFrom: (importer: string) => (spec: string) => any;
    /** What the imports resolved so far used. */
    deps: Set<string>;
} {
    // A bundle's modules run once per entry run, with the entry's `tweak`: their
    // registrations, params and stores are the entry's (so a module cached
    // for another run would miss them). Outside a run (a late import), once.
    const shared = { cache: new Map<string, any>(), compiling: new Set<string>() };
    const perRun = new WeakMap<ScriptHandlers, typeof shared>();
    const runOf = (): { modules: typeof shared; host?: TweakHost } => {
        const top = collectors[collectors.length - 1];
        const host = top && collectorOf.get(top)?.host;
        if (!host) return { modules: shared };
        let m = perRun.get(top);
        if (!m) perRun.set(top, (m = { cache: new Map(), compiling: new Set() }));
        return { modules: m, host };
    };
    const deps = new Set<string>();
    // What each library imports, transitively: a second importer of a cached
    // library gets its deps too (callers clear `deps` between scripts).
    const libDeps = new Map<string, Set<string>>();
    const loading: Set<string>[] = [];
    const addDep = (d: string) => {
        deps.add(d);
        for (const f of loading) f.add(d);
    };
    const dataFiles = opts?.dataFiles || [];
    const read = dataReader(dataFiles);
    const bundles = new Map<string, Bundle | undefined>();
    const bundleFor = (name: string) => {
        if (!bundles.has(name)) bundles.set(name, bundleOf(name, read));
        return bundles.get(name);
    };
    const lookup = importResolver(
        scripts.map((s) => s.name),
        dataFiles.map((d) => d.path)
    );
    const byName = new Map<string, { id: string; name: string; code: string }>();
    for (const s of scripts) if (!byName.has(s.name)) byName.set(s.name, s);
    // A downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself.
    const loadPackage = makePackageLoader(opts?.packages, (spec, from) => {
        if (!builtinSpec(spec) || /^https:\/\/unpkg\.com\/(react|react-dom|scheduler|valtio)@/.test(from)) return undefined;
        return { module: builtinModule(spec) };
    });
    const requires = new Map<string, (spec: string) => any>();
    const resolveFrom = (importer: string): ((spec: string) => any) => {
        let r = requires.get(importer);
        if (!r) requires.set(importer, (r = (spec) => {
            try {
                return load(importer, spec);
            } catch (e) {
                throw isFatalImportError(e) ? at(e, byName.get(importer)?.code, spec) : e;
            }
        }));
        return r;
    };
    const load = (importer: string, spec: string): any => {
        if (builtinSpec(spec) && (isUrlSpec(spec) || !lookup(importer, spec))) {
            try {
                return builtinModule(spec, byName.get(importer)?.code);
            } catch (e: any) {
                if (isFatalImportError(e)) throw e;
                if (opts?.stubUnresolved) return makeStubModule(); // Meta-only, React not loaded.
                throw new PackageImportError(e?.message ?? String(e));
            }
        }
        if (isUrlSpec(spec)) throw new PackageImportError(urlImportMessage(spec));
        const bare = bareImport(importer, spec, read);
        if (bare) {
            addDep(bare.pkgPath);
            if ("error" in bare) throw new PackageImportError(bare.error);
            addDep(bare.url);
            if (!finalUrl(opts?.packages, bare.url) && !opts?.packages?.failed?.[bare.url]) throw new PackageImportError(`cannot import "${spec}": not downloaded yet — save the tweak to download it`);
            return loadPackage(bare.url, dependenciesOf(importer, read));
        }
        const found = lookup(importer, spec);
        if (!found) {
            if (isDataSpec(spec)) {
                const path = importPath(importer, spec);
                throw new DataFileImportError(`cannot import "${spec}": ${path ? `no data file "${path}"` : "the path goes above the root folder"}`);
            }
            if (opts?.stubUnresolved) return makeStubModule();
            const home = bundleFor(importer);
            if (home && !/^[./]/.test(spec))
                throw new Error(isNodeBuiltin(spec) ? builtinMessage(spec) : `cannot import "${spec}": add it to the "dependencies" in ${home.pkgPath}`);
            throw new Error(`unknown module "${spec}" — no script named "${spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "")}"`);
        }
        const home = bundleFor(importer);
        const target = found.kind === "data" ? found.path : found.name;
        if (home && !target.toLowerCase().startsWith(home.root.toLowerCase()))
            throw new BundleImportError(`cannot import "${spec}": "${target}" is outside the tweak's folder${home.root ? ` (${home.root})` : ""} — a tweak imports its own files, built-ins and its package.json dependencies`);
        if (found.kind === "data") {
            addDep(found.path);
            return parseDataFile(spec, dataFiles.find((d) => d.path === found.path)!);
        }
        const key = found.name;
        const { modules, host } = runOf();
        const { cache, compiling } = modules;
        if (cache.has(key)) {
            addDep(key);
            for (const d of libDeps.get(key) ?? []) addDep(d);
            return cache.get(key);
        }
        const lib = byName.get(key)!;
        addDep(lib.name);
        if (compiling.has(key)) return cache.get(key); // A cycle: partial exports.
        compiling.add(key);
        const own = new Set<string>();
        libDeps.set(key, own);
        const moduleObj = { exports: {} as any };
        cache.set(key, moduleObj.exports); // Early, for cycles.
        const js = toRunnableJs(lib.code);
        // eslint-disable-next-line no-new-func
        const libOverrides = overridesFor(lib);
        // The lib's own top-level registrations make IT active (it's compiled
        // on its own as a script too); recipes it exports and the importer
        // calls register into the importer's collector.
        loading.push(own);
        try {
            if (host) scriptFunction(js, lib.name)(host, makeForwardingConsole(libOverrides.logSink), resolveFrom(lib.name), moduleObj, moduleObj.exports);
            else {
                const shim = makeShim(createOwner(libOverrides.paramValues), libOverrides, lib.name);
                withCollector(createCollector(), { name: lib.name, remote: libOverrides.remote, run: shim.run }, () =>
                    scriptFunction(js, lib.name)(
                        shim.host,
                        makeForwardingConsole(libOverrides.logSink),
                        resolveFrom(lib.name),
                        moduleObj,
                        moduleObj.exports
                    )
                );
            }
        } catch (e) {
            loading.splice(loading.indexOf(own), 1);
            compiling.delete(key);
            if (isFatalImportError(e)) {
                cache.delete(key);
                throw e;
            }
            if (!opts?.stubUnresolved) throw e;
            // Meta-only: a broken library is inert, not the importer's compile error.
            const stub = makeStubModule();
            cache.set(key, stub);
            return stub;
        }
        loading.splice(loading.indexOf(own), 1);
        compiling.delete(key);
        cache.set(key, moduleObj.exports);
        return moduleObj.exports;
    };
    return { resolve: resolveFrom(""), resolveFrom, deps };
}

/**
 * Compiles one script against the stored scripts for its metadata (save
 * time). Its imports resolve to the real libraries where they exist, so
 * params and routes built from imported values (a param definition exported
 * by a module) are captured. They resolve to silent stubs otherwise
 * ({@link makeStubModule}); data file, package and bundle import errors
 * still fail it.
 *
 * @param target The script to compile; it replaces any stored script with the same id.
 * @param scripts The stored scripts.
 * @param paramValues The stored parameter values, by script id.
 * @returns The compile, plus `deps`: what it imports (see {@link makeModuleResolver}).
 */
export function compileWithLibs(
    target: {
        /** The script's id. */
        id: string;
        /** The script's name (its path). */
        name: string;
        /** The script's source. */
        code: string;
    },
    scripts: {
        /** The script's id. */
        id: string;
        /** The script's name (its path). */
        name: string;
        /** The script's source. */
        code: string;
    }[],
    paramValues?: { [scriptId: string]: Record<string, any> | undefined },
    dataFiles?: DataFileSource[],
    packages?: PackageModules
): CompiledScript & {
    /** What the script imports: script names, data file paths, `package.json` paths and package URLs. */
    deps: string[];
} {
    const resolver = makeModuleResolver(
        [target, ...scripts.filter((s) => s.id !== target.id)],
        (lib) => ({ paramValues: paramValues?.[lib.id] }),
        { stubUnresolved: true, dataFiles, packages }
    );
    const c = compileScript(target.code, { name: target.name, importModule: resolver.resolveFrom(target.name), paramValues: paramValues?.[target.id] });
    return { ...c, deps: [...resolver.deps] };
}

/**
 * {@link compileWithLibs} for several of the stored scripts at once (when a
 * library changed: every script importing it), with one resolver, so each
 * library is transpiled and run once for all of them.
 *
 * @param ids The scripts to compile; ids not in `scripts` are skipped.
 * @returns Each compile, by script id.
 */
export function compileManyWithLibs(
    ids: string[],
    scripts: {
        /** The script's id. */
        id: string;
        /** The script's name (its path). */
        name: string;
        /** The script's source. */
        code: string;
    }[],
    paramValues?: { [scriptId: string]: Record<string, any> | undefined },
    dataFiles?: DataFileSource[],
    packages?: PackageModules
): Map<
    string,
    CompiledScript & {
        /** What the script imports: script names, data file paths, `package.json` paths and package URLs. */
        deps: string[];
    }
> {
    const resolver = makeModuleResolver(scripts, (lib) => ({ paramValues: paramValues?.[lib.id] }), { stubUnresolved: true, dataFiles, packages });
    const out = new Map<string, CompiledScript & { deps: string[] }>();
    for (const id of ids) {
        const s = scripts.find((x) => x.id === id);
        if (!s) continue;
        resolver.deps.clear();
        const c = compileScript(s.code, { name: s.name, importModule: resolver.resolveFrom(s.name), paramValues: paramValues?.[s.id] });
        out.set(id, { ...c, deps: [...resolver.deps] });
    }
    return out;
}

/**
 * Wraps a module resolver so an import that fails resolves to a silent stub
 * ({@link makeStubModule}) instead of throwing, for meta capture that must
 * not depend on the import graph: a script whose `import` fails must still
 * run its body so its registrations and params are captured (otherwise it
 * stores with no handlers). A {@link isFatalImportError | fatal} import
 * error (data file, package, bundle) is still thrown.
 */
export function resolveWithStubFallback(resolve: (spec: string) => any): (spec: string) => any {
    return (spec) => {
        try {
            return resolve(spec);
        } catch (e) {
            if (isFatalImportError(e)) throw e;
            return makeStubModule();
        }
    };
}

function emptyHandlers(): ScriptHandlers {
    return createCollector();
}

function createCollector(): ScriptHandlers {
    return {
        onRequest: [],
        onResponseHeaders: [],
        onResponseBody: [],
        onDocument: [],
        onOverlay: [],
    };
}

/** The `console` a compiled script gets: one writing to `sink` (the context's own when there is none). */
function makeForwardingConsole(sink?: ResApiOverrides["logSink"]): Console {
    return sink ? makeScriptConsole(sink) : console;
}

/**
 * The collector stack: registrations go to the script whose top level is
 * running right now (recipes exported by a module and called from an
 * importer's top level belong to the importer). Empty: too late, nothing
 * registers.
 */
const collectors: ScriptHandlers[] = [];
/** A collector's script: its name, its handles (`remote`), its stores and its handler and store names (one numbering per script run). */
type CollectorOwner = { name: string; remote?: ResApiOverrides["remote"]; run: StoreRun; host?: TweakHost };
const collectorOf = new WeakMap<ScriptHandlers, CollectorOwner & { keyOf: ReturnType<typeof placeKeyer> }>();

/** Runs `run` with `c` as the current collector, owned by `owner`. */
function withCollector<T>(c: ScriptHandlers, owner: CollectorOwner, run: () => T): T {
    if (!collectorOf.has(c)) collectorOf.set(c, { ...owner, keyOf: placeKeyer() });
    collectors.push(c);
    try {
        return run();
    } finally {
        collectors.pop();
    }
}

/** Every handler's route, by kind. */
function routesOf(h: ScriptHandlers): RouteMeta[] {
    return [...h.onRequest, ...h.onResponseHeaders, ...h.onResponseBody, ...h.onDocument, ...h.onOverlay].map((x) => x.route);
}

/** The per-script state behind `tweak.params`: the definitions declared so far, checked as they come. */
function createOwner(storedValues?: Record<string, any>) {
    let defs: ParamTree | undefined;
    const isChildObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && !isStub(v);
    const readGroup = (obj: Record<string, any>, where: string, prefix: string): { known: ParamTree; unknown: Record<string, any> } => {
        const known: ParamTree = {};
        const unknown: Record<string, any> = {};
        for (const [k, d] of Object.entries(obj)) {
            const label = prefix ? `${prefix}.${k}` : k;
            if (!prefix && defs && k in defs) throw new Error(`${where}: parameter "${k}" is already defined`);
            if (isStub(d)) {
                unknown[k] = makeStubModule();
                continue;
            }
            if (!d || typeof d !== "object" || Array.isArray(d)) {
                throw new Error(`${where}: parameter "${label}" needs a type (${PARAM_TYPES.join(", ")})`);
            }
            // A section object holds nested defs/sub-sections (no string/stub `type`); `{ type: { type: "enum", ... } }` is a section with a child named `type`.
            const looksLikeSection = !("type" in d && !isChildObject((d as any).type));
            if (looksLikeSection) {
                const entries = Object.entries(d);
                if (!entries.length || entries.some(([, v]) => !isStub(v) && !isChildObject(v))) {
                    throw new Error(`${where}: parameter "${label}" needs a type (${PARAM_TYPES.join(", ")})`);
                }
                const sub = readGroup(d, where, label);
                if (Object.keys(sub.known).length) known[k] = sub.known;
                if (Object.keys(sub.unknown).length) unknown[k] = sub.unknown;
                continue;
            }
            if (Object.values(d).some(isStub)) {
                unknown[k] = makeStubModule();
                continue;
            }
            if (!PARAM_TYPES.includes((d as any).type)) {
                throw new Error(`${where}: parameter "${label}" needs a type (${PARAM_TYPES.join(", ")})`);
            }
            if ((d as any).type === "enum" && !Array.isArray((d as any).choices)) throw new Error(`${where}: enum parameter "${label}" needs choices`);
            if ((d as any).type === "shortcut" && (d as any).default !== undefined && (d as any).default !== "") {
                try {
                    parseShortcut((d as any).default);
                } catch (e: any) {
                    throw new Error(`${where}: shortcut parameter "${label}": ${String(e?.message ?? e).replace(/^ctx\.shortcut: /, "")}`);
                }
            }
            known[k] = d as ParamDef;
        }
        return { known, unknown };
    };
    return {
        /** Declares `next`: returns its defs (with their parsers), their raw values and the stubbed ones' values. Throws on an invalid or repeated definition. */
        declare(next: ParamTree, where: string): { known: ParamTree; raw: Record<string, any>; unknown: Record<string, any> } {
            // Defs that come from a stubbed import (meta-only compiles) are
            // unknown here, not invalid: skip them (their values read as
            // stubs) instead of failing the whole script.
            if (isStub(next)) return next as any;
            if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`${where}: expected an object of parameter definitions`);
            // `known` keeps the parsers (to resolve values); `defs` (stored,
            // messaged, diffed) holds them stripped.
            const { known, unknown } = readGroup(next, where, "");
            if (Object.keys(known).length) defs = { ...(defs || {}), ...serializableParamTree(known) };
            return { known, raw: resolveParamValues(known, storedValues), unknown };
        },
        get defs() {
            return defs;
        },
    };
}

/**
 * Makes `tweak.globalStore`, `tweak.tabStore`, `tweak.pageStore` (each name
 * once, across all three) and `tweak.siteStore` (its own names) for one
 * compiled instance, by name (`tweakStores` names the unnamed ones).
 */
function makeStores(overrides?: ResApiOverrides): NamedStores {
    const names = new Map<string, string>();
    const siteNames = new Map<string, string>();
    let local: ReplicaHub | null = null;
    return {
        globalStore: (name, initial, opts) => {
            // Save-time compile: arguments built from a stubbed import aren't known yet.
            if (isStub(name) || isStub(initial) || isStub(opts)) return makeStubModule();
            claimStoreName(names, "tweak.globalStore", name, initial);
            const persist = storePersist(name, opts, "tweak.globalStore");
            const out = overrides?.store ? overrides.store(name, initial, persist) : proxy(initial);
            const top = collectors[collectors.length - 1];
            if (top) (top as ScriptHandlers & { hasGlobalStore?: boolean }).hasGlobalStore = true;
            names.set(name, "tweak.globalStore");
            return out;
        },
        tabStore: (name, initial) => {
            if (isStub(initial)) return makeStubModule();
            claimStoreName(names, "tweak.tabStore", name, initial);
            const out = overrides?.tabStore ? overrides.tabStore(name, initial) : (local ??= new ReplicaHub({ ctx: "local" })).tabStore("local", name, initial);
            names.set(name, "tweak.tabStore");
            return out;
        },
        pageStore: (name, initial) => {
            if (isStub(initial)) return makeStubModule();
            claimStoreName(names, "tweak.pageStore", name, initial);
            const out = overrides?.pageStore ? overrides.pageStore(name, initial) : (local ??= new ReplicaHub({ ctx: "local" })).pageStore("local", name, initial);
            names.set(name, "tweak.pageStore");
            return out;
        },
        siteStore: (name, initial) => {
            if (isStub(initial)) return makeStubModule();
            claimStoreName(siteNames, "tweak.siteStore", name, initial);
            const out = overrides?.siteStore ? overrides.siteStore(name, initial) : unusableStore(NO_SITE_STORE);
            siteNames.set(name, "tweak.siteStore");
            return out;
        },
    };
}

/** Makes `tweak.fetch` for background code or for the overlay (with `pageFetch`). */
function makeFetch(overrides?: ResApiOverrides): (input: RequestInfo | URL, init?: WtFetchInit) => Promise<Response> {
    return async (input, init) => {
        const { init: rest, from, bypass } = splitFetchInit(init);
        const page = overrides?.pageFetch;
        if (page && from !== "background") return fromWireResponse(await page.fetch(await toWireRequest(input, rest, page.url), bypass));
        if (from === "page") throw new Error(`tweak.fetch: from: "page" fetches as the page, which only an overlay (tweak.onOverlay) can do — background code uses from: "background"`);
        if (!overrides?.fetch) return fetch(input, { credentials: "include", ...rest });
        return fromWireResponse(await overrides.fetch(await toWireRequest(input, rest), bypass));
    };
}

/** Wraps `tweak.storage` to warn on `set("$store:…")`, which writes behind a store's back (the store owns the key). */
function guardStoreKeys(storage: { get(key: string): any; set(key: string, value: any): any }, overrides?: ResApiOverrides) {
    return {
        get: (key: string) => storage.get(key),
        set: (key: string, value: any) => {
            if (typeof key === "string" && key.startsWith("$store:")) {
                const msg = `tweak.storage.set("${key}"): that key is the persisted copy of tweak.globalStore("${key.slice(7)}") — change the store instead (the store overwrites this on its next save)`;
                if (overrides?.logSink) overrides.logSink("warn", "tweak.storage", msg);
                else console.warn("[TangiTweak]", msg);
            }
            return storage.set(key, value);
        },
    };
}

/**
 * Makes the host a script's code runs with (each file's `tweak`, all with
 * the same internals: stores, params, handler collection) and its run (its
 * stores and how many unnamed ones each file made, at its top level and in
 * late calls).
 *
 * @param module The script or library whose code this shim is given to.
 */
function makeShim(owner: ReturnType<typeof createOwner>, overrides: ResApiOverrides | undefined, module: string): { host: TweakHost; run: StoreRun } {
    const running = () => {
        const top = collectors[collectors.length - 1];
        return top && collectorOf.get(top);
    };
    const register = (kind: RouteKind, api?: PlaceApi, file?: string) => (route: unknown, fn: unknown) => {
        const name = api || kind;
        const top = collectors[collectors.length - 1];
        const c = top && collectorOf.get(top);
        // A library's exported function, called from the script's top level: numbered in the library, the script's handle.
        const lib = c && c.name !== module ? module : undefined;
        const toRemote = lib !== undefined ? c!.remote : overrides?.remote;
        // Page and overlay registrations hand back an RPC handle; in the background it's inert.
        const remote = (r?: RouteMeta) => (!api ? undefined : r && toRemote ? toRemote(r) : inertRemote(REMOTE_FROM_BACKGROUND));
        if (!top) {
            const msg = `tweak.${name} called after the script's top level finished — handlers must be registered synchronously at top level (not after await / in callbacks); ignored`;
            if (overrides?.logSink) overrides.logSink("error", `tweak.${name}`, msg);
            else console.error("[TangiTweak]", msg);
            return remote();
        }
        if (typeof route === "function" && fn === undefined && !mentionsStub(route)) normalizeRoute(kind, route, 0, api); // Throws the "first argument" error.
        if (typeof fn !== "function") throw new Error(`tweak.${name}: second argument must be the handler function`);
        const list = top[kind];
        // Save-time compile with stubbed imports: the route is unknown until analyzed.
        const r: RouteMeta = mentionsStub(route)
            ? { kind, index: list.length, url: [], exclude: [], ...(api === "onSite" || api === "onPage" ? { api, world: api === "onSite" ? "page" : "isolated" } : {}) }
            : normalizeRoute(kind, route, list.length, api);
        const line = callerLine();
        if (line) r.line = line;
        if (api) {
            const k = c!.keyOf(api, lib);
            r.key = k.key;
            if (lib !== undefined) {
                r.lib = lib;
                r.n = k.n;
            } else if (api !== "onOverlay" && k.n !== r.index) r.n = k.n;
        }
        if (lib === undefined && file !== undefined && file !== module) r.file = file;
        list.push({ fn: fn as HandlerFn, route: r });
        return remote(r);
    };
    const run = storeRun(makeStores(overrides));
    const host = tweakHost((file) => ({
        onRequest: register("onRequest", undefined, file),
        onResponseHeaders: register("onResponseHeaders", undefined, file),
        replaceResponse: removedReplaceResponse,
        onResponseBody: register("onResponseBody", undefined, file),
        onSite: register(placeKind("onSite"), "onSite", file),
        onPage: register(placeKind("onPage"), "onPage", file),
        onOverlay: register(placeKind("onOverlay"), "onOverlay", file),
        params: (defs: ParamTree) => {
            const r = owner.declare(defs, "tweak.params");
            if (isStub(r)) return r;
            const setParam = overrides?.setParam;
            return paramsProxy(r.known, r.raw, r.unknown, {
                blocked: () => (collectors.length ? PARAM_AT_TOP : setParam ? undefined : PARAM_NOT_HERE),
                send: (k, v) => void setParam!(k, v).catch(() => {}),
            });
        },
        storage: guardStoreKeys(overrides?.storage || {
            get: () => undefined,
            set: () => undefined,
        }, overrides),
        fetch: makeFetch(overrides),
        log: (...args: any[]) => (overrides?.logSink ? overrides.logSink("info", "tweak.log", formatLogArgs(args)) : console.log("[TangiTweak] tweak.log:", ...args)),
        ...scriptEnv(),
        ...tweakStores(file, run, () => running()?.run, isStub),
    }));
    return { host, run };
}

/**
 * What an onSite handler uses that only trusted code may: stores and
 * handles. Each is named by the variable it is bound to or by the call
 * itself (`tweak.pageStore`, …) when used directly.
 */
export interface SiteUse {
    /** Which `tweak.onSite(` call of the source it is, 0-based. */
    nth: number;
    /** The `tweak.pageStore`s it uses. */
    pageStore: string[];
    /** The `tweak.tabStore`s it uses; absent when none. */
    tabStore?: string[];
    /** The `tweak.globalStore`s it uses. */
    globalStore: string[];
    /** The handles (variables bound to `tweak.onSite`, `tweak.onPage` or `tweak.onOverlay`) it uses. */
    handles: string[];
}

/**
 * For each `tweak.onSite(` call whose handler uses stores (`tweak.pageStore`,
 * `tweak.tabStore`, `tweak.globalStore`) or handles, what it uses: by the
 * variables they're bound to or the calls themselves. Uses in the outside
 * functions it calls or passes count too (`scriptLint.ts`, with scopes
 * resolved, so a local of the same name doesn't).
 *
 * @returns The calls that use any, in source order; none when the code doesn't parse.
 */
export function onSiteUses(code: string): SiteUse[] {
    const a = analyzeScript(code);
    if (!a) return [];
    const out: SiteUse[] = [];
    const names = (u: { name: string }[]) => u.map((x) => x.name);
    for (const s of a.sites) {
        const use: SiteUse = { nth: s.nth, pageStore: names(s.pageStore), globalStore: names(s.globalStore), handles: names(s.handles) };
        if (s.tabStore.length) use.tabStore = names(s.tabStore);
        if (use.pageStore.length || s.tabStore.length || use.globalStore.length || use.handles.length) out.push(use);
    }
    return out;
}

/**
 * Each kept network route's registration call in the analysis: the first
 * `tweak.<api>(` on its line, in the entry's own code (a module's routes
 * aren't in it). Once per call, so a loop registering several routes from
 * one call warns once.
 */
function netCalls(a: LintAnalysis, routes: RouteMeta[], keep: (r: RouteMeta) => boolean): { r: RouteMeta; call: NetAnalysis }[] {
    const out: { r: RouteMeta; call: NetAnalysis }[] = [];
    const seen = new Set<NetAnalysis>();
    for (const r of routes) {
        if (!keep(r) || !r.line || r.file !== undefined) continue;
        const call = a.nets.find((n) => n.api === (r.api || r.kind) && n.line === r.line);
        if (!call || seen.has(call)) continue;
        seen.add(call);
        out.push({ r, call });
    }
    return out;
}

/**
 * Warnings for the Problems view (`"onRequest #N: …"`) about code in `rules`
 * handlers that looks meant to run per request: logging, fetching, timers,
 * store writes (`scriptLint.ts`'s no-rules-side-effects, the outside
 * functions a handler calls included).
 *
 * A rules handler runs once, when scripts load, to compute a fixed browser
 * rule; the browser applies the rule itself, so that code never runs for a
 * request.
 *
 * @param routes The script's compiled routes (`meta.routes`), which give each handler's strategy and line.
 * @returns The warnings; none when no route uses `rules` or the code doesn't parse.
 */
export function rulesProblems(code: string, routes: RouteMeta[]): string[] {
    if (!routes.some((r) => r.strategy === "rules" && r.line)) return [];
    const a = analyzeScript(code);
    if (!a) return [];
    const out: string[] = [];
    for (const { r, call } of netCalls(a, routes, (r) => r.strategy === "rules")) for (const e of call.effects) out.push(rulesMessage(routeLabel(r), e.text, e.does));
    return out;
}

/**
 * Errors for the Problems view (`"onRequest #N: uses \`x\` …"`) about network
 * handlers (found by their registration line, as in {@link rulesProblems})
 * that use `tweak.siteStore`, directly or through a variable bound to it.
 * They have no page, so it throws there.
 */
function netSiteStoreProblems(a: LintAnalysis, routes: RouteMeta[]): string[] {
    const out: string[] = [];
    for (const { r, call } of netCalls(a, routes, (r) => isNetKind(r.kind)))
        if (call.siteStores.length) out.push(`${routeLabel(r)}: uses ${call.siteStores.map((x) => `\`${x.name}\``).join(", ")} — ${NO_SITE_STORE}`);
    return out;
}

/**
 * Problems view lines for a script's page-related mistakes:
 *
 * - Warnings (`"onSite #N: …"`) for onSite handlers that use a store or a
 *   handle: in the site's world stores throw and handle calls throw
 *   (`SiteCannotCallError`).
 * - Errors for network handlers that use `tweak.siteStore` (which needs a
 *   page).
 * - `scriptLint.ts`'s static selector and shortcut checks, as
 *   `"line N (error|warning): …"`.
 *
 * @param routes The script's compiled routes (`meta.routes`).
 * @returns The lines; none when the code mentions none of these APIs or doesn't parse.
 */
export function siteProblems(code: string, routes: RouteMeta[]): string[] {
    const site = /\bonSite\b/.test(code);
    const net = /\bsiteStore\b/.test(code);
    const dom = /\.\s*(?:elements|mount|iframes|shortcut)\b/.test(code);
    if (!site && !net && !dom) return [];
    const a = analyzeScript(code);
    if (!a) return [];
    const out: string[] = net ? netSiteStoreProblems(a, routes) : [];
    const uses = site ? onSiteUses(code) : [];
    const names = (n: string[]) => n.map((x) => `\`${x}\``).join(", ");
    // The code's own calls, in order (a module's, run with its tweak, are numbered with them).
    let nth = 0;
    for (const r of uses.length ? routes : []) {
        if (r.kind !== "onDocument" || placeOf(r) !== "onSite" || r.lib !== undefined || r.file !== undefined) continue;
        const i = nth++;
        const u = uses.find((u) => u.nth === i);
        if (!u) continue;
        const at = `${routeLabel(r)}: `;
        const stores = [...u.pageStore, ...(u.tabStore ?? []), ...u.globalStore];
        if (stores.length) out.push(`${at}uses ${names(stores)} — ${SITE_NO_STORES}`);
        if (u.handles.length) out.push(`${at}uses ${names(u.handles)} — ${SITE_NO_HANDLES}`);
    }
    for (const d of a.checks) out.push(lintLineWarning(d));
    return out;
}
