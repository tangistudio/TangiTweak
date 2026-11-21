/**
 * `@tangitweak/test` — local & CI test harness for TangiTweak scripts and bundles.
 *
 * Runs TangiTweak's real compiler, module/data resolver, DNR rules probe,
 * `bodyOps` network pipeline, `StoreOwner` + `SiteStoreHost` Valtio replicas,
 * and `onSite` / `onPage` / `onOverlay` DOM + React 19 Shadow DOM lifecycles.
 */
import "../shared/transpile";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import { ensureBuiltins, needsReact, scriptBuiltin, setBuiltinLoader } from "../shared/builtins";
import { bodyKind } from "../shared/bodyKind";
import { capabilitiesOf, type Capabilities } from "../shared/packageCaps";
import {
    compileScript,
    makeModuleResolver,
    rulesProblems,
    siteProblems,
    toRunnableJs,
    type CompiledScript,
} from "../shared/compile";
import type { RuleSpec } from "../shared/dnrRules";
import { Exposer, isRpcCall, RpcClient } from "../shared/rpc";
import { contentHash } from "../shared/folderSync";
import { hotRegistry } from "../shared/hotRefresh";
import type { Manifest, PackageMetadata } from "../shared/packageMetadata";
import { ensurePackages, packagesSnapshot } from "../background/engine/packageImports";
import { isUrlSpec, packageClosure, type PackageModules } from "../shared/packageImports";
import { crawl, isPackageFile, pickStart } from "../shared/packageSource";
import { domHandlersFor, fireRun, makePageShim, pageCtxBase, type PageDocumentHandler } from "../shared/pageShim";
import { requestBodyFrom, requestBodyFromText, type RequestBody } from "../shared/requestBody";
import { pageWorld, type DocumentWhen, type PlaceApi, type RouteMeta, type Strategy } from "../shared/route";
import { probeScriptRules } from "../shared/rulesProbe";
import { reactOf, ScriptLife, type Generation, type ReactDomClient } from "../shared/runLifecycle";
import { formatScriptError } from "../shared/scriptError";
import { resolveParamValues, type ParamTree } from "../shared/scriptDef";
import { bytesToImageDataUrl, isDataSpec, isImageDataPath, makeLibRequire, type ShippedLib } from "../shared/scriptImports";
import { formatLogArgs, makeScriptConsole, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { parseShortcut, runShortcut, ShortcutRegistry, shortcutPriority, watchShortcuts } from "../shared/shortcut";
import { siteBuiltin } from "../shared/siteBuiltin";
import { SiteStoreHost, type SiteDown, type SiteUp } from "../shared/siteStoreHost";
import { SiteMirrors } from "../shared/siteStoreMirror";
import { StoreOwner } from "../background/engine/storeOwner";
import { tabScope, tabScopeOfPage } from "../shared/storeOps";
import { ReplicaHub } from "../shared/storeReplica";
import { fromWireResponse, toWireRequest, toWireResponse } from "../shared/ttFetch";
import { endpointPair, type OverlayInit, type WireRequest, type WireResponse } from "../shared/wire";
import { runOp, type OpScript } from "../shared/bodyOps";
import type { NetKind } from "../shared/netTypes";
import { startOverlay, type OverlayRuntime } from "../overlay/overlayRuntime";

if (typeof (globalThis as any).URLPattern === "undefined" && (nodeUrl as any).URLPattern) {
    (globalThis as any).URLPattern = (nodeUrl as any).URLPattern;
}

setBuiltinLoader(async () => ({
    react: React,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "react/jsx-runtime": ReactJsxRuntime,
    "react/jsx-dev-runtime": ReactJsxDevRuntime,
}));

const MOCK_GLOBAL = "__ttTestMockRegistry";
const mockRegistry: Map<string, any> = ((globalThis as any)[MOCK_GLOBAL] ??= new Map<string, any>());
let nextMockSeq = 0;

export interface InlineTweakSource {
    /** Entry script TypeScript / TSX source code (optional when `files["metadata.json"]` is provided). */
    code?: string;
    /** Entry script name/path (defaults to `"script"`). */
    name?: string;
    /** Companion scripts, `metadata.json`, or data files (`path -> content`). */
    files?: Record<string, string>;
}

export type TweakSource = string | URL | InlineTweakSource;

export interface LoadTweakOptions {
    /** Base directory for resolving relative string paths (defaults to caller file directory or `process.cwd()`). */
    cwd?: string;
    /** Override `tt.params` defaults (`{ key: val }` or `{ [scriptName]: { key: val } }`). */
    params?: Record<string, any>;
    /** Seed `tt.storage` values (`{ key: val }` or `{ [scriptName]: { key: val } }`). */
    storage?: Record<string, any>;
    /** Seed `tt.globalStore` values by store name (`{ storeName: { ... } }`). */
    stores?: Record<string, Record<string, any>>;
    /** Mock imported modules or URL packages (`{ "https://unpkg.com/...": mockExports, "./lib": mockExports }`). */
    mocks?: Record<string, any>;
    /** Custom upstream `fetch` used by `tt.fetch` and as fallback upstream in `simulate()`. */
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** Keep going instead of throwing when a script has compile, DNR rule, or `onSite` errors (inspect `t.errors`). */
    allowCompileErrors?: boolean;
}

export interface TweakLogEntry {
    script: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    kind?: string;
}

export interface LoadedScriptInfo {
    id: string;
    name: string;
    metadata?: PackageMetadata;
    paramDefs?: ParamTree;
    exports: any;
    rules: RuleSpec[];
}

export interface UpstreamRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: {
        readonly raw: Uint8Array;
        readonly text: string;
        readonly contentType?: string;
        json<T = any>(): T;
        formData(): URLSearchParams;
    };
    resourceType: string;
    tabId: number;
    tabUrl: string;
}

export interface UpstreamResponseInit {
    status?: number;
    headers?: Record<string, string> | Headers;
    body?: string | Uint8Array | Record<string, any> | any[];
    contentType?: string;
}

export interface SimulateRequestInit {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: string | Uint8Array | Record<string, any> | any[];
    resourceType?: string;
    tabId?: number;
    tabUrl?: string;
    pageId?: string;
    strategy?: Strategy;
    upstream?: UpstreamResponseInit | Response | ((req: UpstreamRequest) => UpstreamResponseInit | Response | Promise<UpstreamResponseInit | Response>);
}

export interface SimulatedResponse {
    action: "passthrough" | "modified" | "replaced" | "redirected" | "blocked";
    blocked: boolean;
    redirectedTo: string | null;
    replaced: boolean;
    modified: boolean;
    url: string;
    status: number;
    requestHeaders: Record<string, string>;
    headers: Record<string, string>;
    body: string | Uint8Array;
    text(): string;
    json<T = any>(): T;
    bytes(): Uint8Array;
}

export interface OpenPageOptions {
    /** Initial `document.body.innerHTML`. */
    html?: string;
    /** Initial document phase (`"document_start"`, `"document_end"` [default], or `"document_idle"`). */
    phase?: DocumentWhen;
    /** Tab ID used for `tt.tabStore` and network simulation (default `1`). */
    tabId?: number;
    /** Wrap `ctx.mount(...)` in closed shadow roots just like TangiTweak in production (default `true`). */
    shadow?: boolean;
    /** Route `window.fetch` through `t.simulate(...)` while the page is open (default `true`). */
    interceptFetch?: boolean;
}

export interface PageMountSlot {
    script: string;
    world: "page" | "isolated";
    anchor: Element | null;
    host: Element;
    container: HTMLElement;
}

