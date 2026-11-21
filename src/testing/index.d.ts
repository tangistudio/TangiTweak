/**
 * `@tangitweak/test` — automated testing harness for TangiTweak scripts and bundles.
 *
 * Synced automatically into `.tangitweak/test/` by Folder Sync and published on
 * GitHub Releases as `tangitweak-test.tgz` for CI.
 */

export type Strategy = "rules" | "page" | "debugger" | "helper" | "extension";
export type DocumentWhen = "document_start" | "document_end" | "document_idle";

export interface InlineTweakSource {
    /** Entry script TypeScript / TSX source code (optional when `files["metadata.json"]` is provided). */
    code?: string;
    /** Entry script name or path (defaults to `"script"`). */
    name?: string;
    /** Companion scripts, `metadata.json`, or data files (`path -> content`). */
    files?: Record<string, string>;
}

export type TweakSource = string | URL | InlineTweakSource;

export interface LoadTweakOptions {
    /** Base directory for resolving relative string paths (defaults to caller file directory or `process.cwd()`). */
    cwd?: string;
    /** Override `tweak.params` defaults (`{ key: val }` or `{ [scriptName]: { key: val } }`). */
    params?: Record<string, any>;
    /** Seed `tweak.storage` values (`{ key: val }` or `{ [scriptName]: { key: val } }`). */
    storage?: Record<string, any>;
    /** Seed `tweak.globalStore` values by store name (`{ storeName: { ... } }`). */
    stores?: Record<string, Record<string, any>>;
    /** Mock imported modules or URL packages (`{ "https://unpkg.com/...": mockExports, "./lib": mockExports }`). */
    mocks?: Record<string, any>;
    /** Custom upstream `fetch` used by `tweak.fetch` and as fallback upstream in `simulate()`. */
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

export interface RuleSpec {
    condition: {
        urlFilter?: string;
        regexFilter?: string;
        isUrlFilterCaseSensitive?: boolean;
        requestDomains?: string[];
        initiatorDomains?: string[];
        requestMethods?: string[];
        resourceTypes?: string[];
        tabIds?: number[];
    };
    action: {
        type: "block" | "redirect" | "modifyHeaders";
        redirect?: { url?: string; regexSubstitution?: string };
        requestHeaders?: { header: string; operation: "set" | "remove"; value?: string }[];
        responseHeaders?: { header: string; operation: "set" | "remove"; value?: string }[];
    };
}

export interface TweakCapabilities {
    urls: string[];
    strategies: string[];
    pageJs: boolean;
    overlay: boolean;
    connect: string[];
    packages: string[];
}

export interface LoadedScriptInfo {
    id: string;
    name: string;
    paramDefs?: Record<string, any>;
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
    /** Tab ID used for `tweak.tabStore` and network simulation (default `1`). */
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
    /** Primary overlay frame `<body>`, or `null` when no script ran `tweak.onOverlay` on this page. */
    readonly overlay: HTMLElement | null;
    /** Overlay frame `<body>` for a specific script name, or `null`. */
    overlayFor(scriptName?: string): HTMLElement | null;
    /** Live Valtio proxy for `tweak.siteStore(name)` in the page world. */
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
    readonly manifest?: Record<string, any>;
    readonly metadata?: Record<string, any>;
    readonly capabilities: TweakCapabilities;
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

/**
 * Load a TangiTweak script file (`"./dark.ts"`), bundle (`"./metadata.json"` or folder),
 * or inline `{ code, files }` definition for unit and DOM/React testing.
 */
export declare function loadTweak(source: TweakSource, options?: LoadTweakOptions): Promise<LoadedTweak>;
