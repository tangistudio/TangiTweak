/**
 * The loader behind `"tangitweak/test"`: {@link loadTweak} loads a tweak in
 * Node and runs it the way the extension does, for local and CI tests.
 *
 * It runs TangiTweak's real compiler and module/data resolver, the DNR rules
 * probe (with Chrome's rule checks), the `bodyOps` network pipeline walked
 * through each browser's layers, `StoreOwner` + `SiteStoreHost` Valtio
 * replicas and the `onSite` / `onPage` / `onOverlay` DOM and React 19 Shadow
 * DOM lifecycles. Nothing reaches a browser, the helper or the network:
 * npm packages come from the `node_modules` folders above the tweaks loaded
 * so far. A request's response comes from the test (its `upstream`, else
 * {@link LoadTweakOptions.fetch}, else an empty `200`).
 *
 * - {@link loadTweak} returns a {@link LoadedTweak}: the background side
 *   (network handlers, stores, storage, params) plus {@link LoadedTweak.simulate}
 *   for requests and {@link LoadedTweak.openPage} for tabs.
 * - Each {@link TestPage} is a tab with its own happy-dom document. Its MAIN
 *   world (`onSite`, the website's own globals) and isolated world (`onPage`)
 *   share the DOM but not JavaScript globals; each overlay frame has a window
 *   of its own.
 *
 * The fixtures exported by `"tangitweak/test"` (`test`, `createTweakTest`,
 * `mount`) load one copy per test through {@link loadTweak}. Call it
 * directly for a tweak written inside the test.
 *
 * @see docs/testing.md
 * @module
 */

import "./dom";
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
import { parseManifest, type Manifest, type PackageMetadata } from "../shared/packageMetadata";
import { ensurePackages, packagesSnapshot } from "../background/engine/packageImports";
import { isUrlSpec, packageClosure, type PackageModules } from "../shared/packageImports";
import { crawl, isPackageFile, pickStart } from "../shared/packageSource";
import { domHandlersFor, fireRun, makePageShim, pageCtxBase, type PageDocumentHandler } from "../shared/pageShim";
import { NavRoutes } from "../shared/navRoutes";
import { requestBodyFrom, requestBodyFromText, type RequestBody } from "../shared/requestBody";
import { followsNav, pageWorld, type DocumentWhen, type PlaceApi, type RouteMeta, type Strategy } from "../shared/route";
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
import { setPackageFetch } from "../background/engine/packageImports";
import { handlerLayer, routeLabel, sortByLayer } from "../shared/route";
import { Window as HappyWindow } from "happy-dom";
import { backgroundScope, inScope, pageScope, windowScope } from "./worlds";
import type { ScriptScope } from "../shared/scriptScope";
import { checkRules } from "./ruleChecks";
import { localUnpkg, nodeModulesAbove } from "./localPackages";
import { layerScripts, requestThroughLayers, webRequestType, type BrowserName, type DecidedBy, type RuleGroupRef, type SkippedHandler } from "./layers";

export type { BrowserName, DecidedBy, SkippedHandler } from "./layers";

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

// npm packages come from the node_modules folders above the tweaks loaded so far, never the network
const packageRoots = new Set<string>();
setPackageFetch(localUnpkg(() => [...packageRoots]));


/**
 * A tweak written inside the test, for {@link loadTweak}.
 *
 * Without `files["package.json"]` (or with it and `code`), `code` is the
 * entry script and every other file in `files` is a companion script or data
 * file it can import. With a `package.json` and no `code`, the package's
 * entry runs and its imports are crawled from `files`: one that isn't there
 * (and isn't in {@link LoadTweakOptions.mocks}) fails the load.
 *
 * @example
 * await using t = await loadTweak({
 *     code: `import { tweak } from "tangitweak";
 * import { HOST } from "./config";
 * tweak.onRequest({ url: HOST + "/ads/*", strategy: "rules" }, () => ({ block: true }));`,
 *     files: { "config.ts": `export const HOST = "*://example.com";` },
 * });
 */
export interface InlineTweakSource {
    /** The entry script's TypeScript / TSX source. Optional when `files["package.json"]` is given: its entry runs instead. */
    code?: string;
    /**
     * The entry script's path in the tweak, with or without extension. It's
     * saved as `<name>.tsx`, so `name: "lib/main"` imports siblings as
     * `./other` from `lib/`.
     *
     * @defaultValue `"script"`
     */
    name?: string;
    /** Companion scripts, a `package.json` or data files, by path in the tweak (`path -> content`). */
    files?: Record<string, string>;
}

/**
 * What {@link loadTweak} loads: a path or `file:` URL to a tweak's folder, its
 * `package.json` or a file in it; or an {@link InlineTweakSource}.
 *
 * A folder must hold a `package.json`. A relative string path resolves
 * against {@link LoadTweakOptions.cwd} when set; otherwise a path starting
 * with `.` resolves against the calling test file's folder when it exists
 * there. Anything else resolves against `process.cwd()`.
 */
export type TweakSource = string | URL | InlineTweakSource;

/**
 * Options for {@link loadTweak}. The fixtures' `createTweakTest` passes its
 * `params`, `entry`, `browser`, `realLimits`, `mocks` and `storage` through
 * to the same options.
 *
 * @example
 * await using t = await loadTweak("../", {
 *     params: { env: "prod" },
 *     storage: { seen: 3 },
 *     mocks: { dayjs: () => ({ format: () => "2026-01-01" }) },
 *     browser: "firefox",
 * });
 */
export interface LoadTweakOptions {
    /** Base directory for a relative string {@link TweakSource}. Without it, the calling test file's folder (for `./` paths that exist there) or `process.cwd()`. */
    cwd?: string;
    /**
     * Param values to use instead of the defaults: `{ key: val }` for every
     * script or `{ [scriptName]: { key: val } }` per script. It's read per
     * script only when every key names a script and holds an object.
     */
    params?: Record<string, any>;
    /**
     * Starting `tweak.storage` values (structured clones): `{ key: val }` for
     * every script or `{ [scriptName]: { key: val } }` per script. It's read
     * per script only when every key is a script's exact name and holds an
     * object.
     */
    storage?: Record<string, any>;
    /** Starting `tweak.globalStore` values by store id (`{ id: { … } }`), seeded into each entry script's storage as the store's persisted state. */
    stores?: Record<string, Record<string, any>>;
    /**
     * Modules to replace, by import specifier (`{ dayjs: exports, "./lib": exports }`).
     *
     * The value is what the import gets: an object's keys become named
     * exports and the object itself the `default` (unless it has a `default`
     * key); anything else becomes the default export. A mocked package isn't
     * loaded from `node_modules`. `vi.mock` doesn't reach the tweak's code,
     * which this loader compiles.
     */
    mocks?: Record<string, any>;
    /**
     * The server behind the handlers: what `tweak.fetch` reaches (directly
     * with `bypass`) and what {@link LoadedTweak.simulate} calls without an
     * {@link SimulateRequestInit.upstream} get.
     *
     * @defaultValue An empty `200` response.
     */
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /**
     * Keep going instead of throwing when a script has compile, DNR rule or
     * `onSite` errors: they're listed in {@link LoadedTweak.errors}. Also
     * stops {@link LoadedTweak.simulate} from throwing when the rules it
     * re-checks have errors.
     *
     * @defaultValue `false`
     */
    allowCompileErrors?: boolean;
    /**
     * The browser whose limits requests and pages follow: `"chrome"` (MV3),
     * `"chromium-mv2"` or `"firefox"`. It decides which handlers are turned
     * off, what each strategy sees and whether a page's CSP moves `onSite`
     * to the isolated world.
     *
     * @defaultValue `"chrome"`
     */
    browser?: BrowserName;
    /**
     * Whether requests walk the strategies as the browser's layers
     * (`page → rules → extension → debugger → helper`), each with its real
     * limits. `false`: every matching handler runs in one chain, whatever its
     * strategy. No handler is turned off for the browser.
     *
     * @defaultValue `true`
     */
    realLimits?: boolean;
    /** The entry file to run instead of the `package.json`'s `main` (`"./only-misc.ts"`). Needs a tweak on disk with a `package.json`. */
    entry?: string;
    /** Files added to (or replacing) the tweak folder's on disk, by path in the tweak (`path -> content`). */
    files?: Record<string, string>;
}

