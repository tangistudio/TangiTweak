/**
 * Compiles a TangiTweak source into { meta, handlers }.
 * Runs identically in the background (MV3: the sandbox page) and the page
 * hook — each provides its own `tweak` (shim, tweakApi.ts) and re-evaluates
 * handler sources with `new Function`.
 */
import { defaultMeta, finishMeta, type ResMeta } from "./metaParser";
import { PARAM_TYPES, resolveParamValues, serializableParamTree, type ParamDef, type ParamTree } from "./scriptDef";
import { paramsProxy, PARAM_AT_TOP, PARAM_NOT_HERE } from "./paramsProxy";
import { parseShortcut } from "./shortcut";
import { formatLogArgs, makeScriptConsole, type ScriptLogLevel } from "./scriptLog";
import { scriptFunction } from "./scriptFn";
import { callerLine } from "./scriptError";
import { isNetKind, normalizeRoute, placeKeyer, placeKind, placeOf, routeLabel, type PlaceApi, type RouteKind, type RouteMeta } from "./route";
import { storeRun, tweakHost, tweakStores, type NamedStores, type StoreRun, type TweakHost } from "./tweakApi";
import { inertRemote, NO_SITE_STORE, REMOTE_FROM_BACKGROUND, SITE_NO_HANDLES, SITE_NO_STORES, unusableStore } from "./remote";
import { scriptEnv } from "./scriptEnv";
import { dataFileValue, importLine, importPath, importResolver, isDataSpec } from "./scriptImports";
import { builtinMessage, finalUrl, isNodeBuiltin, isUrlSpec, makePackageLoader, PackageImportError, type PackageModules } from "./packageImports";
import { bareImport, bundleOf, dataReader, type Bundle } from "./tweakBundle";
import { builtinModule } from "./builtins";
import { builtinSpec } from "./builtinSpecs";
import { proxy } from "valtio/vanilla";
import { ReplicaHub } from "./storeReplica";
import { claimStoreName, storePersist } from "./storeOps";
import { apiPattern, closeOf, codeOnly } from "./codeScan";
import type { StorePersist, WireRequest, WireResponse } from "./wire";
import { fromWireResponse, splitFetchInit, toWireRequest, type WtFetchInit } from "./ttFetch";

export type { DocumentWhen } from "./route";

export type HandlerFn = (...args: any[]) => any;

/** a registered handler and the route it was registered with */
export interface Routed {
    fn: HandlerFn;
    route: RouteMeta;
}

/**
 * Registrations STACK within a script: multiple tweak.onRequest(...) calls
 * all run, in registration order (same semantics as across scripts).
 */
export interface ScriptHandlers {
    onRequest: Routed[];
    onResponseHeaders: Routed[];
    replaceResponse: Routed[];
    onResponseBody: Routed[];
    /** tweak.onSite / tweak.onPage: run in the page — the site's JS world or the isolated one (route.when = timing, route.world) */
    onDocument: Routed[];
    /** tweak.onOverlay: run in the script's overlay frame above the page */
    onOverlay: Routed[];
}

export interface CompiledScript {
    meta: ResMeta;
    handlers: ScriptHandlers;
    error: string | null;
    /** original full source */
    code: string;
    /** parameter definitions collected from tweak.params (if any) */
    paramDefs?: ParamTree;
    /** the module's exports (utility scripts: importable by others) */
    exports?: any;
}

/** true if the value looks like a Promise (thenable). */
export function isThenable(v: any): v is Promise<any> {
    return !!v && typeof v.then === "function";
}