export interface TestPage {
    readonly url: string;
    readonly window: Window & typeof globalThis;
    readonly document: Document;
    /** Active `ctx.mount(...)` slots (including containers inside closed shadow roots). */
    readonly mounts: PageMountSlot[];
    /** Returns the mount container whose anchor matches `selector` (or the first mount when omitted). */
    mountFor(selector?: string): HTMLElement | null;
    /** Primary overlay frame `<body>`, or `null` when no script ran `tt.onOverlay` on this page. */
    readonly overlay: HTMLElement | null;
    /** Overlay frame `<body>` for a specific script name, or `null`. */
    overlayFor(scriptName?: string): HTMLElement | null;
    /** Live Valtio proxy for `tt.siteStore(name)` in the page world. */
    siteStore<T extends Record<string, any> = Record<string, any>>(name: string, initial?: T, scriptName?: string): T;
    /** Advance document lifecycle to `"document_end"` or `"document_idle"`. */
    advanceTo(phase: DocumentWhen): Promise<void>;
    /** Simulate SPA navigation (`location.href` update + `ctx.onNavigate` callbacks). */
    navigate(nextUrl: string | URL): Promise<void>;
    /** Simulate saving / hot-reloading scripts on the live page (`autoRestore`, `ctx.patch`, Fast Refresh). */
    reload(): Promise<void>;
    /** Dispatch a keyboard shortcut combo (e.g. `"Mod+Shift+K"` or `"Alt+P"`) to test `ctx.shortcut(...)`. */
    pressKey(combo: string, target?: EventTarget): Promise<boolean>;
    /** Settle microtasks, store sync hops, RPC calls, and React renders. */
    flush(): Promise<void>;
    /** Tear down all handlers, unmount React roots, and restore `ctx.patch` & `window.fetch`. */
    close(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

export interface LoadedTweak {
    readonly manifest?: Manifest;
    readonly metadata?: PackageMetadata;
    readonly capabilities: Capabilities;
    readonly scripts: LoadedScriptInfo[];
    readonly exports: any;
    readonly rules: RuleSpec[];
    readonly errors: string[];
    readonly warnings: string[];
    readonly logs: TweakLogEntry[];
    readonly storage: {
        get(key: string, scriptName?: string): any;
        set(key: string, value: any, scriptName?: string): void;
        snapshot(scriptName?: string): Record<string, any>;
    };
    store<T extends Record<string, any> = Record<string, any>>(name: string, initial?: T, scriptName?: string): T;
    tabStore<T extends Record<string, any> = Record<string, any>>(name: string, tabId?: number, initial?: T, scriptName?: string): T;
    pageStore<T extends Record<string, any> = Record<string, any>>(name: string, pageId?: string, initial?: T, scriptName?: string): T;
    setParams(values: Record<string, any>, scriptName?: string): Promise<void>;
    simulate(url: string | URL, init?: SimulateRequestInit): Promise<SimulatedResponse>;
    openPage(url: string | URL, options?: OpenPageOptions): Promise<TestPage>;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

const PHASES: DocumentWhen[] = ["document_start", "document_end", "document_idle"];
const phaseRank = (p: DocumentWhen | undefined) => PHASES.indexOf(p ?? "document_end");

function scriptNameOf(filePath: string): string {
    return filePath.replace(/\.(tsx?|js)$/i, "");
}

function asCjsExports(mod: any): any {
    if (mod && typeof mod === "object" && !Array.isArray(mod)) {
        return "default" in mod ? { __esModule: true, ...mod } : { __esModule: true, default: mod, ...mod };
    }
    return { __esModule: true, default: mod };
}

function callerDir(): string | null {
    const stack = String(new Error().stack || "").split("\n").slice(2);
    for (const line of stack) {
        const m = /\((file:\/\/[^):]+|\/[^):]+|[A-Za-z]:\\[^):]+):\d+:\d+\)/.exec(line) || /at\s+(file:\/\/[^\s:]+|\/[^\s:]+|[A-Za-z]:\\[^\s:]+):\d+:\d+/.exec(line);
        if (!m) continue;
        const raw = m[1].startsWith("file://") ? nodeUrl.fileURLToPath(m[1]) : m[1];
        if (/[/\\](\.tangitweak[/\\]test|src[/\\]testing)[/\\]/.test(raw)) continue;
        return nodePath.dirname(raw);
    }
    return null;
}

function resolveTargetPath(target: string | URL, cwd?: string): string {
    if (target instanceof URL) return nodeUrl.fileURLToPath(target);
    if (target.startsWith("file://")) return nodeUrl.fileURLToPath(target);
    if (nodePath.isAbsolute(target)) return target;
    if (cwd) return nodePath.resolve(cwd, target);
    if (target.startsWith(".")) {
        const fromCaller = callerDir();
        if (fromCaller) {
            const candidate = nodePath.resolve(fromCaller, target);
            if (fsSync.existsSync(candidate)) return candidate;
        }
    }
    return nodePath.resolve(process.cwd(), target);
}

async function listDirFiles(dir: string, prefix = ""): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const ent of entries) {
        if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__tests__") continue;
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...(await listDirFiles(nodePath.join(dir, ent.name), rel)));
        else if (isPackageFile(rel)) out.push(rel);
    }
    return out;
}

async function readDiskPackageFile(absFile: string, logicalPath: string): Promise<string | null> {
    try {
        const buf = await fs.readFile(absFile);
        return isImageDataPath(logicalPath) ? bytesToImageDataUrl(logicalPath, new Uint8Array(buf)) : buf.toString("utf8");
    } catch {
        return null;
    }
}

interface RawWorkspace {
    manifest?: Manifest;
    entryNames: string[];
    scripts: { id: string; name: string; code: string }[];
    dataFiles: { path: string; text: string }[];
}

async function loadRawWorkspace(source: TweakSource, opts: LoadTweakOptions): Promise<RawWorkspace> {
    if (typeof source === "object" && !(source instanceof URL)) {
        const files: Record<string, string> = { ...(source.files || {}) };
        if (files["metadata.json"] && source.code === undefined) {
            const crawled = await crawl("metadata.json", async (p) => files[p] ?? null);
            const unmocked = crawled.missing.filter((m) => !opts.mocks || !(m.spec in opts.mocks));
            if (unmocked.length) throw new Error(`missing import "${unmocked[0].spec}" in ${unmocked[0].from}`);
            return crawledToWorkspace(crawled);
        }
        const entryFile = (source.name || "script").replace(/\.(tsx?|js)$/i, "") + ".tsx";
        files[entryFile] = source.code ?? "";
        const scripts: { id: string; name: string; code: string }[] = [];
        const dataFiles: { path: string; text: string }[] = [];
        let idx = 0;
        for (const [p, text] of Object.entries(files)) {
            if (p === "metadata.json") continue;
            if (isDataSpec(p)) dataFiles.push({ path: p, text });
            else scripts.push({ id: `s${++idx}`, name: scriptNameOf(p), code: text });
        }
        let manifest: Manifest | undefined;
        if (files["metadata.json"]) {
            const crawled = await crawl("metadata.json", async (p) => files[p] ?? null);
            manifest = crawled.manifest;
        }
        const entryNames = manifest ? manifest.scripts.map(scriptNameOf) : [scriptNameOf(entryFile)];
        return { manifest, entryNames, scripts, dataFiles };
    }

    const abs = resolveTargetPath(source, opts.cwd);
    const stat = await fs.stat(abs);
    let absEntry = abs;
    if (stat.isDirectory()) {
        const topFiles = (await fs.readdir(abs, { withFileTypes: true }))
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => e.name)
            .filter(isPackageFile);
        const candidates = topFiles.length ? topFiles : await listDirFiles(abs);
        const picked = pickStart(candidates, abs, "pass the entry script path or add a metadata.json");
        absEntry = nodePath.resolve(abs, ...picked.split("/"));
    }
    let rootDir: string;
    let startRel: string;
    if (nodePath.basename(absEntry).toLowerCase() === "metadata.json") {
        rootDir = nodePath.dirname(absEntry);
        startRel = nodePath.basename(absEntry);
    } else {
        // Use filesystem root as virtual root for single-script files so `../shared/...` relative imports work cleanly
        const parsed = nodePath.parse(absEntry);
        rootDir = parsed.root;
        startRel = nodePath.relative(parsed.root, absEntry).split(nodePath.sep).join("/");
    }

    const crawled = await crawl(startRel, (rel) => {
        const target = nodePath.resolve(rootDir, ...rel.split("/"));
        const relCheck = nodePath.relative(rootDir, target);
        if (relCheck.startsWith("..") && nodePath.isAbsolute(relCheck)) return Promise.resolve(null);
        return readDiskPackageFile(target, rel);
    });
    const unmocked = crawled.missing.filter((m) => !opts.mocks || !(m.spec in opts.mocks));
    if (unmocked.length) throw new Error(`missing import "${unmocked[0].spec}" in ${unmocked[0].from}`);
    return crawledToWorkspace(crawled);
}

function crawledToWorkspace(crawled: Awaited<ReturnType<typeof crawl>>): RawWorkspace {
    const scripts: { id: string; name: string; code: string }[] = [];
    const dataFiles: { path: string; text: string }[] = [];
    let idx = 0;
    for (const [p, text] of Object.entries(crawled.files)) {
        if (p === "metadata.json") continue;
        if (isDataSpec(p)) dataFiles.push({ path: p, text });
        else scripts.push({ id: `s${++idx}`, name: scriptNameOf(p), code: text });
    }
    const entryNames = crawled.entries.map(scriptNameOf);
    return { manifest: crawled.manifest, entryNames, scripts, dataFiles };
}