/**
 * One line the tweak logged: a `console` call, an uncaught handler error, or
 * a notice from the stores or the network pipeline.
 *
 * @example
 * expect(t.logs).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringContaining("[onSite]") }));
 */
export interface TweakLogEntry {
    /** Name of the script that logged it: its path in the tweak, without extension. */
    script: string;
    /** Severity. Uncaught handler and teardown errors are `"error"`. */
    level: "debug" | "info" | "warn" | "error";
    /** The text, after a `[source]` tag when the line has a source (`[console.log]`, `[onSite]`, `[store]`, `[overlay]`…). */
    message: string;
    /** On network pipeline lines: whether a handler only observed the request (`"observed"`) or changed it (`"modified"`). */
    kind?: string;
}

/** One entry script of a loaded tweak, as {@link LoadedTweak.scripts} lists it. */
export interface LoadedScriptInfo {
    /** The loader's id for the script (`"s1"`, `"s2"`…, in load order), the key its storage and stores live under. */
    id: string;
    /** The script's path in the tweak, without extension (`"index"`, `"features/palette/index"`). */
    name: string;
    /** The `tweak.params(...)` definitions it declared, if any. */
    paramDefs?: ParamTree;
    /** Its module exports, from the latest compile. */
    exports: any;
    /** The declarativeNetRequest rules its `strategy: "rules"` handlers generate, after Chrome's checks. */
    rules: RuleSpec[];
}

/**
 * The request a {@link SimulateRequestInit.upstream} function answers: what
 * reached the server after the handlers changed it.
 */
export interface UpstreamRequest {
    /** The request URL. */
    url: string;
    /** The method, upper-case (`"GET"`). */
    method: string;
    /** The request headers as the handlers left them, lower-case names. */
    headers: Record<string, string>;
    /** The request body; `undefined` when it has none. */
    body?: {
        /** The body's bytes (UTF-8 for a string body). */
        readonly raw: Uint8Array;
        /** The body decoded as UTF-8. */
        readonly text: string;
        /** The request's `content-type` header, if any. */
        readonly contentType?: string;
        /**
         * Parses {@link UpstreamRequest.body.text} as JSON.
         *
         * @throws SyntaxError when it isn't JSON.
         */
        json<T = any>(): T;
        /** Parses {@link UpstreamRequest.body.text} as `application/x-www-form-urlencoded`. */
        formData(): URLSearchParams;
    };
    /** The webRequest resource type (`"xmlhttprequest"`, `"main_frame"`, `"sub_frame"`, `"script"`…). */
    resourceType: string;
    /** The tab the request came from. */
    tabId: number;
    /** The URL of the tab's page. */
    tabUrl: string;
}

/**
 * A fake server response for {@link SimulateRequestInit.upstream}.
 *
 * @example
 * await t.simulate("https://api.example.com/flags", {
 *     upstream: { status: 200, body: { newNav: false } },
 * });
 */
export interface UpstreamResponseInit {
    /**
     * The status code.
     *
     * @defaultValue `200`
     */
    status?: number;
    /** The response headers. */
    headers?: Record<string, string> | Headers;
    /**
     * The body. An object or array is sent as JSON (with `content-type:
     * application/json` unless set).
     *
     * @defaultValue `""`
     */
    body?: string | Uint8Array | Record<string, any> | any[];
    /** The `content-type`, when `headers` doesn't set one. */
    contentType?: string;
}

/**
 * The request {@link LoadedTweak.simulate} sends through the handlers, and
 * the fake server that answers it.
 *
 * @example
 * const res = await t.simulate("https://api.example.com/save", {
 *     method: "POST",
 *     body: { id: 1 },
 *     upstream: (req) => ({ body: { echoed: req.body?.json() } }),
 * });
 */
export interface SimulateRequestInit {
    /**
     * The method.
     *
     * @defaultValue `"GET"`
     */
    method?: string;
    /** The request headers. */
    headers?: Record<string, string> | Headers;
    /** The request body. An object or array is sent as JSON (with `content-type: application/json` unless set). */
    body?: string | Uint8Array | Record<string, any> | any[];
    /**
     * What kind of request it is: `"fetch"` / `"xhr"` (fetch/XHR),
     * `"document"` (a top-level page load), `"iframe"` or a webRequest type
     * such as `"script"` or `"image"`. Each strategy sees only some kinds
     * (`page` only the page's own fetch/XHR).
     *
     * @defaultValue A fetch/XHR (`"xmlhttprequest"`).
     */
    resourceType?: string;
    /**
     * The tab it comes from: the handlers' `tabStore`s are this tab's. A
     * tab's first `"document"` request is one the `debugger` strategy may
     * miss.
     *
     * @defaultValue `1`
     */
    tabId?: number;
    /**
     * The URL of the tab's page.
     *
     * @defaultValue The request URL.
     */
    tabUrl?: string;
    /**
     * The page it comes from: the handlers' `pageStore`s are this page's.
     *
     * @defaultValue `"tab:<tabId>"`
     */
    pageId?: string;
    /**
     * Run only the handlers of this strategy, in one chain, without the
     * browser's layers ({@link SimulatedResponse.skipped} and
     * {@link SimulatedResponse.decidedBy} stay empty).
     */
    strategy?: Strategy;
    /**
     * The fake server: a response or a function from the
     * {@link UpstreamRequest} that reached it to one. It answers only when no
     * handler blocked, redirected or replaced the request.
     *
     * @defaultValue {@link LoadTweakOptions.fetch}, else an empty `200`.
     */
    upstream?: UpstreamResponseInit | Response | ((req: UpstreamRequest) => UpstreamResponseInit | Response | Promise<UpstreamResponseInit | Response>);
}

/**
 * What {@link LoadedTweak.simulate} returns: the response the page would get
 * and what the handlers did to the request.
 *
 * @example
 * const res = await t.simulate("https://api.example.com/flags");
 * expect(res.json()).toEqual({ newNav: true });
 * expect(res.decidedBy).toMatchObject({ strategy: "helper", outcome: "replace" });
 */