/** true if the function was declared `async` (returns a Promise by construction). */
export function isAsyncFn(fn: any): boolean {
    return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

export interface ResApiOverrides {
    /** the script's name: labels its stack frames */
    name?: string;
    storage?: { get(key: string): Promise<any>; set(key: string, value: any): Promise<void> };
    /** receives the script's tweak.log and console.* output (source: "tweak.log", "console.warn", …) */
    logSink?: (level: ScriptLogLevel, source: string, text: string) => void;
    /** stored parameter values, merged over tweak.params defaults */
    paramValues?: Record<string, any>;
    /** resolves ES import specifiers ("./utils", "utils") to module exports */
    importModule?: (spec: string) => any;
    /** `tweak.globalStore`: the script's replicated store (default: a plain local valtio proxy) */
    store?: (name: string, initial: object, persist: StorePersist) => object;
    /** `tweak.tabStore`: the script's per-tab store (default: per-tab copies local to this instance) */
    tabStore?: (name: string, initial: object) => object;
    /** `tweak.pageStore`: the script's per-page store (default: per-page copies local to this instance) */
    pageStore?: (name: string, initial: object) => object;
    /** `tweak.siteStore`: a mirror of the site's world's store (default — no page here: a store that throws when used) */
    siteStore?: (name: string, initial: object) => object;
    /** `tweak.fetch(…, { from: "background" })` (default: this context's own fetch, no bypass) */
    fetch?: (request: WireRequest, bypass: boolean) => Promise<WireResponse>;
    /** `tweak.fetch(…, { from: "page" })`, then the default `from` (the overlay); `url` resolves relative URLs */
    pageFetch?: { url: string; fetch: (request: WireRequest, bypass: boolean) => Promise<WireResponse> };
    /** what a `tweak.onSite` / `tweak.onPage` / `tweak.onOverlay` registration returns (default: an inert handle) */
    remote?: (route: RouteMeta) => any;
    /** a param assigned by the code (`cfg.on = false`): save it like the ⚙ panel (absent: params can't change) */
    setParam?: (key: string, value: any) => Promise<void>;
}

/** Standard overrides for a stored script: storage wired by id, log → sink. */
export function makeScriptOverrides(
    scriptId: string,
    storage: { get(scriptId: string, key: string): Promise<any>; set(scriptId: string, key: string, v: any): Promise<void> },
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

type Transpiler = (code: string) => string;
let transpiler: Transpiler | null = null;

/** Register the TS stripper (done by the background via shared/transpile). */
export function setTranspiler(fn: Transpiler): void {
    transpiler = fn;
    runnable.clear();
    runnableChars = 0;
}

// the same source is transpiled again and again (each dependant's compile,
// each strategy, each frame's bundle): keep the results, most recent last
const runnable = new Map<string, { js: string; syntax: unknown }>();
let runnableChars = 0;
const RUNNABLE_MAX_CHARS = 8_000_000;

/** transpiled code, and the transpiler's error (the code then runs as written) */
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
 * Scripts may be written in TypeScript. Where a transpiler was registered
 * (background), types are stripped with formatting preserved; contexts
 * without one (the page hook) receive already-transpiled code.
 */
export function toRunnableJs(code: string): string {
    return runnableOf(code).js;
}

/**
 * Compile from full source. A script is ACTIVE when its top level
 * registers at least one handler; one that registers nothing compiles as
 * a utility module (exports importable, params allowed).
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
        // the raw TS that the failed transpile left is rejected wherever its
        // first type is, without a position: the transpiler's error has the real one
        const at = e?.name === "SyntaxError" && syntax?.loc?.line;
        const error = at ? `SyntaxError: ${String(syntax.message).replace(/\s*\(\d+:\d+\)$/, "")} (line ${at})` : e && e.stack ? e.stack : String(e);
        return { meta, handlers: emptyHandlers(), error, code, paramDefs: owner.defs };
    }
}

/**
 * Run a tweak's module (a file its entry imports) with the `tweak` of the
 * tweak whose top level is running, so what it registers, its params and
 * its stores are that tweak's; false when no top level is running.
 */
export function runInTweak(code: string, name: string, require: (spec: string) => any, moduleObj: { exports: any }, logSink?: ResApiOverrides["logSink"]): boolean {
    const top = collectors[collectors.length - 1];
    const host = top && collectorOf.get(top)?.host;
    if (!host) return false;
    scriptFunction(runnableOf(code).js, name)(host, makeForwardingConsole(logSink), require, moduleObj, moduleObj.exports);
    return true;
}

const stubs = new WeakSet<object>();

/** a value that came from a stubbed import (meta-only compiles) */
function isStub(x: unknown): boolean {
    return typeof x === "function" && stubs.has(x as object);
}

/** a route that mentions a stubbed import — its real value is only known once imports resolve */
function mentionsStub(route: unknown): boolean {
    if (isStub(route)) return true;
    const parts: unknown[] = Array.isArray(route) ? route : route && typeof route === "object" ? [(route as any).url, (route as any).exclude] : [];
    return parts.some((p) => isStub(p) || (Array.isArray(p) && p.some(isStub)));
}

/**
 * Module stub for meta-only compiles (scriptStore.saveScript): imports
 * resolve to a callable/gettable proxy so top-level code that references
 * library exports doesn't throw before its handlers register.
 */
export function makeStubModule(): any {
    const stub: any = new Proxy(function () {}, {
        get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
        apply: () => stub,
    });
    stubs.add(stub);
    return stub;
}

/** a data file as the compilers see it: its path (with `.json`/`.svg`) and text */
export interface DataFileSource {
    path: string;
    text: string;
}

/** `extra` over `stored`, by path */
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

/** an import that leaves the importer's bundle: never stubbed */
class BundleImportError extends Error {
    fatalImport = true;
}

/** a data file or package import error: never stubbed (see PackageImportError) */
export function isFatalImportError(e: unknown): boolean {
    return !!(e && (e as any).fatalImport === true);
}

function at(e: any, code: string | undefined, spec: string): any {
    const line = code === undefined ? undefined : importLine(code, spec);
    e.stack = line ? `Error: ${e.message} (line ${line})` : `Error: ${e.message}`;
    return e;
}

/** offset of the first character `JSON.parse` rejects (V8's "Unexpected token" message has no position) */
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

/** `JSON.parse` error → "path:line:col message" (positions from V8's "at position N", Firefox's "line L column C", or located) */
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

/** parse a data file's text (fresh each import: handlers mutating it don't leak across scripts) */
function parseDataFile(spec: string, d: DataFileSource): any {
    try {
        return dataFileValue(d.path, d.text);
    } catch (e) {
        throw new DataFileImportError(`cannot import "${spec}": ${jsonError(d.path, d.text, e)}`);
    }
}

/**
 * Module registry over the stored scripts and data files: an ES `import`
 * resolves like TypeScript (shared/scriptImports: relative to the
 * importer's folder, bare from the root, case-insensitive, "./x", "x.ts"
 * match the script named "x", "./a.json" the data file). Libs compile
 * lazily and memoize; circular imports get the partially-initialized
 * exports. `resolveFrom(name)` is the `require` of the script named
 * `name`; `resolve` resolves from the root. A URL imports a downloaded
 * package (shared/packageImports). `deps` collects the imported script
 * names, data file paths and package URLs.
 */
export function makeModuleResolver(
    scripts: { id: string; name: string; code: string }[],
    overridesFor: (s: { id: string; name: string; code: string }) => ResApiOverrides,
    opts?: { stubUnresolved?: boolean; dataFiles?: DataFileSource[]; packages?: PackageModules }
): { resolve: (spec: string) => any; resolveFrom: (importer: string) => (spec: string) => any; deps: Set<string> } {
    // a bundle's modules run once per entry run, with the entry's `tweak`: their
    // registrations, params and stores are the entry's (so a module cached
    // for another run would miss them); outside a run (a late import), once
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
    // what each library imports, transitively: a second importer of a cached
    // library gets its deps too (callers clear `deps` between scripts)
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
    // a downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself
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
                return builtinModule(spec, byName.get(importer)?.code, (url) => {
                    addDep(url);
                    return loadPackage(url);
                });
            } catch (e: any) {
                if (isFatalImportError(e)) throw e;
                if (opts?.stubUnresolved) return makeStubModule(); // meta-only, React not loaded
                throw new PackageImportError(e?.message ?? String(e));
            }
        }
        if (isUrlSpec(spec)) {
            addDep(spec);
            return loadPackage(spec);
        }
        const bare = bareImport(importer, spec, read);
        if (bare) {
            addDep(bare.pkgPath);
            if ("error" in bare) throw new PackageImportError(bare.error);
            addDep(bare.url);
            if (!finalUrl(opts?.packages, bare.url) && !opts?.packages?.failed?.[bare.url]) throw new PackageImportError(`cannot import "${spec}": not downloaded yet — save the tweak to download it`);
            return loadPackage(bare.url);
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
        if (compiling.has(key)) return cache.get(key); // cycle: partial exports
        compiling.add(key);
        const own = new Set<string>();
        libDeps.set(key, own);
        const moduleObj = { exports: {} as any };
        cache.set(key, moduleObj.exports); // early, for cycles
        const js = toRunnableJs(lib.code);
        // eslint-disable-next-line no-new-func
        const libOverrides = overridesFor(lib);
        // the lib's own top-level registrations make IT active (it's compiled
        // on its own as a script too); recipes it exports and the importer
        // calls register into the importer's collector
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
            // meta-only: a broken library is inert, not the importer's compile error
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
 * Meta-only compile of one script against the stored scripts (save time):
 * imports resolve to the REAL libraries where a script by that name exists
 * — params/routes built from imported values (e.g. a param definition
 * exported by a utility) are captured — and to silent stubs otherwise.
 * `target` replaces any stored script with the same id.
 */
export function compileWithLibs(
    target: { id: string; name: string; code: string },
    scripts: { id: string; name: string; code: string }[],
    paramValues?: { [scriptId: string]: Record<string, any> | undefined },
    dataFiles?: DataFileSource[],
    packages?: PackageModules
): CompiledScript & { deps: string[] } {
    const resolver = makeModuleResolver(
        [target, ...scripts.filter((s) => s.id !== target.id)],
        (lib) => ({ paramValues: paramValues?.[lib.id] }),
        { stubUnresolved: true, dataFiles, packages }
    );
    const c = compileScript(target.code, { name: target.name, importModule: resolver.resolveFrom(target.name), paramValues: paramValues?.[target.id] });
    return { ...c, deps: [...resolver.deps] };
}

/**
 * `compileWithLibs` for several of the stored scripts at once (a library
 * changed: every script importing it): one resolver, so each library is
 * transpiled and run once for all of them.
 */
export function compileManyWithLibs(
    ids: string[],
    scripts: { id: string; name: string; code: string }[],
    paramValues?: { [scriptId: string]: Record<string, any> | undefined },
    dataFiles?: DataFileSource[],
    packages?: PackageModules
): Map<string, CompiledScript & { deps: string[] }> {
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
 * Wrap a module resolver so unknown/missing imports resolve to a silent
 * stub instead of throwing. Used by the MV3 sandbox analyze path (and
 * anywhere meta capture must not depend on the import graph): a script
 * whose `import` fails must still run its body so its registrations
 * and params are captured — otherwise it silently stores as a utility.
 * A data file or package that fails to import is still the importer's error.
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
        replaceResponse: [],
        onResponseBody: [],
        onDocument: [],
        onOverlay: [],
    };
}

/** Console shadow for compiled scripts: routed into the script's log sink. */
function makeForwardingConsole(sink?: ResApiOverrides["logSink"]): Console {
    return sink ? makeScriptConsole(sink) : console;
}

/**
 * The collector stack: registrations go to the script whose top level is
 * running right now (recipes exported by a utility and called from an
 * importer's top level belong to the importer). Empty = too late.
 */
const collectors: ScriptHandlers[] = [];
/** a collector's script: its name, its handles (`remote`), its stores, and its handler and store names (one numbering per script run) */
type CollectorOwner = { name: string; remote?: ResApiOverrides["remote"]; run: StoreRun; host?: TweakHost };
const collectorOf = new WeakMap<ScriptHandlers, CollectorOwner & { keyOf: ReturnType<typeof placeKeyer> }>();

function withCollector<T>(c: ScriptHandlers, owner: CollectorOwner, run: () => T): T {
    if (!collectorOf.has(c)) collectorOf.set(c, { ...owner, keyOf: placeKeyer() });
    collectors.push(c);
    try {
        return run();
    } finally {
        collectors.pop();
    }
}

function routesOf(h: ScriptHandlers): RouteMeta[] {
    return [...h.onRequest, ...h.onResponseHeaders, ...h.replaceResponse, ...h.onResponseBody, ...h.onDocument, ...h.onOverlay].map((x) => x.route);
}

/** per-script state behind tweak.params */
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
        /** `next` declared: its defs (with their parsers), raw values, and the stubbed ones' values */
        declare(next: ParamTree, where: string): { known: ParamTree; raw: Record<string, any>; unknown: Record<string, any> } {
            // defs that come from a stubbed import (meta-only compiles) are
            // unknown here, not invalid: skip them — their values read as
            // stubs — instead of failing the whole script
            if (isStub(next)) return next as any;
            if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`${where}: expected an object of parameter definitions`);
            // `known` keeps the parsers (to resolve values); `defs` — stored,
            // messaged, diffed — holds them stripped
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
 * `tweak.globalStore`, `tweak.tabStore`, `tweak.pageStore` (each name once,
 * across all three) and `tweak.siteStore` (its own names) for one compiled
 * instance, by name (tweakStores names the unnamed ones)
 */
function makeStores(overrides?: ResApiOverrides): NamedStores {
    const names = new Map<string, string>();
    const siteNames = new Map<string, string>();
    let local: ReplicaHub | null = null;
    return {
        globalStore: (name, initial, opts) => {
            // save-time compile: arguments built from a stubbed import aren't known yet
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

/** `tweak.fetch`: background code, or the overlay (with `pageFetch`) */
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

/** `tweak.storage.set("$store:…")` writes behind a store's back: warn (the store owns the key) */
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
 * `module`: the script or library whose code this shim is given to. Makes
 * the host its code runs with (each file's `tweak`: the same internals —
 * stores, params, handler collection) and its run (its stores, and how many
 * unnamed ones each file made: its top level's, and late calls').
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
        // a library's exported function, called from the script's top level: numbered in the library, the script's handle
        const lib = c && c.name !== module ? module : undefined;
        const toRemote = lib !== undefined ? c!.remote : overrides?.remote;
        // page/overlay registrations hand back an RPC handle; in the background it's inert
        const remote = (r?: RouteMeta) => (!api ? undefined : r && toRemote ? toRemote(r) : inertRemote(REMOTE_FROM_BACKGROUND));
        if (!top) {
            const msg = `tweak.${name} called after the script's top level finished — handlers must be registered synchronously at top level (not after await / in callbacks); ignored`;
            if (overrides?.logSink) overrides.logSink("error", `tweak.${name}`, msg);
            else console.error("[TangiTweak]", msg);
            return remote();
        }
        if (typeof route === "function" && fn === undefined && !mentionsStub(route)) normalizeRoute(kind, route, 0, api); // throws the "first argument" error
        if (typeof fn !== "function") throw new Error(`tweak.${name}: second argument must be the handler function`);
        const list = top[kind];
        // save-time compile with stubbed imports: route unknown until analyzed
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
        replaceResponse: register("replaceResponse", undefined, file),
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

/** what an onSite handler uses that only trusted code may */
export interface SiteUse {
    /** 0-based: which `tweak.onSite(` (or `tweak.onSite(`) call of the source it is */
    nth: number;
    /** the stores it uses: the variable names (or `tweak.pageStore` / `tweak.tabStore` / …), by kind */
    pageStore: string[];
    tabStore?: string[];
    globalStore: string[];
    /** the handles (variables bound to `tweak.onSite` / `tweak.onPage` / `tweak.onOverlay`) it uses */
    handles: string[];
}

/**
 * Per `tweak.onSite(` call, the stores (`tweak.pageStore` / `tweak.tabStore` / `tweak.globalStore`)
 * and handles its arguments use — by the top-level variables they're
 * bound to, or the calls themselves. Only calls that use any. A
 * lightweight scan, not a parser: a local that shadows a name counts too.
 */
export function onSiteUses(code: string): SiteUse[] {
    const src = codeOnly(code);
    const api = apiPattern(code);
    const bound = new Map<string, "pageStore" | "tabStore" | "globalStore" | "handles">();
    for (const m of src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*${api}\\s*\\.\\s*(pageStore|tabStore|globalStore|onSite|onPage|onOverlay)\\b`, "g")))
        bound.set(m[1], m[2] === "pageStore" || m[2] === "tabStore" || m[2] === "globalStore" ? m[2] : "handles");
    const out: SiteUse[] = [];
    let nth = 0;
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${api}\\s*\\.\\s*onSite\\s*(?:<[^()]*>\\s*)?\\(`, "g"))) {
        const from = m.index! + m[0].length;
        const args = src.slice(from, closeOf(src, from) - 1);
        const tabStore: string[] = [];
        const use: SiteUse = { nth: nth++, pageStore: [], globalStore: [], handles: [] };
        for (const [name, kind] of bound) {
            if (!new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$]|\\s*:(?!:))`).test(args)) continue;
            if (kind === "tabStore") tabStore.push(name);
            else use[kind].push(name);
        }
        for (const d of args.matchAll(new RegExp(`(?<![\\w$.])(${api})\\s*\\.\\s*(pageStore|tabStore|globalStore)\\b`, "g"))) {
            const kind = d[2] as "pageStore" | "tabStore" | "globalStore";
            const list = kind === "tabStore" ? tabStore : use[kind];
            if (!list.includes(`${d[1]}.${kind}`)) list.push(`${d[1]}.${kind}`);
        }
        if (tabStore.length) use.tabStore = tabStore;
        if (use.pageStore.length || tabStore.length || use.globalStore.length || use.handles.length) out.push(use);
    }
    return out;
}


/** what a `rules` handler might do per request, and what it's for (rulesProblems); `api`: apiPattern */
const rulesSideEffects = (api: string): { re: RegExp; does: string }[] => [
    { re: /(?<![\w$.])console\s*\.\s*(?:log|info|warn|error|debug|trace|table|dir)\b(?=\s*\()/g, does: "log each request" },
    { re: new RegExp(`(?<![\\w$.])${api}\\s*\\.\\s*log\\b(?=\\s*\\()`, "g"), does: "log each request" },
    { re: new RegExp(`(?<![\\w$.])(?:${api}\\s*\\.\\s*)?fetch\\b(?=\\s*\\()`, "g"), does: "fetch for each request" },
    { re: /(?<![\w$.])(?:setTimeout|setInterval)\b(?=\s*\()/g, does: "run code for each request" },
];

/**
 * Warnings ("onRequest #N: …", Problems view) for code in `rules` handlers
 * that looks meant to run per request — logging, fetching, timers, store
 * writes. A rules handler runs once, when scripts load, to compute a
 * fixed browser rule; the browser applies the rule itself, so that code
 * never runs for a request. Handlers written inline in the registration
 * only (a lightweight scan, not a parser).
 */
export function rulesProblems(code: string, routes: RouteMeta[]): string[] {
    const rules = routes.filter((r) => r.strategy === "rules" && r.line);
    if (!rules.length) return [];
    const src = codeOnly(code);
    const api = apiPattern(code);
    const effects = rulesSideEffects(api);
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
    const stores = new Set<string>();
    for (const m of src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*${api}\\s*\\.\\s*(?:pageStore|tabStore|globalStore)\\b`, "g"))) stores.add(m[1]);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rules) {
        const lineAt = starts[r.line! - 1];
        if (lineAt === undefined) continue;
        const call = new RegExp(`(?<![\\w$.])${api}\\s*\\.\\s*${r.kind}\\s*(?:<[^()]*>\\s*)?\\(`, "g");
        call.lastIndex = lineAt;
        const m = call.exec(src);
        if (!m || m.index >= (starts[r.line!] ?? src.length)) continue;
        // a loop registering several routes from one call: warn once
        const key = `${m.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const from = m.index + m[0].length;
        const args = src.slice(from, closeOf(src, from) - 1);
        const found: { at: number; text: string; does: string }[] = [];
        for (const { re, does } of effects) for (const e of args.matchAll(re)) found.push({ at: e.index!, text: e[0].replace(/\s+/g, ""), does });
        for (const name of stores) {
            const esc = name.replace(/\$/g, "\\$");
            const write = new RegExp(`(?<![\\w$.])${esc}\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])\\s*(?:[-+*/%&|^]|\\?\\?|&&|\\|\\||<<|>>>?|\\*\\*)?=(?!=)|(?:\\+\\+|--)\\s*${esc}\\b|(?<![\\w$.])${esc}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*(?:\\+\\+|--)`, "g");
            for (const e of args.matchAll(write)) found.push({ at: e.index!, text: name, does: "update the store for each request" });
        }
        for (const f of found.sort((a, b) => a.at - b.at))
            out.push(
                `${routeLabel(r)}: \`${f.text}\` runs once, when scripts load — not for each request: on strategy "rules" the handler only computes a fixed rule that the browser then applies by itself. To ${f.does}, use a per-request strategy ("extension", "debugger" or "helper")`
            );
    }
    return out;
}