function normalizeHeaders(input?: Record<string, string> | Headers | readonly [string, string][]): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input) return out;
    if (typeof Headers !== "undefined" && input instanceof Headers) {
        input.forEach((v, k) => {
            out[k.toLowerCase()] = v;
        });
        return out;
    }
    if (Array.isArray(input)) {
        for (const [k, v] of input) out[String(k).toLowerCase()] = String(v);
        return out;
    }
    for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k.toLowerCase()] = String(v);
    return out;
}

function applyResponseHeaderChanges(
    base: Record<string, string>,
    mods: { set?: Record<string, string>; remove?: string[] }
): Record<string, string> {
    const out = { ...base };
    for (const r of mods.remove || []) delete out[String(r).toLowerCase()];
    for (const [k, v] of Object.entries(mods.set || {})) out[k.toLowerCase()] = String(v);
    return out;
}

function serializeBody(body: SimulateRequestInit["body"], defaultMime?: string): { raw: string | Uint8Array | undefined; contentType?: string } {
    if (body === undefined) return { raw: undefined, contentType: defaultMime };
    if (typeof body === "string" || body instanceof Uint8Array) return { raw: body, contentType: defaultMime };
    return { raw: JSON.stringify(body), contentType: defaultMime || "application/json" };
}

function setWindowUrl(win: Window & typeof globalThis, nextUrl: string): void {
    const full = new URL(nextUrl, "https://localhost/").href;
    if ((win as any).happyDOM?.setURL) {
        (win as any).happyDOM.setURL(full);
        return;
    }
    if ((globalThis as any).jsdom?.reconfigure) {
        (globalThis as any).jsdom.reconfigure({ url: full });
        return;
    }
    try {
        const cur = new URL(win.location.href);
        const u = new URL(full);
        if (cur.origin === u.origin) {
            win.history.replaceState(null, "", u.pathname + u.search + u.hash);
            return;
        }
    } catch {}
    try {
        const u = new URL(full);
        Object.defineProperty(win, "location", {
            configurable: true,
            value: {
                href: u.href,
                origin: u.origin,
                protocol: u.protocol,
                host: u.host,
                hostname: u.hostname,
                port: u.port,
                pathname: u.pathname,
                search: u.search,
                hash: u.hash,
                assign: (x: string) => setWindowUrl(win, new URL(x, u.href).href),
                replace: (x: string) => setWindowUrl(win, new URL(x, u.href).href),
                reload: () => {},
                toString: () => u.href,
            },
        });
    } catch {}
}