export interface SimulatedResponse {
    /**
     * What happened: `"blocked"`, `"redirected"` or `"replaced"` by a
     * handler, `"modified"` (request headers, response headers or body
     * changed) or `"passthrough"` (untouched).
     */
    action: "passthrough" | "modified" | "replaced" | "redirected" | "blocked";
    /** Handlers that matched but didn't run, each with the extension's reason. */
    skipped: SkippedHandler[];
    /** The handler whose block, redirect or replacement produced the result (`null`: none). */
    decidedBy: DecidedBy | null;
    /** Whether a handler blocked it (`action === "blocked"`); {@link SimulatedResponse.status} is then `0`. */
    blocked: boolean;
    /** Where a handler redirected it (status `307`); `null` if none did. */
    redirectedTo: string | null;
    /** Whether a handler replaced the response (`action === "replaced"`). */
    replaced: boolean;
    /** Whether anything changed, replacements included (`"modified"` or `"replaced"`). */
    modified: boolean;
    /** The requested URL (see {@link SimulatedResponse.redirectedTo} for a redirect's target). */
    url: string;
    /** The status code: `0` when blocked, `307` when redirected. */
    status: number;
    /** The request headers as they left the handlers, lower-case names. */
    requestHeaders: Record<string, string>;
    /** The response headers as the handlers left them, lower-case names. */
    headers: Record<string, string>;
    /** The response body, as text or bytes depending on how it was produced: read it with `text()`, `json()` or `bytes()`. */
    body: string | Uint8Array;
    /** The body as text (UTF-8 decoded when binary). */
    text(): string;
    /**
     * The body parsed as JSON.
     *
     * @throws SyntaxError when it isn't JSON.
     */
    json<T = any>(): T;
    /** The body's bytes (UTF-8 encoded when text). */
    bytes(): Uint8Array;
}

/**
 * Options for {@link LoadedTweak.openPage}.
 *
 * @example
 * const page = await t.openPage("https://app.example.com/", {
 *     html: `<main id="app"></main>`,
 *     phase: "document_start",
 *     setup: (win) => Object.assign(win, { APP_CONFIG: { beta: true } }),
 * });
 */
export interface OpenPageOptions {
    /** The page's starting `document.body.innerHTML`. */
    html?: string;
    /**
     * The document phase the page opens in: `"document_start"`,
     * `"document_end"` or `"document_idle"`. Handlers for later phases wait
     * for {@link TestPage.advanceTo}.
     *
     * @defaultValue `"document_end"`
     */
    phase?: DocumentWhen;
    /**
     * The tab ID: pages with the same one share `tweak.tabStore`s; each page
     * gets its own `pageStore`s. Also used for the page's requests.
     *
     * @defaultValue `1`
     */
    tabId?: number;
    /**
     * Wrap each `ctx.mount(...)` in a closed shadow root, as TangiTweak does
     * in the browser. `false`: a plain `<div>` in the page.
     *
     * @defaultValue `true`
     */
    shadow?: boolean;
    /**
     * Route the page `window.fetch` through {@link LoadedTweak.simulate} (with
     * this page's tab and page IDs) while the page is open. A blocked request
     * rejects with a `TypeError`, as in the browser.
     *
     * @defaultValue `true`
     */
    interceptFetch?: boolean;
    /**
     * The page's Content-Security-Policy. On `"chromium-mv2"` and
     * `"firefox"`, without `'unsafe-eval'` in `script-src` (or `default-src`),
     * `onSite` handlers run in the isolated world instead (as in the
     * extension) and a warning says so ({@link LoadedTweak.warnings}).
     */
    csp?: string;
    /**
     * Runs before any handler, with the page's own `window` (the MAIN
     * world): set up what the website itself would have, e.g. its globals.
     * The isolated world (`onPage`) doesn't see them, as in Chrome.
     */
    setup?: (window: Window & typeof globalThis) => void;
}

/** One live `ctx.mount(...)` root on a {@link TestPage}. */
export interface PageMountSlot {
    /** Name of the script that mounted it. */
    script: string;
    /** The world whose handler mounted it: `"page"` (`onSite`) or `"isolated"` (`onPage`). */
    world: "page" | "isolated";
    /** The page element it's mounted at; `null` for a floating mount without a target. */
    anchor: Element | null;
    /** The element in the page holding it: a `<tangitweak-mount>` with a closed shadow root (with {@link OpenPageOptions.shadow} `false`: the container itself). */
    host: Element;
    /** The element React renders into, inside the closed shadow root. */
    container: HTMLElement;
}

/**
 * A tab with the tweak running in it, from {@link LoadedTweak.openPage}.
 *
 * It has its own happy-dom document. `onSite` handlers run in its MAIN
 * world (the website's `window`), `onPage` handlers in an isolated world with
 * separate globals over the same DOM. Each overlay runs in a frame of its own.
 * Methods that act on the page settle the resulting work (as
 * {@link TestPage.flush}) before they resolve.
 *
 * @example
 * await using page = await t.openPage("https://app.example.com/", { html: `<nav></nav>` });
 * await page.pressKey("Alt+Shift+P");
 * expect(page.mountFor("nav")?.textContent).toContain("Palette");
 */