/**
 * Network handlers (by their registration line, as rulesProblems) that use
 * `tweak.siteStore` — directly or through a top-level variable bound to it:
 * "onRequest #N: uses `x` — …" (an error in the Problems view). They have
 * no page, so it throws there.
 */
function netSiteStoreProblems(src: string, routes: RouteMeta[], api: string): string[] {
    const bound: string[] = [];
    for (const m of src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*${api}\\s*\\.\\s*siteStore\\b`, "g"))) bound.push(m[1]);
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
    const out: string[] = [];
    const seen = new Set<number>();
    for (const r of routes) {
        if (!isNetKind(r.kind) || !r.line) continue;
        const lineAt = starts[r.line - 1];
        if (lineAt === undefined) continue;
        const call = new RegExp(`(?<![\\w$.])${api}\\s*\\.\\s*${r.api || r.kind}\\s*(?:<[^()]*>\\s*)?\\(`, "g");
        call.lastIndex = lineAt;
        const m = call.exec(src);
        if (!m || m.index >= (starts[r.line] ?? src.length) || seen.has(m.index)) continue;
        seen.add(m.index);
        const from = m.index + m[0].length;
        const args = src.slice(from, closeOf(src, from) - 1);
        const used = bound.filter((name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$]|\\s*:(?!:))`).test(args));
        const direct = new RegExp(`(?<![\\w$.])(${api})\\s*\\.\\s*siteStore\\b`).exec(args);
        if (direct) used.push(`${direct[1]}.siteStore`);
        if (used.length) out.push(`${routeLabel(r)}: uses ${used.map((x) => `\`${x}\``).join(", ")} — ${NO_SITE_STORE}`);
    }
    return out;
}

/**
 * Warnings ("onSite #N: …", Problems view) for onSite handlers that use a
 * store or a handle: in the site's world stores throw and handle calls
 * throw (SiteCannotCallError). And errors for network handlers that use
 * `tweak.siteStore` (which needs a page).
 */
export function siteProblems(code: string, routes: RouteMeta[]): string[] {
    const net = /\bsiteStore\b/.test(code) ? netSiteStoreProblems(codeOnly(code), routes, apiPattern(code)) : [];
    if (!/\bonSite\b/.test(code)) return net;
    const uses = onSiteUses(code);
    if (!uses.length) return net;
    const names = (n: string[]) => n.map((x) => `\`${x}\``).join(", ");
    const out: string[] = [...net];
    // the code's own calls, in order (a module's, run with its tweak, are numbered with them)
    let nth = 0;
    for (const r of routes) {
        if (r.kind !== "onDocument" || placeOf(r) !== "onSite" || r.lib !== undefined || r.file !== undefined) continue;
        const i = nth++;
        const u = uses.find((u) => u.nth === i);
        if (!u) continue;
        const at = `${routeLabel(r)}: `;
        const stores = [...u.pageStore, ...(u.tabStore ?? []), ...u.globalStore];
        if (stores.length) out.push(`${at}uses ${names(stores)} — ${SITE_NO_STORES}`);
        if (u.handles.length) out.push(`${at}uses ${names(u.handles)} — ${SITE_NO_HANDLES}`);
    }
    return out;
}