async function flushAsync(turns = 12, withAct = false): Promise<void> {
    const act = withAct ? ((React as any).act as (<T>(cb: () => T | Promise<T>) => Promise<T>) | undefined) : undefined;
    const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    if (typeof act === "function") (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    try {
        const pump = async () => {
            for (let i = 0; i < turns; i++) {
                await Promise.resolve();
                await new Promise((r) => setTimeout(r, 0));
            }
        };
        if (typeof act === "function") await act(pump);
        else await pump();
    } finally {
        if (typeof act === "function") (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
}

function buildKeyboardEventInit(combo: string): KeyboardEventInit {
    const parsed = parseShortcut(combo);
    return {
        key: parsed.key.length === 1 && parsed.shift ? parsed.key.toUpperCase() : parsed.key,
        code: parsed.code ?? parsed.key,
        bubbles: true,
        cancelable: true,
        ctrlKey: parsed.ctrl,
        metaKey: parsed.meta,
        altKey: parsed.alt,
        shiftKey: parsed.shift,
    };
}

/**
 * Load a single TangiTweak script, a `metadata.json` bundle, or an inline
 * `{ code, files }` definition for unit and integration testing.
 */
export async function loadTweak(source: TweakSource, options: LoadTweakOptions = {}): Promise<LoadedTweak> {
    if (typeof (globalThis as any).URLPattern === "undefined") {
        throw new Error("@tangitweak/test requires global URLPattern (Node.js >= 23.8)");
    }

    const ws = await loadRawWorkspace(source, options);
    const scriptByName = new Map(ws.scripts.map((s) => [s.name, s]));
    const scriptById = new Map(ws.scripts.map((s) => [s.id, s]));
    const entrySet = new Set(ws.entryNames);
    const entryScripts = ws.scripts.filter((s) => entrySet.has(s.name));
    const primaryScript = entryScripts[0] ?? ws.scripts[0];
    if (!primaryScript) throw new Error("loadTweak: no script found");

    const logs: TweakLogEntry[] = [];
    const logSink = (scriptName: string, level: ScriptLogLevel | "debug", sourceLabel: string, text: string, kind?: string) => {
        logs.push({ script: scriptName, level, message: sourceLabel ? `[${sourceLabel}] ${text}` : text, ...(kind ? { kind } : {}) });
    };

    // Per-script key-value storage (`tt.storage` + `$store:*` persistence)
    const storageData = new Map<string, Record<string, any>>();
    for (const s of ws.scripts) storageData.set(s.id, {});
    if (options.storage) {
        const keys = Object.keys(options.storage);
        const perScript = keys.length > 0 && keys.every((k) => scriptByName.has(k) && options.storage![k] && typeof options.storage![k] === "object");
        if (perScript) {
            for (const [name, vals] of Object.entries(options.storage)) {
                const s = scriptByName.get(name);
                if (s) Object.assign(storageData.get(s.id)!, structuredClone(vals));
            }
        } else {
            for (const s of ws.scripts) Object.assign(storageData.get(s.id)!, structuredClone(options.storage));
        }
    }
    if (options.stores) {
        for (const [storeName, data] of Object.entries(options.stores)) {
            for (const s of entryScripts) {
                storageData.get(s.id)![`$store:${storeName}`] = structuredClone(data);
            }
        }
    }

    // Per-script parameter overrides
    const paramOverrides = new Map<string, Record<string, any>>();
    const applyParamInput = (values: Record<string, any>, scriptName?: string) => {
        if (scriptName) {
            const target = scriptByName.get(scriptNameOf(scriptName));
            if (!target) throw new Error(`unknown script "${scriptName}"`);
            paramOverrides.set(target.id, { ...(paramOverrides.get(target.id) || {}), ...values });
            return;
        }
        const keys = Object.keys(values);
        const keyedByScript = keys.length > 0 && keys.every((k) => scriptByName.has(scriptNameOf(k)) && values[k] && typeof values[k] === "object" && !Array.isArray(values[k]));
        if (keyedByScript) {
            for (const [k, v] of Object.entries(values)) {
                const s = scriptByName.get(scriptNameOf(k))!;
                paramOverrides.set(s.id, { ...(paramOverrides.get(s.id) || {}), ...v });
            }
        } else {
            for (const s of ws.scripts) paramOverrides.set(s.id, { ...(paramOverrides.get(s.id) || {}), ...values });
        }
    };
    if (options.params) applyParamInput(options.params);

    // URL package resolution + mock module synthesis
    const ownedMockKeys: string[] = [];
    const mockCjsBySpec = new Map<string, string>();
    const mockObjs = new Map<string, any>();
    if (options.mocks) {
        for (const [spec, val] of Object.entries(options.mocks)) {
            const cjs = asCjsExports(val);
            mockObjs.set(spec, cjs);
            const regKey = `m_${++nextMockSeq}`;
            ownedMockKeys.push(regKey);
            mockRegistry.set(regKey, cjs);
            mockCjsBySpec.set(spec, `module.exports = globalThis.${MOCK_GLOBAL}.get(${JSON.stringify(regKey)});`);
        }
    }

    // Load unmocked https://unpkg.com / esm.sh packages if any script uses them
    const codesForPkgs = ws.scripts.map((s) => {
        if (!mockObjs.size) return s.code;
        let filtered = s.code;
        for (const spec of mockObjs.keys()) {
            if (isUrlSpec(spec)) filtered = filtered.split(spec).join("__tt_mocked_pkg__");
        }
        return filtered;
    });
    await ensurePackages(codesForPkgs);
    const basePkgs = packagesSnapshot();
    const pkgs: PackageModules = {
        aliases: { ...basePkgs.aliases },
        modules: { ...basePkgs.modules },
    };
    for (const [spec, code] of mockCjsBySpec) {
        if (isUrlSpec(spec)) {
            pkgs.aliases[spec] = spec;
            pkgs.modules[spec] = { js: code, requires: {} };
        }
    }
    await ensureBuiltins(ws.scripts.map((s) => s.code), pkgs);

    // StoreOwner + background ReplicaHub
    const owner = new StoreOwner({
        storageAll: async (scriptId) => structuredClone(storageData.get(scriptId) ?? {}),
        storageSet: async (scriptId, key, value) => {
            const obj = storageData.get(scriptId) ?? {};
            obj[key] = structuredClone(value);
            storageData.set(scriptId, obj);
        },
        storageDelete: async (scriptId, key) => {
            const obj = storageData.get(scriptId);
            if (obj) delete obj[key];
        },
        log: (scriptId, msg, level) => logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "store", msg),
        persistDelayMs: 1,
        sessionDelayMs: 1,
    });
    const [bgClientEp, bgOwnerEp] = endpointPair();
    owner.attach(bgOwnerEp, { all: true });
    const bgHub = new ReplicaHub({
        ctx: "background",
        log: (scriptId, msg, level) => logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "store", msg),
    });
    bgHub.attach(bgClientEp);
    bgHub.prime(await owner.init(ws.scripts.map((s) => s.id), { page: null, tabs: true }));

    const resolveScript = (scriptName?: string) => {
        if (!scriptName) return primaryScript;
        const hit = scriptByName.get(scriptNameOf(scriptName));
        if (!hit) throw new Error(`unknown script "${scriptName}"`);
        return hit;
    };

    const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (options.fetch) return options.fetch(input, init);
        return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
    };

    const bgWireFetch = async (request: WireRequest, bypass: boolean): Promise<WireResponse> => {
        if (bypass) {
            const res = await upstreamFetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body !== null && request.body !== undefined ? (request.body as BodyInit) : undefined,
            });
            return toWireResponse(res);
        }
        const sim = await simulate(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: request.body ?? undefined,
        });
        if (sim.blocked) throw new TypeError("Failed to fetch (blocked by TangiTweak)");
        return {
            url: sim.redirectedTo || sim.url,
            status: sim.status || 200,
            statusText: "",
            headers: Object.entries(sim.headers),
            body: sim.bytes(),
        };
    };

    let compiledMap = new Map<string, CompiledScript & { deps: string[] }>();
    let opScripts: OpScript[] = [];
    let currentRules: RuleSpec[] = [];
    let currentRulesByScript = new Map<string, RuleSpec[]>();
    let currentErrors: string[] = [];
    let currentWarnings: string[] = [];
    const openPages = new Set<TestPage & { _hotUpdate(): Promise<void> }>();

    const knownTabIds = new Set<number>([1]);

    const probeAllRules = async (): Promise<{ rules: RuleSpec[]; byScript: Map<string, RuleSpec[]>; errors: string[] }> => {
        const rules: RuleSpec[] = [];
        const byScript = new Map<string, RuleSpec[]>();
        const errs: string[] = [];
        for (const s of entryScripts) {
            const c = compiledMap.get(s.id);
            if (!c || c.error) {
                byScript.set(s.id, []);
                continue;
            }
            const probed = await probeScriptRules(c.handlers, [...knownTabIds]);
            const specs = probed.rules.flatMap((r) => r.specs);
            byScript.set(s.id, specs);
            rules.push(...specs);
            for (const err of probed.errors) errs.push(`${s.name}: ${err}`);
        }
        return { rules, byScript, errors: errs };
    };

    const compileAll = async () => {
        bgHub.prime(await owner.init(ws.scripts.map((s) => s.id), { page: null, tabs: true }));
        const makeOverrides = (s: { id: string; name: string }) => ({
            name: s.name,
            paramValues: paramOverrides.get(s.id),
            storage: {
                get: async (key: string) => structuredClone(storageData.get(s.id)?.[key]),
                set: async (key: string, value: any) => {
                    const obj = storageData.get(s.id) ?? {};
                    obj[key] = structuredClone(value);
                    storageData.set(s.id, obj);
                },
            },
            logSink: (level: ScriptLogLevel, src: string, text: string) => logSink(s.name, level, src, text),
            store: (name: string, initial: object, persist: boolean | string[]) => bgHub.store(s.id, name, initial, persist),
            tabStore: (name: string, initial: object) => bgHub.tabStore(s.id, name, initial),
            pageStore: (name: string, initial: object) => bgHub.pageStore(s.id, name, initial),
            fetch: bgWireFetch,
            setParam: async (key: string, value: any) => {
                paramOverrides.set(s.id, { ...(paramOverrides.get(s.id) || {}), [key]: value });
            },
        });

        const resolver = makeModuleResolver(ws.scripts, (lib) => makeOverrides(lib), {
            dataFiles: ws.dataFiles,
            packages: pkgs,
        });

        const wrapImport = (importer: string) => {
            const base = resolver.resolveFrom(importer);
            return (spec: string) => {
                if (mockObjs.has(spec)) return mockObjs.get(spec);
                return base(spec);
            };
        };

        const nextCompiled = new Map<string, CompiledScript & { deps: string[] }>();
        const errs: string[] = [];
        const warns: string[] = [];

        for (const s of ws.scripts) {
            resolver.deps.clear();
            const c = compileScript(s.code, {
                ...makeOverrides(s),
                importModule: wrapImport(s.name),
            });
            const deps = [...resolver.deps];
            nextCompiled.set(s.id, { ...c, deps });
            if (entrySet.has(s.name)) {
                if (c.error) errs.push(`${s.name}: ${c.error}`);
                for (const p of siteProblems(s.code, c.meta.routes || [])) errs.push(`${s.name}: ${p}`);
                for (const w of rulesProblems(s.code, c.meta.routes || [])) warns.push(`${s.name}: ${w}`);
            }
        }

        compiledMap = nextCompiled;
        await flushAsync(4);
        const probed = await probeAllRules();
        currentRules = probed.rules;
        currentRulesByScript = probed.byScript;
        errs.push(...probed.errors);
        currentErrors = errs;
        currentWarnings = warns;
        opScripts = entryScripts
            .map((s) => ({ id: s.id, name: s.name, handlers: compiledMap.get(s.id)!.handlers }))
            .filter((s) => Boolean(s.handlers));

        if (errs.length && !options.allowCompileErrors) {
            throw new Error(`TangiTweak compile failed:\n${errs.join("\n")}`);
        }
    };

    await compileAll();

    const shippedLibsFor = (deps: Iterable<string>): ShippedLib[] => {
        const out = new Map<string, ShippedLib>();
        const depList = [...deps];
        const urls = depList.filter(isUrlSpec);
        for (const u of urls) if (pkgs.aliases[u]) out.set(u, { name: u, alias: pkgs.aliases[u] });
        for (const u of packageClosure(pkgs, urls)) if (pkgs.modules[u]) out.set(u, { name: u, pkg: pkgs.modules[u] });
        const visitLocal = (name: string) => {
            if (isUrlSpec(name) || out.has(name)) return;
            const lib = scriptByName.get(name);
            if (lib) {
                const c = compiledMap.get(lib.id);
                const resolvedParams = resolveParamValues(c?.paramDefs || {}, paramOverrides.get(lib.id));
                out.set(lib.name, { id: lib.id, name: lib.name, src: toRunnableJs(lib.code), params: resolvedParams });
                for (const sub of c?.deps || []) visitLocal(sub);
                return;
            }
            const data = ws.dataFiles.find((d) => d.path === name || d.path.toLowerCase() === name.toLowerCase());
            if (data) out.set(data.path, { name: data.path, json: data.text });
        };
        for (const d of depList) visitLocal(d);
        return [...out.values()];
    };

    async function simulate(urlInput: string | URL, init: SimulateRequestInit = {}): Promise<SimulatedResponse> {
        const url = String(urlInput);
        const method = (init.method || "GET").toUpperCase();
        const tabId = init.tabId ?? 1;
        knownTabIds.add(tabId);
        const page = init.pageId ?? `tab:${tabId}`;
        const resourceType = init.resourceType || "xmlhttprequest";
        const tabUrl = init.tabUrl || url;
        const reqHeaders = normalizeHeaders(init.headers);
        const serializedReq = serializeBody(init.body, reqHeaders["content-type"]);
        if (serializedReq.contentType && !reqHeaders["content-type"]) reqHeaders["content-type"] = serializedReq.contentType;
        const requestBody: RequestBody | undefined =
            serializedReq.raw === undefined
                ? undefined
                : typeof serializedReq.raw === "string"
                  ? requestBodyFromText(serializedReq.raw, reqHeaders["content-type"])
                  : requestBodyFrom(serializedReq.raw, reqHeaders["content-type"]);

        // Re-verify `strategy: "rules"` handlers against current store/param state
        const liveProbe = await probeAllRules();
        currentRules = liveProbe.rules;
        currentRulesByScript = liveProbe.byScript;
        if (liveProbe.errors.length && !options.allowCompileErrors) {
            throw new Error(`declarativeNetRequest rules error:\n${liveProbe.errors.join("\n")}`);
        }

        const opEnv = {
            log: (scriptId: string, level: "debug" | "info" | "warn" | "error", msg: string, kind?: NetKind) =>
                logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "", msg, kind),
        };
        const baseArgs = {
            url,
            method,
            tabId,
            page,
            tabUrl,
            resourceType,
            tier: init.strategy,
            requestHeaders: { ...reqHeaders },
            requestBody,
        };

        const utf8Enc = new TextEncoder();
        const utf8Dec = new TextDecoder();
        const makeResult = (
            action: SimulatedResponse["action"],
            status: number,
            headers: Record<string, string>,
            body: string | Uint8Array,
            finalReqHeaders: Record<string, string>,
            redirectedTo: string | null = null
        ): SimulatedResponse => ({
            action,
            blocked: action === "blocked",
            redirectedTo,
            replaced: action === "replaced",
            modified: action === "modified" || action === "replaced",
            url,
            status,
            requestHeaders: finalReqHeaders,
            headers,
            body,
            text: () => (typeof body === "string" ? body : utf8Dec.decode(body)),
            json: <T = any>() => JSON.parse(typeof body === "string" ? body : utf8Dec.decode(body)) as T,
            bytes: () => (typeof body === "string" ? utf8Enc.encode(body) : body),
        });

        const decision = await runOp(opScripts, "requestDecision", baseArgs, opEnv);
        if (decision?.kind === "cancel") {
            return makeResult("blocked", 0, {}, "", { ...reqHeaders });
        }
        if (decision?.kind === "redirect") {
            return makeResult("redirected", 307, { location: decision.url }, "", { ...reqHeaders }, decision.url);
        }

        const effectiveReqHeaders = { ...reqHeaders };
        let reqModified = false;
        if (decision?.kind === "headers") {
            for (const name of decision.changes?.remove || []) {
                const lower = String(name).toLowerCase();
                if (lower in effectiveReqHeaders) {
                    delete effectiveReqHeaders[lower];
                    reqModified = true;
                }
            }
            for (const [name, val] of Object.entries(decision.changes?.set || {})) {
                effectiveReqHeaders[name.toLowerCase()] = String(val);
                reqModified = true;
            }
        }

        if (decision?.kind === "respond") {
            const respHeaders = normalizeHeaders(decision.headers);
            if (decision.mime && !respHeaders["content-type"]) respHeaders["content-type"] = decision.mime;
            return makeResult("replaced", decision.status ?? 200, respHeaders, decision.content ?? "", effectiveReqHeaders);
        }

        const replaced = await runOp(opScripts, "replace", { ...baseArgs, requestHeaders: effectiveReqHeaders }, opEnv);
        if (replaced) {
            return makeResult("replaced", 200, { "content-type": replaced.mime }, replaced.content, effectiveReqHeaders);
        }

        // Upstream resolution
        let upStatus = 200;
        let upHeaders: Record<string, string> = {};
        let upRaw: string | Uint8Array = "";
        const upReqBody =
            serializedReq.raw === undefined
                ? undefined
                : (() => {
                      const rawBytes = typeof serializedReq.raw === "string" ? utf8Enc.encode(serializedReq.raw) : serializedReq.raw;
                      const textVal = typeof serializedReq.raw === "string" ? serializedReq.raw : utf8Dec.decode(serializedReq.raw);
                      return {
                          raw: rawBytes,
                          text: textVal,
                          contentType: effectiveReqHeaders["content-type"],
                          json: <T = any>() => JSON.parse(textVal) as T,
                          formData: () => new URLSearchParams(textVal),
                      };
                  })();
        const upSpec =
            typeof init.upstream === "function"
                ? await init.upstream({
                      url,
                      method,
                      headers: { ...effectiveReqHeaders },
                      body: upReqBody,
                      resourceType,
                      tabId,
                      tabUrl,
                  })
                : init.upstream;

        if (upSpec instanceof Response) {
            upStatus = upSpec.status;
            upHeaders = normalizeHeaders(upSpec.headers);
            upRaw = new Uint8Array(await upSpec.arrayBuffer());
        } else if (upSpec) {
            upStatus = upSpec.status ?? 200;
            upHeaders = normalizeHeaders(upSpec.headers);
            if (upSpec.contentType && !upHeaders["content-type"]) upHeaders["content-type"] = upSpec.contentType;
            const ser = serializeBody(upSpec.body, upHeaders["content-type"]);
            if (ser.contentType && !upHeaders["content-type"]) upHeaders["content-type"] = ser.contentType;
            upRaw = ser.raw ?? "";
        } else if (options.fetch) {
            const res = await options.fetch(url, {
                method,
                headers: effectiveReqHeaders,
                body: serializedReq.raw !== undefined && method !== "GET" && method !== "HEAD" ? (serializedReq.raw as BodyInit) : undefined,
            });
            upStatus = res.status;
            upHeaders = normalizeHeaders(res.headers);
            upRaw = new Uint8Array(await res.arrayBuffer());
        }

        if (upStatus >= 300 && upStatus < 400) {
            return makeResult(reqModified ? "modified" : "passthrough", upStatus, upHeaders, upRaw, effectiveReqHeaders);
        }

        const headerPairs = Object.entries(upHeaders).map(([name, value]) => ({ name, value }));
        const headerMods = await runOp(
            opScripts,
            "responseHeaders",
            { ...baseArgs, requestHeaders: effectiveReqHeaders, status: upStatus, responseHeaders: headerPairs },
            opEnv
        );
        let finalHeaders = upHeaders;
        let resHeadersModified = false;
        if (headerMods) {
            resHeadersModified = true;
            finalHeaders = applyResponseHeaderChanges(upHeaders, headerMods);
        }

        const contentType = finalHeaders["content-type"];
        const probeBytes = typeof upRaw === "string" ? null : upRaw;
        const kind = bodyKind(contentType, probeBytes);
        const bodyInput: string | Uint8Array = kind === "binary" ? (typeof upRaw === "string" ? utf8Enc.encode(upRaw) : upRaw) : typeof upRaw === "string" ? upRaw : utf8Dec.decode(upRaw);

        const transformed = await runOp(
            opScripts,
            "transform",
            {
                ...baseArgs,
                requestHeaders: effectiveReqHeaders,
                status: upStatus,
                contentType,
                body: bodyInput,
            },
            opEnv
        );

        const finalBody = transformed !== null && transformed !== undefined ? transformed : bodyInput;
        const bodyModified = transformed !== null && transformed !== undefined;
        return makeResult(reqModified || resHeadersModified || bodyModified ? "modified" : "passthrough", upStatus, finalHeaders, finalBody, effectiveReqHeaders);
    }

    async function openPage(urlInput: string | URL, pageOpts: OpenPageOptions = {}): Promise<TestPage> {
        if (typeof window === "undefined" || typeof document === "undefined") {
            throw new Error(
                'openPage() requires a DOM environment. Add `// @vitest-environment happy-dom` at the top of your test file (or set `environment: "happy-dom"` in vitest.config.ts).'
            );
        }
        const win = window as Window & typeof globalThis;
        const doc = document;
        let currentUrl = new URL(String(urlInput), "https://localhost/").href;
        let currentPhase: DocumentWhen = pageOpts.phase ?? "document_end";
        const tabId = pageOpts.tabId ?? 1;
        knownTabIds.add(tabId);
        const pageId = `${tabId}:p_${Math.random().toString(36).slice(2, 8)}`;
        const useShadow = pageOpts.shadow !== false;

        setWindowUrl(win, currentUrl);
        if (pageOpts.html !== undefined) {
            doc.body.innerHTML = pageOpts.html;
        }

        // Intercept page fetch through `simulate()` so UI + API rewrites test together seamlessly
        const prevWinFetch = win.fetch;
        const prevGlobalFetch = globalThis.fetch;
        if (pageOpts.interceptFetch !== false) {
            const pageFetchShim = async (input: RequestInfo | URL, rinit?: RequestInit): Promise<Response> => {
                const wireReq = await toWireRequest(input, rinit ?? {}, currentUrl);
                const sim = await simulate(wireReq.url, {
                    method: wireReq.method,
                    headers: Object.fromEntries(wireReq.headers),
                    body: wireReq.body ?? undefined,
                    tabId,
                    tabUrl: currentUrl,
                    pageId,
                });
                if (sim.blocked) throw new TypeError("Failed to fetch (blocked by TangiTweak)");
                return fromWireResponse({
                    url: sim.redirectedTo || sim.url,
                    status: sim.status || 200,
                    statusText: "",
                    headers: Object.entries(sim.headers),
                    body: sim.bytes(),
                });
            };
            win.fetch = pageFetchShim as typeof fetch;
            globalThis.fetch = pageFetchShim as typeof fetch;
        }

        // SiteStoreHost <-> SiteMirrors (async message hop matching window.postMessage)
        const mirrorListeners = new Set<(m: SiteDown) => void>();
        const siteHost = new SiteStoreHost({
            post: (m: SiteDown) => {
                const cloned = structuredClone(m);
                setTimeout(() => mirrorListeners.forEach((fn) => fn(cloned)), 0);
            },
            log: (scriptId, msg, level) => logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "siteStore", msg),
        });
        siteHost.ready();
        const postToSiteHost = (m: SiteUp) => {
            const cloned = structuredClone(m);
            setTimeout(() => siteHost.receive(cloned), 0);
        };
        const isoSiteMirrors = new SiteMirrors({
            ctx: "isolated",
            post: postToSiteHost,
            log: (scriptId, msg, level) => logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "siteStore", msg),
        });
        const onSiteDownIso = (m: SiteDown) => isoSiteMirrors.receive(m);
        mirrorListeners.add(onSiteDownIso);

        // Isolated world store ReplicaHub connected to StoreOwner
        const [isoClientEp, isoOwnerEp] = endpointPair();
        owner.attach(isoOwnerEp, { all: false });
        const isoHub = new ReplicaHub({
            ctx: "isolated",
            log: (scriptId, msg, level) => logSink(scriptById.get(scriptId)?.name ?? scriptId, level, "store", msg),
        });
        isoHub.prime(await owner.init(ws.scripts.map((s) => s.id), { page: pageId }));
        isoHub.attach(isoClientEp);

        // Keyboard shortcuts registry for `onPage` + `onOverlay`
        const shortcutReg = new ShortcutRegistry();
        const shortcutFns = new Map<string, () => unknown>();
        let shortcutSeq = 0;
        const addPageShortcut = (scriptId: string, combo: string, fn: () => unknown, opts: any, signal: AbortSignal) => {
            const priority = shortcutPriority(fn, opts);
            if (!combo) return () => {};
            const id = `k_${++shortcutSeq}`;
            shortcutReg.add(scriptId, id, combo, priority);
            shortcutFns.set(id, fn);
            const off = () => {
                if (!shortcutFns.delete(id)) return;
                shortcutReg.remove(scriptId, id);
            };
            signal.addEventListener("abort", off, { once: true });
            return off;
        };
        const stopShortcuts = watchShortcuts(
            win,
            (e) => shortcutReg.find(e),
            (hits) =>
                hits
                    .map((h) => {
                        const fn = shortcutFns.get(h.id);
                        if (!fn) return false;
                        return runShortcut(fn, (err) => logSink(scriptById.get(h.s)?.name ?? h.s, "error", "ctx.shortcut", String((err as any)?.message || err)));
                    })
                    .includes(true),
            { trusted: () => true }
        );

        interface ScriptWorldState {
            script: { id: string; name: string; code: string };
            siteLife: ScriptLife;
            isoLife: ScriptLife;
            setIsoReact: (fn: () => ReactDomClient) => void;
            siteExposer: Exposer;
            isoExposer: Exposer;
            siteGen: Generation | null;
            isoGen: Generation | null;
            sitePending: PageDocumentHandler[];
            isoPending: PageDocumentHandler[];
            siteRan: Set<string>;
            isoRan: Set<string>;
            overlay?: {
                rt: OverlayRuntime;
                bridge: ReturnType<typeof endpointPair>[1];
                hostEl: HTMLElement;
                doc: Document;
                win: Window & typeof globalThis;
                onSiteDown: (m: SiteDown) => void;
                shortcutIds: Map<string, string>;
            };
        }

        const states = new Map<string, ScriptWorldState>();
        for (const s of entryScripts) {
            const siteReact: () => ReactDomClient = () => ({ createRoot: ReactDOMClient.createRoot });
            let isoReact: () => ReactDomClient = () => ({ createRoot: ReactDOMClient.createRoot });
            states.set(s.id, {
                script: s,
                siteLife: new ScriptLife({
                    doc,
                    shadow: useShadow,
                    react: () => siteReact(),
                    onError: (e) => logSink(s.name, "error", "onSite teardown", formatScriptError(s.name, e, "teardown")),
                }),
                isoLife: new ScriptLife({
                    doc,
                    shadow: useShadow,
                    react: () => isoReact(),
                    onError: (e) => logSink(s.name, "error", "onPage teardown", formatScriptError(s.name, e, "teardown")),
                }),
                setIsoReact: (fn) => {
                    isoReact = fn;
                },
                siteExposer: new Exposer(),
                isoExposer: new Exposer(),
                siteGen: null,
                isoGen: null,
                sitePending: [],
                isoPending: [],
                siteRan: new Set(),
                isoRan: new Set(),
            });
        }

        const fireDueForState = (st: ScriptWorldState, hot: boolean) => {
            if (st.siteGen) {
                for (const d of st.sitePending) {
                    if (!hot && phaseRank(d.when) > phaseRank(currentPhase)) continue;
                    if (st.siteRan.has(d.h)) continue;
                    st.siteRan.add(d.h);
                    fireRun(st.siteLife, st.siteGen, d, pageCtxBase(currentUrl), st.siteExposer, (e) =>
                        logSink(st.script.name, "error", "onSite", formatScriptError(st.script.name, e, "onSite"))
                    );
                }
            }
            if (st.isoGen) {
                for (const d of st.isoPending) {
                    if (!hot && phaseRank(d.when) > phaseRank(currentPhase)) continue;
                    if (st.isoRan.has(d.h)) continue;
                    st.isoRan.add(d.h);
                    fireRun(
                        st.isoLife,
                        st.isoGen,
                        d,
                        (signal) => ({
                            ...pageCtxBase(currentUrl),
                            shortcut: (combo: string, fn: () => unknown, opts?: any) => addPageShortcut(st.script.id, combo, fn, opts, signal),
                        }),
                        st.isoExposer,
                        (e) => logSink(st.script.name, "error", "onPage", formatScriptError(st.script.name, e, "onPage"))
                    );
                }
            }
        };

        const runScriptsOnPage = async (hot: boolean) => {
            const storeInit = await owner.init(ws.scripts.map((s) => s.id), { page: pageId });
            isoHub.prime(storeInit);

            for (const st of states.values()) {
                const { script: s } = st;
                const analyzed = compiledMap.get(s.id);
                if (!analyzed || analyzed.error || !analyzed.meta.active) continue;

                const routes = analyzed.meta.routes || [];
                const hasSite = routes.some((r) => r.kind === "onDocument" && pageWorld(r) === "page");
                const hasIso = routes.some((r) => r.kind === "onDocument" && pageWorld(r) === "isolated");
                const overlayRoutes = routes.filter((r) => r.kind === "onOverlay");

                const src = toRunnableJs(s.code);
                const resolvedParams = resolveParamValues(analyzed.paramDefs || {}, paramOverrides.get(s.id));
                const libs = shippedLibsFor(analyzed.deps);
                const consoleSite = makeScriptConsole((level, sourceLabel, text) => logSink(s.name, level, sourceLabel, text));
                const consoleIso = makeScriptConsole((level, sourceLabel, text) => logSink(s.name, level, sourceLabel, text));

                const wrapReq = (reqFn: (spec: string) => any) => (spec: string) => (mockObjs.has(spec) ? mockObjs.get(spec) : reqFn(spec));

                // 1. Site world (`tt.onSite`)
                if (hasSite) {
                    if (hot) st.siteExposer.reset();
                    const g = st.siteLife.begin();
                    const makeSiteShim = (libName?: string, libParams?: Record<string, any>, mine = false) =>
                        makePageShim({
                            params: (mine ? resolvedParams : libParams) || {},
                            world: "page",
                            lib: libName,
                            exposer: mine ? st.siteExposer : undefined,
                            siteStore: mine ? (name, initial) => siteHost.store(s.id, name, initial) : undefined,
                            onSiteCall: (e) => logSink(s.name, "error", "onSite", formatScriptError(s.name, e, "onSite")),
                            log: (source, ...args) => logSink(s.name, "info", source, scriptLogLine(libName ?? s.name, source, formatLogArgs(args))),
                            storage: {
                                get: async (key: string) => structuredClone(storageData.get(s.id)?.[key]),
                                set: async (key: string, value: any) => {
                                    const obj = storageData.get(s.id) ?? {};
                                    obj[key] = structuredClone(value);
                                    storageData.set(s.id, obj);
                                },
                            },
                        });
                    const requireFrom = makeLibRequire(
                        libs,
                        (lib, req, mod) =>
                            scriptFunction(lib.src!, lib.name)(makeSiteShim(lib.name, lib.params, false).tt, consoleSite, wrapReq(req), mod, mod.exports),
                        { builtin: siteBuiltin, onSite: true }
                    );
                    const mod = { exports: {} as any };
                    const shim = makeSiteShim(undefined, undefined, true);
                    shim.top(() => scriptFunction(src, s.name)(shim.tt, consoleSite, wrapReq(requireFrom(s.name)), mod, mod.exports));
                    st.sitePending = domHandlersFor(shim.dom, currentUrl, st.siteExposer);
                    st.siteExposer.done();
                    st.siteGen = g;
                    st.siteRan.clear();
                }

                // 2. Overlay frame (`tt.onOverlay`)
                if (overlayRoutes.length) {
                    const libStores: Record<string, any> = {};
                    for (const l of libs) if (l.id && storeInit[l.id]) libStores[l.id] = storeInit[l.id];
                    const codeHash = contentHash(JSON.stringify([s.code, resolvedParams, libs.map((l) => [l.name, l.src ?? l.json ?? l.alias ?? ""])]));
                    const ovInit: OverlayInit = {
                        s: s.id,
                        name: s.name,
                        code: s.code,
                        codeHash,
                        routes: overlayRoutes,
                        url: currentUrl,
                        params: resolvedParams,
                        stores: storeInit[s.id] || {},
                        libStores,
                        page: pageId,
                        libs,
                        react: needsReact([s.code, ...libs.map((l) => l.src ?? "")], pkgs),
                        phase: currentPhase,
                    };
                    if (!st.overlay) {
                        const hostEl = doc.createElement("div");
                        hostEl.setAttribute("data-tangitweak-overlay-host", s.name);
                        doc.documentElement.appendChild(hostEl);
                        hostEl.attachShadow({ mode: "closed" });
                        const ovDoc = doc.implementation.createHTMLDocument(`tt-overlay-${s.name}`);
                        const ovWin = win;

                        const [frameEp, bridgeEp] = endpointPair();
                        owner.attach(bridgeEp, { all: false });
                        const onSiteDown = (m: SiteDown) => !bridgeEp.closed && bridgeEp.push("site.down", m);
                        mirrorListeners.add(onSiteDown);
                        bridgeEp.on("site.up", (m) => postToSiteHost(m));
                        bridgeEp.handle("storage.get", async ({ key }) => ({ value: structuredClone(storageData.get(s.id)?.[key]) }));
                        bridgeEp.handle("storage.set", async ({ key, value }) => {
                            const obj = storageData.get(s.id) ?? {};
                            obj[key] = structuredClone(value);
                            storageData.set(s.id, obj);
                            return {};
                        });
                        bridgeEp.handle("param.set", async ({ key, value, lib }) => {
                            const target = lib ? scriptByName.get(lib) : s;
                            if (target) paramOverrides.set(target.id, { ...(paramOverrides.get(target.id) || {}), [key]: value });
                            return {};
                        });
                        bridgeEp.handle("pagefetch", async ({ request, bypass }) => {
                            if (bypass) return bgWireFetch(request, true);
                            const sim = await simulate(request.url, {
                                method: request.method,
                                headers: Object.fromEntries(request.headers),
                                body: request.body ?? undefined,
                                tabId,
                                tabUrl: currentUrl,
                                pageId,
                            });
                            if (sim.blocked) throw new TypeError("Failed to fetch (blocked by TangiTweak)");
                            return {
                                url: sim.redirectedTo || sim.url,
                                status: sim.status || 200,
                                statusText: "",
                                headers: Object.entries(sim.headers),
                                body: sim.bytes(),
                            };
                        });
                        bridgeEp.handle("fetch", ({ request, bypass }) => bgWireFetch(request, bypass));
                        bridgeEp.on("log", ({ level, msg }) => logSink(s.name, level, "overlay", msg));
                        bridgeEp.on("rpc.call", (call) => {
                            if (!isRpcCall(call)) return;
                            const targetExposer = call.h.startsWith("onSite:") ? st.siteExposer : st.isoExposer;
                            targetExposer.answer(call, (res) => !bridgeEp.closed && bridgeEp.push("rpc.result", res));
                        });
                        const shortcutIds = new Map<string, string>();
                        bridgeEp.on("shortcut.add", ({ id, keys: combo, priority }) => {
                            const regId = `ov_${s.id}_${id}`;
                            shortcutIds.set(id, regId);
                            shortcutReg.add(s.id, regId, combo, priority);
                            shortcutFns.set(regId, () => {
                                !bridgeEp.closed && bridgeEp.push("shortcut.fire", { id });
                                return true;
                            });
                        });
                        bridgeEp.on("shortcut.remove", ({ id }) => {
                            const regId = shortcutIds.get(id);
                            if (!regId) return;
                            shortcutIds.delete(id);
                            shortcutFns.delete(regId);
                            shortcutReg.remove(s.id, regId);
                        });

                        const rt = await startOverlay(frameEp, ovInit, {
                            win: ovWin,
                            doc: ovDoc,
                            patchFetch: false,
                            watchRects: false,
                            trustedKey: () => true,
                        });
                        st.overlay = { rt, bridge: bridgeEp, hostEl, doc: ovDoc, win: ovWin, onSiteDown, shortcutIds };
                    } else if (hot) {
                        st.overlay.bridge.push("overlay.update", ovInit);
                    }
                }

                // 3. Isolated world (`tt.onPage`)
                if (hasIso) {
                    if (hot) st.isoExposer.reset();
                    const g = st.isoLife.begin();
                    const siteRpc = new RpcClient((call) => st.siteExposer.answer(call, (r) => siteRpc.receive(r)));
                    const localIsoRpc = new RpcClient((call) => st.isoExposer.answer(call, (r) => localIsoRpc.receive(r)));
                    const overlayRpc = new RpcClient((call) => {
                        if (!st.overlay || st.overlay.bridge.closed) {
                            overlayRpc.receive({ cid: call.cid, ok: false, error: { message: "overlay is not running on this page" } });
                            return;
                        }
                        st.overlay.rt.exposer.answer(call, (r) => overlayRpc.receive(r));
                    });
                    g.signal.addEventListener(
                        "abort",
                        () => {
                            siteRpc.disconnect("reloaded");
                            localIsoRpc.disconnect("reloaded");
                            overlayRpc.disconnect("reloaded");
                        },
                        { once: true }
                    );

                    const callHandle = (api: PlaceApi, key: string, _route: RouteMeta) => {
                        const sig = () => g.signal;
                        if (api === "onSite") return siteRpc.remote(key, sig);
                        if (api === "onPage") return localIsoRpc.remote(key, sig);
                        return overlayRpc.remote(key, sig);
                    };

                    const makeIsoShim = (storeOwnerId: string, name: string, pVals: Record<string, any>, mine: boolean) =>
                        makePageShim({
                            params: pVals,
                            world: "isolated",
                            lib: mine ? undefined : name,
                            stores: {
                                store: (n, initial, persist) => isoHub.store(storeOwnerId, n, initial, persist),
                                tabStore: (n, initial) => isoHub.tabStore(storeOwnerId, n, initial, tabScopeOfPage(pageId)),
                                pageStore: (n, initial) => isoHub.pageStore(storeOwnerId, n, initial, pageId),
                            },
                            siteStore: mine ? (n, initial) => isoSiteMirrors.store(s.id, n, initial) : undefined,
                            exposer: mine ? st.isoExposer : undefined,
                            call: mine ? callHandle : undefined,
                            log: (source, ...args) => logSink(s.name, "info", source, scriptLogLine(name, source, formatLogArgs(args))),
                            storage: {
                                get: async (key: string) => structuredClone(storageData.get(s.id)?.[key]),
                                set: async (key: string, value: any) => {
                                    const obj = storageData.get(s.id) ?? {};
                                    obj[key] = structuredClone(value);
                                    storageData.set(s.id, obj);
                                },
                            },
                            setParam: async (key, value, lib) => {
                                const target = lib ? scriptByName.get(lib) : s;
                                if (target) paramOverrides.set(target.id, { ...(paramOverrides.get(target.id) || {}), [key]: value });
                            },
                        });

                    const codeOf = (importer: string) => (importer === s.name ? src : (libs.find((l) => l.name === importer)?.src ?? ""));
                    const requireFrom = makeLibRequire(
                        libs,
                        (lib, req, mod) =>
                            scriptFunction(lib.src!, lib.name)(makeIsoShim(lib.id ?? s.id, lib.name, lib.params || {}, false).tt, consoleIso, wrapReq(req), mod, mod.exports),
                        { builtin: scriptBuiltin(codeOf, hotRegistry(s.name).begin()) }
                    );
                    const mod = { exports: {} as any };
                    const shim = makeIsoShim(s.id, s.name, resolvedParams, true);
                    shim.top(() => scriptFunction(src, s.name)(shim.tt, consoleIso, wrapReq(requireFrom(s.name)), mod, mod.exports));
                    st.setIsoReact(() => {
                        try {
                            return reactOf(wrapReq(requireFrom(s.name)));
                        } catch {
                            return { createRoot: ReactDOMClient.createRoot };
                        }
                    });
                    st.isoPending = domHandlersFor(shim.dom, currentUrl, st.isoExposer);
                    st.isoExposer.done();
                    st.isoGen = g;
                    st.isoRan.clear();
                }

                fireDueForState(st, hot);
                if (st.siteGen) st.siteLife.commit(st.siteGen);
                if (st.isoGen) st.isoLife.commit(st.isoGen);
            }
            await flushAsync(12, true);
        };

        await runScriptsOnPage(false);

        let closed = false;
        const pageObj: TestPage & { _hotUpdate(): Promise<void> } = {
            get url() {
                return currentUrl;
            },
            window: win,
            document: doc,
            get mounts(): PageMountSlot[] {
                const slots: PageMountSlot[] = [];
                for (const st of states.values()) {
                    for (const m of st.siteLife.mountSlots()) {
                        slots.push({ script: st.script.name, world: "page", anchor: m.anchor, host: m.host, container: m.container as HTMLElement });
                    }
                    for (const m of st.isoLife.mountSlots()) {
                        slots.push({ script: st.script.name, world: "isolated", anchor: m.anchor, host: m.host, container: m.container as HTMLElement });
                    }
                }
                return slots;
            },
            mountFor(selector?: string): HTMLElement | null {
                const all = pageObj.mounts;
                if (!selector) return all[0]?.container ?? null;
                const hit = all.find((m) => m.anchor && m.anchor.matches(selector));
                return hit?.container ?? null;
            },
            get overlay(): HTMLElement | null {
                for (const st of states.values()) {
                    if (st.overlay?.doc?.body) return st.overlay.doc.body;
                }
                return null;
            },
            overlayFor(scriptName?: string): HTMLElement | null {
                if (!scriptName) return pageObj.overlay;
                const s = resolveScript(scriptName);
                return states.get(s.id)?.overlay?.doc?.body ?? null;
            },
            siteStore<T extends Record<string, any> = Record<string, any>>(name: string, initial: T = {} as T, scriptName?: string): T {
                const s = resolveScript(scriptName);
                return siteHost.store(s.id, name, initial) as T;
            },
            async advanceTo(nextPhase: DocumentWhen): Promise<void> {
                if (phaseRank(nextPhase) > phaseRank(currentPhase)) currentPhase = nextPhase;
                for (const st of states.values()) {
                    fireDueForState(st, false);
                    if (st.overlay && !st.overlay.bridge.closed) st.overlay.bridge.push("when", { phase: currentPhase });
                }
                await flushAsync(12, true);
            },
            async navigate(nextUrl: string | URL): Promise<void> {
                currentUrl = new URL(String(nextUrl), currentUrl).href;
                setWindowUrl(win, currentUrl);
                for (const st of states.values()) {
                    if (st.overlay && !st.overlay.bridge.closed) st.overlay.bridge.push("nav", { url: currentUrl });
                }
                await flushAsync(12, true);
            },
            async reload(): Promise<void> {
                await runScriptsOnPage(true);
            },
            async _hotUpdate(): Promise<void> {
                await runScriptsOnPage(true);
            },
            async pressKey(combo: string, target?: EventTarget): Promise<boolean> {
                const ev = new win.KeyboardEvent("keydown", buildKeyboardEventInit(combo));
                const ok = (target ?? doc.activeElement ?? doc.body ?? win).dispatchEvent(ev);
                await flushAsync(12, true);
                return !ok || ev.defaultPrevented;
            },
            async flush(): Promise<void> {
                await flushAsync(12, true);
            },
            async close(): Promise<void> {
                if (closed) return;
                closed = true;
                openPages.delete(pageObj);
                stopShortcuts();
                mirrorListeners.delete(onSiteDownIso);
                isoSiteMirrors.dispose();
                for (const st of states.values()) {
                    st.siteLife.stop();
                    st.isoLife.stop();
                    if (st.overlay) {
                        mirrorListeners.delete(st.overlay.onSiteDown);
                        st.overlay.rt.stop();
                        st.overlay.bridge.close("page closed");
                        st.overlay.hostEl.remove();
                    }
                }
                isoClientEp.close("page closed");
                isoOwnerEp.close("page closed");
                owner.dropPage(pageId);
                if (pageOpts.interceptFetch !== false) {
                    win.fetch = prevWinFetch;
                    globalThis.fetch = prevGlobalFetch;
                }
                await flushAsync(4, false);
            },
            async [Symbol.asyncDispose](): Promise<void> {
                await pageObj.close();
            },
        };

        openPages.add(pageObj);
        return pageObj;
    }

    const tweak: LoadedTweak = {
        manifest: ws.manifest,
        get metadata() {
            return compiledMap.get(primaryScript.id)?.meta.metadata;
        },
        get capabilities() {
            const routes = entryScripts.flatMap((s) => compiledMap.get(s.id)?.meta.routes || []);
            const connect = [
                ...(ws.manifest?.connect || []),
                ...entryScripts.flatMap((s) => compiledMap.get(s.id)?.meta.metadata?.connect || []),
            ];
            return capabilitiesOf(
                routes,
                connect,
                ws.scripts.map((s) => s.code)
            );
        },
        get scripts() {
            return entryScripts.map((s) => {
                const c = compiledMap.get(s.id)!;
                return {
                    id: s.id,
                    name: s.name,
                    metadata: c.meta.metadata,
                    paramDefs: c.paramDefs,
                    exports: c.exports,
                    rules: [...(currentRulesByScript.get(s.id) || [])],
                };
            });
        },
        get exports() {
            return compiledMap.get(primaryScript.id)?.exports;
        },
        get rules() {
            return [...currentRules];
        },
        get errors() {
            return [...currentErrors];
        },
        get warnings() {
            return [...currentWarnings];
        },
        logs,
        storage: {
            get(key: string, scriptName?: string) {
                const s = resolveScript(scriptName);
                const raw = storageData.get(s.id)?.[key];
                return raw === undefined ? undefined : structuredClone(raw);
            },
            set(key: string, value: any, scriptName?: string) {
                const s = resolveScript(scriptName);
                const obj = storageData.get(s.id) ?? {};
                obj[key] = structuredClone(value);
                storageData.set(s.id, obj);
            },
            snapshot(scriptName?: string) {
                const s = resolveScript(scriptName);
                const raw = storageData.get(s.id) ?? {};
                const clean: Record<string, any> = {};
                for (const [k, v] of Object.entries(raw)) {
                    if (!k.startsWith("$store:")) clean[k] = structuredClone(v);
                }
                return clean;
            },
        },
        store<T extends Record<string, any> = Record<string, any>>(name: string, initial: T = {} as T, scriptName?: string): T {
            const s = resolveScript(scriptName);
            return bgHub.store(s.id, name, initial, false) as T;
        },
        tabStore<T extends Record<string, any> = Record<string, any>>(name: string, tabId = 1, initial: T = {} as T, scriptName?: string): T {
            knownTabIds.add(tabId);
            const s = resolveScript(scriptName);
            return bgHub.tabStore(s.id, name, initial, tabScope(tabId)) as T;
        },
        pageStore<T extends Record<string, any> = Record<string, any>>(name: string, pageId = "tab:1", initial: T = {} as T, scriptName?: string): T {
            const s = resolveScript(scriptName);
            return bgHub.pageStore(s.id, name, initial, pageId) as T;
        },
        async setParams(values: Record<string, any>, scriptName?: string): Promise<void> {
            applyParamInput(values, scriptName);
            await compileAll();
            for (const p of [...openPages]) await p._hotUpdate();
        },
        simulate,
        openPage,
        async dispose(): Promise<void> {
            for (const p of [...openPages]) await p.close();
            bgClientEp.close("disposed");
            bgOwnerEp.close("disposed");
            for (const k of ownedMockKeys) mockRegistry.delete(k);
        },
        async [Symbol.asyncDispose](): Promise<void> {
            await tweak.dispose();
        },
    };

    return tweak;
}