export interface TestPage {
    /** The page's current URL, absolute ({@link TestPage.navigate} changes it). */
    readonly url: string;
    /** The website's own `window`: the MAIN world, where `onSite` handlers run. */
    readonly window: Window & typeof globalThis;
    /** The page's document, shared by both worlds. The tweak's mounts are in closed shadow roots: use {@link TestPage.mounts} to reach them. */
    readonly document: Document;
    /** The live `ctx.mount(...)` roots of every script in both worlds, including those inside closed shadow roots. */
    readonly mounts: PageMountSlot[];
    /**
     * The container of the first mount whose anchor matches `selector` (of
     * the first mount when it's omitted); `null` when none.
     *
     * @example
     * const badge = page.mountFor("#cart");
     * expect(badge?.textContent).toBe("3");
     */
    mountFor(selector?: string): HTMLElement | null;
    /** The `<body>` of the first script's overlay frame; `null` when no script ran `tweak.onOverlay` on this page. */
    readonly overlay: HTMLElement | null;
    /**
     * The `<body>` of one script's overlay frame; `null` when it has none.
     * Without `scriptName`, the same as {@link TestPage.overlay}.
     *
     * @throws Error for an unknown script name.
     * @example
     * expect(page.overlayFor("features/hud/index")?.textContent).toContain("HUD");
     */
    overlayFor(scriptName?: string): HTMLElement | null;
    /**
     * This page's live Valtio proxy for a `tweak.siteStore`, the copy in the
     * MAIN world. Changes reach `onPage` and the overlay after a message hop:
     * await {@link TestPage.flush}.
     *
     * Prefer the `tweak` fixture's `store(store, page)`, which takes the
     * imported store.
     *
     * @param name The store's internal name: `"<file>#<n>"`, its file's path
     *   without extension and its position among that file's unnamed stores.
     * @param initial Its value if it doesn't exist yet (default `{}`).
     * @param scriptName The script that owns it (default: the entry script).
     * @throws Error for an unknown script name.
     * @example
     * page.siteStore("features/auth/state#0").loggedIn = true;
     * await page.flush();
     */
    siteStore<T extends Record<string, any> = Record<string, any>>(name: string, initial?: T, scriptName?: string): T;
    /**
     * Moves the document to a later phase (`"document_end"` or
     * `"document_idle"`) and runs the handlers waiting for it. An earlier
     * phase than the current one changes nothing.
     *
     * @example
     * const page = await t.openPage(url, { phase: "document_start" });
     * await page.advanceTo("document_idle");
     */
    advanceTo(phase: DocumentWhen): Promise<void>;
    /**
     * Simulates an in-place SPA navigation: it updates `location.href`,
     * starts and stops the handlers whose route sets `navigation` and then
     * calls `ctx.onNavigate` callbacks. A relative URL resolves against the
     * current one.
     *
     * @example
     * await page.navigate("/settings");
     */
    navigate(nextUrl: string | URL): Promise<void>;
    /**
     * Simulates saving the tweak while the page is open: the scripts re-run
     * as a hot reload (`autoRestore`, `ctx.patch`, Fast Refresh), not a page
     * reload.
     *
     * @example
     * await page.reload();
     */
    reload(): Promise<void>;
    /**
     * Dispatches a `keydown` for a shortcut combo (e.g. `"Mod+Shift+K"` or
     * `"Alt+P"`) to test `ctx.shortcut(...)`.
     *
     * @param target Where to dispatch it (default: the focused element, else `<body>`).
     * @returns Whether something handled it (the event was cancelled).
     * @example
     * expect(await page.pressKey("Alt+Shift+P")).toBe(true);
     */
    pressKey(combo: string, target?: EventTarget): Promise<boolean>;
    /**
     * Lets microtasks, timers, store sync hops, RPC calls and React renders
     * settle, by yielding to the event loop a fixed number of times.
     *
     * @example
     * button.click();
     * await page.flush();
     */
    flush(): Promise<void>;
    /**
     * Closes the tab. It stops all handlers (undoing their `ctx.patch`es),
     * unmounts React roots and closes the overlays and the window. Then it
     * drops the page's `pageStore`s. Calling it again does nothing.
     *
     * @example
     * await page.close();
     */
    close(): Promise<void>;
    /** Closes the page ({@link TestPage.close}) at the end of an `await using` block. */
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Which store a `tweak.globalStore` / `tabStore` / `pageStore` /
 * `siteStore` call made: a global store's id; otherwise its file (the bundle path
 * without extension) and its position among that file's unnamed stores.
 *
 * Plain Vitest imports of the tweak record it on each store they make, so
 * fixture tests can find their own copy of an imported store: the loader
 * names an unnamed store `"<file>#<n>"`.
 */
export type StoreIdentity =
    | {
          /** A `tweak.globalStore`. */
          kind: "globalStore";
          /** The id it was declared with. */
          id: string;
      }
    | {
          /** Which unnamed kind of store it is. */
          kind: "tabStore" | "pageStore" | "siteStore";
          /** The declaring file's path in the tweak, without extension (`"features/palette/state"`). */
          file: string;
          /** Its 0-based position among that file's `tabStore` / `pageStore` / `siteStore` calls, counted together. */
          n: number;
      };

/**
 * The key under which a {@link LoadedTweak} carries its {@link LoaderAccess}
 * (a non-enumerable property). Internal to `"tangitweak/test"`: the fixtures
 * use it to find a test's copy of an imported store.
 */
export const LOADER = Symbol.for("tangitweak.loader");
/** What the fixtures read off a {@link LoadedTweak} through {@link LOADER}. Not public API. */
export interface LoaderAccess {
    /**
     * This copy's store for `id`: on `page`, that tab's copy (the isolated
     * world's; the MAIN world's for a `siteStore`); otherwise the background's (tab
     * `1`, page `"tab:1"`).
     *
     * @throws Error when `page` is closed or for a `siteStore` without a page.
     */
    store(id: StoreIdentity, initial: object, page?: TestPage): object;
}

/**
 * A tweak loaded by {@link loadTweak}: its compiled scripts and background
 * side (network handlers, stores, storage, params), with
 * {@link LoadedTweak.simulate} for requests and {@link LoadedTweak.openPage}
 * for tabs. Dispose it when the test ends (`await using`, or
 * {@link LoadedTweak.dispose}).
 *
 * @example
 * await using t = await loadTweak("../");
 * expect(t.errors).toEqual([]);
 * const page = await t.openPage("https://app.example.com/");
 * expect((await t.simulate("https://ads.example.com/x")).blocked).toBe(true);
 */
export interface LoadedTweak {
    /** The tweak's parsed `package.json`; `undefined` for an inline tweak without one. */
    readonly manifest?: Manifest;
    /** The same object as {@link LoadedTweak.manifest}, typed as its package metadata. */
    readonly metadata?: PackageMetadata;
    /** What the entry scripts use (URL patterns, strategies, `onSite` code, overlays) and the `package.json`'s `connect` hosts and npm dependencies. */
    readonly capabilities: Capabilities;
    /** The entry scripts, from the latest compile. */
    readonly scripts: LoadedScriptInfo[];
    /** The module exports of the first entry script. */
    readonly exports: any;
    /**
     * The declarativeNetRequest rules the `strategy: "rules"` handlers
     * generate, after Chrome's checks (RE2, size, counts). They're
     * re-generated on each {@link LoadedTweak.simulate}, against the current
     * stores and params.
     */
    readonly rules: RuleSpec[];
    /**
     * The problems that break the tweak, most prefixed with the script name:
     * compile errors, `onSite` problems and rejected rules. Only non-empty
     * with {@link LoadTweakOptions.allowCompileErrors}: otherwise
     * {@link loadTweak} throws.
     */
    readonly errors: string[];
    /**
     * The problems shown as warnings: `rules` handler warnings, rules near
     * Chrome's limits, handlers the browser turns off (with
     * {@link LoadTweakOptions.realLimits}) and page notices, such as a CSP
     * that moved `onSite` to the isolated world.
     */
    readonly warnings: string[];
    /** Everything the tweak logged so far, in order. The array is live: it grows as the tweak logs. */
    readonly logs: TweakLogEntry[];
    /**
     * Each script's `tweak.storage`, read and written directly. Values are
     * copied with `structuredClone` both ways.
     *
     * @example
     * t.storage.set("seen", 3);
     * await t.openPage(url);
     * expect(t.storage.snapshot()).toEqual({ seen: 4 });
     */
    readonly storage: {
        /**
         * A copy of the value at `key` (`undefined` when unset).
         *
         * @param scriptName The script whose storage to read (default: the entry script).
         * @throws Error for an unknown script name.
         */
        get(key: string, scriptName?: string): any;
        /**
         * Stores a copy of `value` at `key`. Scripts read it on their next
         * `tweak.storage.get`.
         *
         * @param scriptName The script whose storage to write (default: the entry script).
         * @throws Error for an unknown script name.
         */
        set(key: string, value: any, scriptName?: string): void;
        /**
         * A copy of all of a script's storage, without the `$store:` keys
         * that hold persisted stores.
         *
         * @param scriptName The script whose storage to read (default: the entry script).
         * @throws Error for an unknown script name.
         */
        snapshot(scriptName?: string): Record<string, any>;
    };
    /**
     * The background's live copy of a `tweak.globalStore`, the one network
     * handlers see. Pages hold their own copies, synced asynchronously.
     *
     * @param name The store's id.
     * @param initial Its value if it doesn't exist yet (default `{}`).
     * @param scriptName The script that owns it (default: the entry script).
     * @throws Error for an unknown script name.
     * @example
     * t.store("state").mocking = false;
     * expect((await t.simulate(API)).replaced).toBe(false);
     */
    store<T extends Record<string, any> = Record<string, any>>(name: string, initial?: T, scriptName?: string): T;
    /**
     * The background's live copy of a tab's `tweak.tabStore`.
     *
     * @param name The store's internal name, `"<file>#<n>"` (see {@link StoreIdentity}).
     * @param tabId The tab (default `1`).
     * @param initial Its value if it doesn't exist yet (default `{}`).
     * @param scriptName The script that owns it (default: the entry script).
     * @throws Error for an unknown script name.
     * @example
     * t.tabStore("features/net/state#0", 2).staging = true;
     */
    tabStore<T extends Record<string, any> = Record<string, any>>(name: string, tabId?: number, initial?: T, scriptName?: string): T;
    /**
     * The background's live copy of a page's `tweak.pageStore`.
     *
     * @param name The store's internal name, `"<file>#<n>"` (see {@link StoreIdentity}).
     * @param pageId The page (default `"tab:1"`, what {@link LoadedTweak.simulate} uses for tab `1`).
     * @param initial Its value if it doesn't exist yet (default `{}`).
     * @param scriptName The script that owns it (default: the entry script).
     * @throws Error for an unknown script name.
     * @example
     * t.pageStore("features/net/state#1").hits = 0;
     */
    pageStore<T extends Record<string, any> = Record<string, any>>(name: string, pageId?: string, initial?: T, scriptName?: string): T;
    /**
     * Changes param values, as the user would in the popup: they're merged
     * into the current ones, every script recompiles and each open page
     * hot-reloads.
     *
     * @param values `{ key: val }` or `{ [scriptName]: { key: val } }` (as {@link LoadTweakOptions.params}).
     * @param scriptName Apply `values` to this script only.
     * @throws Error for an unknown script name or when the recompile has
     *   errors (unless {@link LoadTweakOptions.allowCompileErrors}).
     * @example
     * await t.setParams({ env: "staging" });
     */
    setParams(values: Record<string, any>, scriptName?: string): Promise<void>;
    /**
     * Sends a request through the tweak's network handlers (in the
     * background world) and returns the response the page would get.
     *
     * With {@link LoadTweakOptions.realLimits} (the default) and no
     * {@link SimulateRequestInit.strategy}, it walks the strategies in the
     * extension's order (`page → rules → extension → debugger → helper`), each
     * with the chosen browser's limits. The first block, redirect or
     * replacement stops it; the layers in front of it then run their response
     * handlers. Otherwise every matching handler runs in one chain.
     *
     * @throws Error when the `rules` handlers, re-checked against the current
     *   stores and params, produce rule errors (unless
     *   {@link LoadTweakOptions.allowCompileErrors}).
     * @example
     * const res = await t.simulate("https://api.example.com/flags", {
     *     upstream: { body: { newNav: false } },
     * });
     * expect(res.json()).toEqual({ newNav: true });
     */
    simulate(url: string | URL, init?: SimulateRequestInit): Promise<SimulatedResponse>;
    /**
     * Opens a tab at `url` and runs the tweak's `onSite`, `onPage` and
     * `onOverlay` handlers due in its starting phase, then settles (as
     * {@link TestPage.flush}). Each call opens a new document; see
     * {@link OpenPageOptions.tabId} for which stores pages share.
     *
     * @example
     * await using page = await t.openPage("https://app.example.com/home", { html: `<main></main>` });
     * expect(page.mounts).toHaveLength(1);
     */
    openPage(url: string | URL, options?: OpenPageOptions): Promise<TestPage>;
    /**
     * Closes every open page and the background's store link. Call it when
     * the test ends (or use `await using`).
     *
     * @example
     * afterEach(() => t.dispose());
     */
    dispose(): Promise<void>;
    /** Disposes the tweak ({@link LoadedTweak.dispose}) at the end of an `await using` block. */
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

/**
 * Every package file in a folder and its subfolders, as `/`-separated paths
 * relative to it (each after `prefix`). Skips names starting with `.`,
 * `node_modules` and `__tests__`.
 *
 * Internal to `"tangitweak/test"`: `mount` uses it to find a component's file.
 *
 * @param prefix Prepended to each path (used while recursing).
 */
export async function listDirFiles(dir: string, prefix = ""): Promise<string[]> {
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
    /** the tweak's folder on disk */
    dir?: string;
}

async function loadRawWorkspace(source: TweakSource, opts: LoadTweakOptions): Promise<RawWorkspace> {
    if (typeof source === "object" && !(source instanceof URL)) {
        const files: Record<string, string> = { ...(source.files || {}) };
        if (files["package.json"] && source.code === undefined) {
            const crawled = await crawl("package.json", async (p) => files[p] ?? null);
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
            if (isDataSpec(p)) dataFiles.push({ path: p, text });
            else scripts.push({ id: `s${++idx}`, name: scriptNameOf(p), code: text });
        }
        const manifest = files["package.json"] ? parseManifest(files["package.json"]) : undefined;
        return { manifest, entryNames: [scriptNameOf(entryFile)], scripts, dataFiles };
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
        const picked = pickStart(candidates, abs);
        absEntry = nodePath.resolve(abs, ...picked.split("/"));
    }
    // the tweak's folder: its package.json (or the one next to the file given)
    const rootDir = nodePath.dirname(absEntry);
    const startRel = opts.entry ? "package.json" : nodePath.basename(absEntry);

    const crawled = await crawl(startRel, async (rel) => {
        if (opts.files && rel in opts.files) return opts.files[rel];
        const target = nodePath.resolve(rootDir, ...rel.split("/"));
        const relCheck = nodePath.relative(rootDir, target);
        if (relCheck.startsWith("..") && nodePath.isAbsolute(relCheck)) return null;
        const text = await readDiskPackageFile(target, rel);
        if (rel !== "package.json" || !opts.entry || text === null) return text;
        return JSON.stringify({ ...JSON.parse(text), main: opts.entry.replace(/^\.\//, "") });
    });
    const unmocked = crawled.missing.filter((m) => !opts.mocks || !(m.spec in opts.mocks));
    if (unmocked.length) throw new Error(`missing import "${unmocked[0].spec}" in ${unmocked[0].from}`);
    return { ...crawledToWorkspace(crawled), dir: rootDir };
}

function crawledToWorkspace(crawled: Awaited<ReturnType<typeof crawl>>): RawWorkspace {
    const scripts: { id: string; name: string; code: string }[] = [];
    const dataFiles: { path: string; text: string }[] = [];
    let idx = 0;
    for (const [p, text] of Object.entries(crawled.files)) {
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

/**
 * Whether a Content-Security-Policy lets the page `eval`: its `script-src`
 * directive (else `default-src`) allows `'unsafe-eval'`; also when neither is set.
 * Directive names are case-insensitive and the first of a name counts.
 *
 * {@link LoadedTweak.openPage} uses it for {@link OpenPageOptions.csp}.
 */
export function cspAllowsEval(csp: string): boolean {
    const directives = new Map<string, string[]>();
    for (const part of csp.split(";")) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
    }
    const src = directives.get("script-src") ?? directives.get("default-src");
    return !src || src.includes("'unsafe-eval'");
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

/**
 * Let microtasks, timers, store hops and React renders settle. No `act()`:
 * React's act queue is global; concurrent tests (each with its own
 * copy of the tweak) would overlap in it.
 */
async function flushAsync(turns = 12, _withAct = false): Promise<void> {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
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
 * Loads a tweak (its folder, its `package.json`, a file in it or an inline
 * `{ code, files }` tweak) and runs it as the extension would, for unit and
 * integration tests. The fixtures of `"tangitweak/test"` are built on it.
 *
 * It compiles every script with TangiTweak's compiler, resolves imports
 * (npm packages from the `node_modules` folders above the tweak, never the
 * network; {@link LoadTweakOptions.mocks} first), generates and checks the
 * `rules` handlers' browser rules and starts the background store owner.
 * Pages open with {@link LoadedTweak.openPage}; requests go through the
 * network handlers with {@link LoadedTweak.simulate}. Each call returns an
 * independent copy with its own stores and storage, so tests using separate
 * copies can run concurrently.
 *
 * @param source What to load (see {@link TweakSource}).
 * @throws Error when Node lacks a global `URLPattern` (Node.js 23.8 or later
 *   needed), the source has no script, an import isn't found (and isn't
 *   mocked) or a script has compile, rule or `onSite` errors (unless
 *   {@link LoadTweakOptions.allowCompileErrors}).
 * @example
 * import { expect, it } from "vitest";
 * import { loadTweak } from "tangitweak/test";
 *
 * it("blocks ads", async () => {
 *     await using t = await loadTweak({
 *         code: `import { tweak } from "tangitweak";
 * tweak.onRequest({ url: "*://ads.example.com/*", strategy: "rules" }, () => ({ block: true }));`,
 *     });
 *     expect((await t.simulate("https://ads.example.com/x")).blocked).toBe(true);
 * });
 */
export async function loadTweak(source: TweakSource, options: LoadTweakOptions = {}): Promise<LoadedTweak> {
    if (typeof (globalThis as any).URLPattern === "undefined") {
        throw new Error("tangitweak/test requires global URLPattern (Node.js >= 23.8)");
    }

    const ws = await loadRawWorkspace(source, options);
    const browser: BrowserName = options.browser ?? "chrome";
    const realLimits = options.realLimits !== false;
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

    // Per-script key-value storage (`tweak.storage` + `$store:*` persistence)
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

    const mockObjs = new Map<string, any>();
    for (const [spec, val] of Object.entries(options.mocks ?? {})) mockObjs.set(spec, asCjsExports(val));

    // load the unmocked packages the scripts import by name
    const codesForPkgs = ws.scripts.map((s) => {
        if (!mockObjs.size) return { name: s.name, code: s.code };
        let filtered = s.code;
        for (const spec of mockObjs.keys()) {
            if (!spec.startsWith(".")) for (const q of [`"`, `'`]) filtered = filtered.split(q + spec + q).join(`${q}./__tt_mocked_pkg__${q}`);
        }
        return { name: s.name, code: filtered };
    });
    if (ws.dir) for (const d of nodeModulesAbove(ws.dir)) packageRoots.add(d);
    await ensurePackages(codesForPkgs, { data: ws.dataFiles });
    const basePkgs = packagesSnapshot();
    const pkgs: PackageModules = {
        aliases: { ...basePkgs.aliases },
        modules: { ...basePkgs.modules },
    };
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
    let allScripts: OpScript[] = [];
    let layered: ReturnType<typeof layerScripts> = { scripts: [], refs: [], disabled: [] };
    let currentRules: RuleSpec[] = [];
    let currentRulesByScript = new Map<string, RuleSpec[]>();
    let currentErrors: string[] = [];
    let currentWarnings: string[] = [];
    type OpenPage = TestPage & { _hotUpdate(): Promise<void>; _store(id: StoreIdentity, initial: object): object };
    const openPages = new Set<OpenPage>();

    const knownTabIds = new Set<number>([1]);

    // the tweak's package.json layer (a test has no user setting)
    const layers = { pkg: ws.manifest?.layer };
    let currentRuleGroups: RuleGroupRef[] = [];
    let ruleWarnings: string[] = [];
    // the rules Chrome would take, after its checks (RE2, size, counts: ruleChecks.ts)
    const probeAllRules = async (): Promise<{ rules: RuleSpec[]; byScript: Map<string, RuleSpec[]>; errors: string[] }> => {
        const byScript = new Map<string, RuleSpec[]>();
        const errs: string[] = [];
        const groups: RuleGroupRef[] = [];
        for (const s of entryScripts) {
            byScript.set(s.id, []);
            const c = compiledMap.get(s.id);
            if (!c || c.error) continue;
            const probed = await probeScriptRules(c.handlers, [...knownTabIds]);
            for (const r of probed.rules) groups.push({ scriptId: s.id, scriptName: s.name, route: r.route, specs: r.specs, layer: handlerLayer(r.route, layers).layer });
            for (const err of probed.errors) errs.push(`${s.name}: ${err}`);
        }
        const checked = checkRules(sortByLayer(groups, (g) => g.layer!));
        errs.push(...checked.errors);
        ruleWarnings = checked.warnings;
        currentRuleGroups = checked.accepted as RuleGroupRef[];
        for (const g of currentRuleGroups) byScript.get(g.scriptId)!.push(...g.specs);
        return { rules: currentRuleGroups.flatMap((g) => g.specs), byScript, errors: errs };
    };

    // network handlers' world, like the extension's background page: kept across recompiles
    const bgScope = backgroundScope();
    const compileAll = () => inScope(bgScope, compileInScope);
    const compileInScope = async () => {
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
        warns.push(...ruleWarnings);
        allScripts = entryScripts
            .map((s) => ({ id: s.id, name: s.name, handlers: compiledMap.get(s.id)!.handlers, layers }))
            .filter((s) => Boolean(s.handlers));
        layered = layerScripts(allScripts, browser, (s, route) =>
            logSink(s.name, "error", "", `async ${routeLabel(route)}: Chrome's blocking webRequest cannot await. Return synchronously, or set strategy: "debugger" or "helper" on this route.`)
        );
        if (realLimits) for (const d of layered.disabled) warns.push(`${d.ref.scriptName}: ${routeLabel(d.ref.route)}: ${d.why}`);
        opScripts = realLimits ? layered.scripts : allScripts;
        currentErrors = errs;
        currentWarnings = warns;

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

    // problems found while opening pages (a page's CSP)
    const pageWarnings = new Set<string>();
    // tabs that loaded a document already (the debugger strategy may miss a new tab's first one)
    const docTabs = new Set<number>();

    async function simulate(urlInput: string | URL, init: SimulateRequestInit = {}): Promise<SimulatedResponse> {
        const url = String(urlInput);
        const method = (init.method || "GET").toUpperCase();
        const tabId = init.tabId ?? 1;
        knownTabIds.add(tabId);
        const page = init.pageId ?? `tab:${tabId}`;
        const resourceType = webRequestType(init.resourceType);
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
            redirectedTo: string | null = null,
            skipped: SkippedHandler[] = [],
            decidedBy: DecidedBy | null = null
        ): SimulatedResponse => ({
            action,
            skipped,
            decidedBy,
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

        // the fake server (`upstream`, else `options.fetch`, else an empty 200)
        const upstream = async (headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: string | Uint8Array }> => {
            const upReqBody =
                serializedReq.raw === undefined
                    ? undefined
                    : (() => {
                          const rawBytes = typeof serializedReq.raw === "string" ? utf8Enc.encode(serializedReq.raw) : serializedReq.raw;
                          const textVal = typeof serializedReq.raw === "string" ? serializedReq.raw : utf8Dec.decode(serializedReq.raw);
                          return {
                              raw: rawBytes,
                              text: textVal,
                              contentType: headers["content-type"],
                              json: <T = any>() => JSON.parse(textVal) as T,
                              formData: () => new URLSearchParams(textVal),
                          };
                      })();
            const upSpec =
                typeof init.upstream === "function"
                    ? await init.upstream({ url, method, headers: { ...headers }, body: upReqBody, resourceType, tabId, tabUrl })
                    : init.upstream;
            if (upSpec instanceof Response) {
                return { status: upSpec.status, headers: normalizeHeaders(upSpec.headers), body: new Uint8Array(await upSpec.arrayBuffer()) };
            }
            if (upSpec) {
                const upHeaders = normalizeHeaders(upSpec.headers);
                if (upSpec.contentType && !upHeaders["content-type"]) upHeaders["content-type"] = upSpec.contentType;
                const ser = serializeBody(upSpec.body, upHeaders["content-type"]);
                if (ser.contentType && !upHeaders["content-type"]) upHeaders["content-type"] = ser.contentType;
                return { status: upSpec.status ?? 200, headers: upHeaders, body: ser.raw ?? "" };
            }
            if (options.fetch) {
                const res = await options.fetch(url, {
                    method,
                    headers,
                    body: serializedReq.raw !== undefined && method !== "GET" && method !== "HEAD" ? (serializedReq.raw as BodyInit) : undefined,
                });
                return { status: res.status, headers: normalizeHeaders(res.headers), body: new Uint8Array(await res.arrayBuffer()) };
            }
            return { status: 200, headers: {}, body: "" };
        };

        if (realLimits && !init.strategy) {
            const firstDocument = resourceType === "main_frame" && !docTabs.has(tabId);
            if (resourceType === "main_frame") docTabs.add(tabId);
            const r = await requestThroughLayers(
                { browser, scripts: opScripts, refs: layered.refs, disabled: layered.disabled, rules: currentRuleGroups, opEnv, upstream },
                { url, method, tabId, page, tabUrl, resourceType, requestHeaders: reqHeaders, requestBody, firstDocument }
            );
            return makeResult(r.action, r.status, r.headers, r.body, r.requestHeaders, r.redirectedTo, r.skipped, r.decidedBy);
        }

        // one chain: every matching handler (of `init.strategy`, when given), whatever its strategy
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

        const up = await upstream(effectiveReqHeaders);
        const upStatus = up.status;
        const upHeaders = up.headers;
        const upRaw = up.body;

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
        let currentUrl = new URL(String(urlInput), "https://localhost/").href;
        // each tab its own document, like a browser tab
        const happy = new HappyWindow({ url: currentUrl, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
        const win = happy as unknown as Window & typeof globalThis;
        const doc = win.document;
        let currentPhase: DocumentWhen = pageOpts.phase ?? "document_end";
        const tabId = pageOpts.tabId ?? 1;
        knownTabIds.add(tabId);
        const pageId = `${tabId}.0.p_${Math.random().toString(36).slice(2, 8)}`;
        const useShadow = pageOpts.shadow !== false;

        setWindowUrl(win, currentUrl);
        if (pageOpts.html !== undefined) {
            doc.body.innerHTML = pageOpts.html;
        }

        // Intercept page fetch through `simulate()` so UI + API rewrites test together seamlessly
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
        }

        // the tab's worlds: one DOM, separate JavaScript globals (§6.7 of the plan)
        const siteScope = pageScope(win, { label: "site" });
        const isoScope = windowScope(win, { label: "iso" });
        pageOpts.setup?.(win);
        // MV2/Firefox inject onSite with eval: a page CSP without 'unsafe-eval' sends it to the isolated world (hook.ts)
        const cspNoEval = browser !== "chrome" && pageOpts.csp !== undefined && !cspAllowsEval(pageOpts.csp);
        if (cspNoEval && entryScripts.some((s) => (compiledMap.get(s.id)?.meta.routes || []).some((r) => r.kind === "onDocument" && pageWorld(r) === "page"))) {
            const line = "page CSP blocks eval in the page world — running onSite handlers in the isolated world instead";
            logSink(primaryScript.name, "info", "", line);
            pageWarnings.add(line);
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
            /** handlers with `navigation` (and ctx.onNavigate), per world */
            siteNavs: NavRoutes<PageDocumentHandler>;
            isoNavs: NavRoutes<PageDocumentHandler>;
            overlay?: {
                rt: OverlayRuntime;
                bridge: ReturnType<typeof endpointPair>[1];
                hostEl: HTMLElement;
                doc: Document;
                win: Window & typeof globalThis;
                scope: ScriptScope;
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
                siteNavs: new NavRoutes(() => {}),
                isoNavs: new NavRoutes(() => {}),
            });
        }

        /** `navigation` runs waiting for a later phase */
        let waiting: { when: DocumentWhen; run: () => void }[] = [];
        const scheduleNav = (when: DocumentWhen, run: () => void, now: boolean) => (now || phaseRank(when) <= phaseRank(currentPhase) ? run() : waiting.push({ when, run }));
        const fireSite = (st: ScriptWorldState, g: Generation, d: PageDocumentHandler, url: string) => {
            const report = (e: unknown) => logSink(st.script.name, "error", "onSite", formatScriptError(st.script.name, e, "onSite"));
            fireRun(st.siteLife, g, d, (signal) => ({ ...pageCtxBase(url), onNavigate: st.siteNavs.onNavigate(signal, report) }), st.siteExposer, report);
        };
        const fireIso = (st: ScriptWorldState, g: Generation, d: PageDocumentHandler, url: string) => {
            const report = (e: unknown) => logSink(st.script.name, "error", "onPage", formatScriptError(st.script.name, e, "onPage"));
            fireRun(
                st.isoLife,
                g,
                d,
                (signal) => ({
                    ...pageCtxBase(url),
                    shortcut: (combo: string, fn: () => unknown, opts?: any) => addPageShortcut(st.script.id, combo, fn, opts, signal),
                    onNavigate: st.isoNavs.onNavigate(signal, report),
                }),
                st.isoExposer,
                report
            );
        };

        const fireDueForState = (st: ScriptWorldState, hot: boolean) => {
            if (st.siteGen) {
                for (const d of st.sitePending) {
                    if (!hot && phaseRank(d.when) > phaseRank(currentPhase)) continue;
                    if (st.siteRan.has(d.h)) continue;
                    st.siteRan.add(d.h);
                    fireSite(st, st.siteGen, d, currentUrl);
                }
            }
            if (st.isoGen) {
                for (const d of st.isoPending) {
                    if (!hot && phaseRank(d.when) > phaseRank(currentPhase)) continue;
                    if (st.isoRan.has(d.h)) continue;
                    st.isoRan.add(d.h);
                    fireIso(st, st.isoGen, d, currentUrl);
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

                let siteNavSet: PageDocumentHandler[] | null = null;
                let isoNavSet: PageDocumentHandler[] | null = null;
                // 1. Site world (`tweak.onSite`)
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
                    const shim = makeSiteShim(undefined, undefined, true);
                    inScope(cspNoEval ? isoScope : siteScope, () => {
                        const requireFrom = makeLibRequire(libs, (lib, req, mod) => scriptFunction(lib.src!, lib.name)(shim.host, consoleSite, wrapReq(req), mod, mod.exports), { builtin: siteBuiltin, onSite: true });
                        const mod = { exports: {} as any };
                        shim.top(() => scriptFunction(src, s.name)(shim.host, consoleSite, wrapReq(requireFrom(s.name)), mod, mod.exports));
                    });
                    st.sitePending = domHandlersFor(shim.dom, currentUrl, st.siteExposer).filter((d) => !followsNav(d.route));
                    st.siteExposer.done();
                    st.siteGen = g;
                    st.siteRan.clear();
                    siteNavSet = shim.dom;
                }

                // 2. Overlay frame (`tweak.onOverlay`)
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
                        // the overlay's frame: its own window, document and globals
                        const ovWin = new HappyWindow({ url: "about:blank" }) as unknown as Window & typeof globalThis;
                        const ovDoc = ovWin.document;
                        ovDoc.title = `tt-overlay-${s.name}`;
                        const ovScope = windowScope(ovWin, { label: "overlay" });

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

                        const rt = await inScope(ovScope, () =>
                            startOverlay(frameEp, ovInit, {
                                win: ovWin,
                                doc: ovDoc,
                                patchFetch: false,
                                watchRects: false,
                                trustedKey: () => true,
                                hotKey: `${s.name}\u0000${pageId}`,
                            })
                        );
                        st.overlay = { rt, bridge: bridgeEp, hostEl, doc: ovDoc, win: ovWin, scope: ovScope, onSiteDown, shortcutIds };
                    } else if (hot) {
                        const ov = st.overlay;
                        inScope(ov.scope, () => ov.bridge.push("overlay.update", ovInit));
                    }
                }

                // 3. Isolated world (`tweak.onPage`)
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
                    const shim = makeIsoShim(s.id, s.name, resolvedParams, true);
                    const requireFrom = inScope(isoScope, () => {
                        const req = makeLibRequire(
                            libs,
                            (lib, r, mod) => scriptFunction(lib.src!, lib.name)(shim.host, consoleIso, wrapReq(r), mod, mod.exports),
                            { builtin: scriptBuiltin(codeOf, hotRegistry(`${s.name}\u0000${pageId}`).begin()) }
                        );
                        const mod = { exports: {} as any };
                        shim.top(() => scriptFunction(src, s.name)(shim.host, consoleIso, wrapReq(req(s.name)), mod, mod.exports));
                        return req;
                    });
                    st.setIsoReact(() => {
                        try {
                            return reactOf(wrapReq(requireFrom(s.name)));
                        } catch {
                            return { createRoot: ReactDOMClient.createRoot };
                        }
                    });
                    st.isoPending = domHandlersFor(shim.dom, currentUrl, st.isoExposer).filter((d) => !followsNav(d.route));
                    st.isoExposer.done();
                    st.isoGen = g;
                    st.isoRan.clear();
                    isoNavSet = shim.dom;
                }

                fireDueForState(st, hot);
                const navSet = (navs: NavRoutes<PageDocumentHandler>, dom: PageDocumentHandler[], life: ScriptLife, exposer: Exposer, fire: (d: PageDocumentHandler, url: string) => void) =>
                    navs.set({ dom, url: currentUrl, now: hot, fire, stop: (d) => life.stopRun(d.h, "the page navigated away"), exposer, schedule: scheduleNav });
                const siteG = st.siteGen;
                const isoG = st.isoGen;
                if (siteNavSet && siteG) navSet(st.siteNavs, siteNavSet, st.siteLife, st.siteExposer, (d, url) => fireSite(st, siteG, d, url));
                if (isoNavSet && isoG) navSet(st.isoNavs, isoNavSet, st.isoLife, st.isoExposer, (d, url) => fireIso(st, isoG, d, url));
                if (st.siteGen) st.siteLife.commit(st.siteGen);
                if (st.isoGen) st.isoLife.commit(st.isoGen);
            }
            await flushAsync(12, true);
        };

        await runScriptsOnPage(false);

        let closed = false;
        const pageObj: OpenPage = {
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
                const due = waiting.filter((w) => phaseRank(w.when) <= phaseRank(currentPhase));
                waiting = waiting.filter((w) => phaseRank(w.when) > phaseRank(currentPhase));
                for (const w of due) w.run();
                await flushAsync(12, true);
            },
            async navigate(nextUrl: string | URL): Promise<void> {
                currentUrl = new URL(String(nextUrl), currentUrl).href;
                setWindowUrl(win, currentUrl);
                for (const st of states.values()) {
                    st.siteNavs.nav(currentUrl);
                    st.isoNavs.nav(currentUrl);
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
            _store(id: StoreIdentity, initial: object): object {
                const owner = primaryScript.id;
                if (id.kind === "globalStore") return isoHub.store(owner, id.id, initial, false);
                const name = `${id.file}#${id.n}`;
                if (id.kind === "tabStore") return isoHub.tabStore(owner, name, initial, tabScopeOfPage(pageId));
                if (id.kind === "pageStore") return isoHub.pageStore(owner, name, initial, pageId);
                return siteHost.store(owner, name, initial);
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
                        await (st.overlay.win as any).happyDOM.close();
                    }
                }
                isoClientEp.close("page closed");
                isoOwnerEp.close("page closed");
                owner.dropPage(pageId);
                await flushAsync(4, false);
                await happy.happyDOM.close();
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
        metadata: ws.manifest,
        get capabilities() {
            const routes = entryScripts.flatMap((s) => compiledMap.get(s.id)?.meta.routes || []);
            return capabilitiesOf(
                routes,
                ws.manifest?.connect || [],
                ws.manifest?.dependencies
            );
        },
        get scripts() {
            return entryScripts.map((s) => {
                const c = compiledMap.get(s.id)!;
                return {
                    id: s.id,
                    name: s.name,
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
            return [...currentWarnings, ...pageWarnings];
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
        },
        async [Symbol.asyncDispose](): Promise<void> {
            await tweak.dispose();
        },
    };
    const access: LoaderAccess = {
        store(id, initial, page) {
            if (page) {
                const open = [...openPages].find((p) => p === page);
                if (!open) throw new Error("tweak.store(store, page): that page is closed");
                return open._store(id, initial);
            }
            const owner = primaryScript.id;
            if (id.kind === "globalStore") return bgHub.store(owner, id.id, initial, false);
            const name = `${id.file}#${id.n}`;
            if (id.kind === "tabStore") return bgHub.tabStore(owner, name, initial, tabScope(1));
            if (id.kind === "pageStore") return bgHub.pageStore(owner, name, initial, "tab:1");
            throw new Error("a siteStore lives in a page: pass the page (tweak.store(store, page))");
        },
    };
    Object.defineProperty(tweak, LOADER, { value: access });

    return tweak;
}
