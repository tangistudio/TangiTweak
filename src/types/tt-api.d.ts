/**
 * The public API of a tweak script: the `tweak` object scripts get with
 * `import { tweak } from "tangitweak"`, the `ctx` each handler receives and
 * every type they mention.
 *
 * The same file is used in two places: the Editor loads it as an extra lib
 * (its hovers, completions and Go to Definition, which shows it read-only),
 * the SDK package `tangitweak` ships it as its `index.d.ts` (written by
 * Folder Sync to `.tangitweak/sdk/tangitweak/`, so VS Code and `tsc` type a
 * synced folder). Declarations here are ambient: nothing is imported.
 *
 * How it fits together:
 * - `namespace TangiTweak` (first block): the shapes handlers see and
 *   return. Network handlers get a {@link TangiTweak.RequestCtx} and name a
 *   {@link TangiTweak.Strategy} in their {@link TangiTweak.RouteOptions};
 *   page code gets a {@link TangiTweak.PageCtx},
 *   {@link TangiTweak.SiteCtx} or {@link TangiTweak.OverlayCtx} depending on
 *   its world; then stores, `tweak.fetch` options, package metadata and
 *   params.
 * - `namespace TangiTweak` (second block): {@link TangiTweak.Tweak}, the
 *   type of `tweak` itself, with every registration function.
 * - `declare module "tangitweak"`: the `tweak` export.
 * - `declare module "*.svg"` and the like: what importing a data file gives.
 *
 * Code runs in one of four places: network handlers in the extension's
 * background; `tweak.onSite` in the site's own JavaScript world
 * (untrusted); `tweak.onPage` in an isolated world next to it; and
 * `tweak.onOverlay` in the script's own frame over the page.
 *
 * The Editor's API links (src/ui/apiLinks.ts) look declarations up here by
 * their qualified names, so renaming or moving one breaks them.
 *
 * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md
 * @module
 */

/**
 * The types of the `tweak` API: what handlers receive (`ctx`), what they
 * return, their routes and options, stores, params and package metadata.
 * Scripts use them as `TangiTweak.PageCtx` and the like, with no import.
 */
declare namespace TangiTweak {
    /** A value, or a Promise of it: every handler may be async. */
    type Awaitable<T> = T | Promise<T>;

    /** One response header as received from the network. */
    interface HeaderPair {
        /** Header name, in the server's casing. */
        name: string;
        /** Header value (absent for valueless headers). */
        value?: string;
    }

    /** What every handler learns about the request. */
    interface RequestCtx {
        /** Full request URL, e.g. `"https://api.example.com/v1/user?id=1"`. */
        url: string;
        /** HTTP method in upper case: `"GET"`, `"POST"`, … */
        method: string;
        /** URL of the top-level document that initiated the request. */
        tabUrl: string;
        /**
         * webRequest resource type: `"main_frame"`, `"sub_frame"`,
         * `"script"`, `"stylesheet"`, `"image"`, `"xmlhttprequest"`, …
         */
        resourceType: string;
        /**
         * Request headers as a plain object (`name → value`). In `onRequest`
         * they include the edits of the handlers that ran before this one.
         */
        requestHeaders: { [name: string]: string };
        /**
         * Named groups the handler's route captured from `url` (`:id`, and
         * `"0"`, `"1"`… for `*` wildcards). `{}` when nothing was captured.
         *
         * @example
         * tweak.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
         *     if (ctx.groups.id === "42") return { replaceResponse: { body: { id: 42 } } };
         * });
         */
        groups: { [name: string]: string };
        /**
         * The request payload, read-only (changing it has no effect).
         * Text or binary is decided like response bodies: by the request's
         * `Content-Type` against `settings.textTypes`: text arrives as a
         * UTF-8 string, binary (incl. multipart `FormData`) as a `Uint8Array`.
         * `undefined` when there is no body (GET…), it is over 8 MB, or the
         * strategy can't get it:
         *
         * - `page`: fetch/XHR bodies; a `ReadableStream` body → `undefined`.
         * - `debugger`: the paused request's post data; uploads with a file
         *   part → `undefined`.
         * - `helper`: needs helper 0.4.1+; a streaming upload that stalls
         *   for 2 s → `undefined` (it is passed on untouched).
         * - `extension`: from webRequest; the kind is sniffed (no
         *   `Content-Type` that early), a form post arrives URL-encoded, and
         *   Chromium omits file and very large uploads → `undefined`.
         * - `rules`: no request; reading it is an error.
         *
         * @example
         * tweak.onRequest({ url: "https://api.example.com/*", methods: ["POST"], strategy: "helper" }, (ctx) => {
         *     if (typeof ctx.requestBody === "string" && ctx.requestBody.includes("debug=1")) return { block: true };
         * });
         */
        requestBody?: string | Uint8Array;
        /**
         * Parses the **request** body (`ctx.requestBody`, bytes decoded as
         * UTF-8) as JSON. `undefined` when there is no body; throws when it
         * isn't valid JSON. Not the response: `onResponseBody` gets that as
         * its second argument.
         *
         * @example
         * tweak.onRequest({ url: "https://api.example.com/graphql", strategy: "helper" }, (ctx) => {
         *     const q = ctx.json<{ operationName?: string }>();
         *     if (q?.operationName === "GetFlags") return { replaceResponse: { body: { flags: { beta: true } } } };
         * });
         */
        json<T = any>(): T | undefined;
    }

    /**
     * Interception strategy that runs a handler. Every network handler
     * names exactly **one** in its route's required `strategy`. There is no
     * default and no fallback: when the strategy isn't available, the
     * handler doesn't run and the Log view says why.
     *
     * - `"helper"`: the local tangitweak-helper (a proxy). Sees every
     *   request incl. documents, scripts and service workers; no banner.
     *   Needs the helper installed. Chromium only.
     * - `"page"`: patches the page's own `fetch`/XHR. Lightest (no banner,
     *   no helper) but sees **only** page fetch/XHR (`"xmlhttprequest"`):
     *   no documents, `<script src>`, images or worker requests, and no
     *   `onResponseHeaders`.
     * - `"extension"`: the extension handles each request (blocking
     *   webRequest). Firefox (reads bodies) and MV2
     *   Chromium (no `onResponseBody`, sync handlers only). On Chromium the
     *   page itself (`main_frame`) can be redirected and its headers changed,
     *   but a replaced page is served from a `chrome-extension://` URL (use
     *   `"helper"` or `"debugger"` to rewrite or replace the page in place).
     * - `"debugger"`: the Chrome debugger. Sees everything; Chrome shows a
     *   "started debugging this browser" banner while attached. Chromium only.
     * - `"rules"`: browser-native rules (declarativeNetRequest): the browser
     *   itself blocks, redirects or sets/removes request and response
     *   headers, on every request; no banner, no helper. The handler runs
     *   **once** when scripts load and must return the same result for every
     *   request: it may use `ctx.groups.*` and `ctx.url` only as-is inside a
     *   redirect URL, and may not read anything else from `ctx`. No
     *   `replaceResponse` result, `onResponseBody` or `exclude`. A handler
     *   that can't become a rule doesn't run, and its script shows an error.
     *   Chrome (MV3 and MV2) and Firefox.
     *
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/strategies.md#compatibility
     */
    type Strategy = "helper" | "page" | "extension" | "debugger" | "rules";

    /** webRequest resource type names (also `ctx.resourceType`). */
    type ResourceType =
        | "main_frame"
        | "sub_frame"
        | "stylesheet"
        | "script"
        | "image"
        | "font"
        | "object"
        | "xmlhttprequest"
        | "ping"
        | "csp_report"
        | "media"
        | "websocket"
        | "other";

    /**
     * One or more [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)
     * strings: `*` is a wildcard within a URL part, `:name` a named segment
     * (→ `ctx.groups.name`), and an omitted query or hash matches any. An
     * omitted port means the default port only (write `:*` for any).
     * `"<all_urls>"` matches every URL. An empty list matches **nothing**.
     * An invalid URL pattern makes the registration throw.
     *
     * @example "*://example.com/*"
     * @example ["https://*.example.com/api/v1/*", "https://cdn.example.com/static/*.js"]
     */
    type UrlPatterns = string | string[];

    /**
     * Where a network handler (`onRequest`, `onResponseHeaders`, `onResponseBody`)
     * applies and which {@link Strategy} runs it. A bare URL pattern isn't accepted: it names no strategy.
     */
    interface RouteOptions {
        /** URLs this handler applies to. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /**
         * URLs to skip even when `url` matches (same syntax).
         *
         * Cheap: one extra URL pattern test, only on URLs that already matched
         * `url`. It filters correctly on every strategy but can't narrow
         * what `debugger`/`helper` pause, so an excluded URL may still be paused
         * there and then continued unchanged.
         *
         * @example { url: "*://example.com/*", exclude: ["*://example.com/*.png", "*://example.com/health"] }
         */
        exclude?: UrlPatterns;
        /**
         * Only these HTTP methods (case-insensitive). Omit for any.
         *
         * @example { url: "*://api.example.com/*", methods: ["POST", "PUT"] }
         */
        methods?: string[];
        /**
         * Only handle these resource types (webRequest names, also seen as
         * `ctx.resourceType`). Omit to handle every type.
         *
         * How much this saves depends on the strategy:
         * - `debugger`: the debugger only pauses these types (`Fetch.enable`
         *   patterns), so other requests are never stopped: the cheapest
         *   way to keep a route off images, fonts and other assets.
         * - `extension`: checked in the listener before any script runs.
         * - `helper`: checked after the helper pauses the request, so it
         *   filters correctly but saves no work.
         * - `page`: only sees page fetch/XHR (`"xmlhttprequest"`); any list
         *   without it means the handler never runs (the Log view warns).
         *
         * @example { url: "https://app.example.com/*", resourceTypes: ["main_frame"] } // navigations only
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/strategies.md#compatibility
         */
        resourceTypes?: ResourceType[];
        /**
         * The strategy that runs this handler. Required: there is no
         * default. A single value, no fallback. See {@link Strategy}.
         *
         * @example { url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "debugger" }
         * @example { url: "*://ads.example.com/*", strategy: tweak.isMV3 ? "rules" : "extension" }
         */
        strategy: Strategy;
        /**
         * Where this handler sits in the stack of its stage. Handlers run
         * `"base"` first and `"override"` last, and the last word wins:
         * a later `block`, `redirect`, `replaceResponse` or `allow`
         * overrules an earlier one, a later header edit wins per header and
         * a later body handler shapes the body the page gets. Within a
         * layer, the script list order decides, then registration order.
         *
         * Unset: the tweak's package.json `tangitweak.layer`, else
         * inferred from the hosts: `"base"` when a url pattern can match
         * any host (`"<all_urls>"`), `"site"` for named hosts. The user's
         * layer setting for the tweak overrides both this and package.json.
         *
         * Layers order handlers within one strategy only: strategies still
         * run page, rules, extension, debugger, helper. On `rules` the
         * layer becomes the rule's priority.
         *
         * @example { url: "<all_urls>", resourceTypes: ["xmlhttprequest"], strategy: "helper", layer: "override" } // a broad block that must win
         */
        layer?: "base" | "site" | "override";
    }

    /** Full route form for `tweak.onResponseBody`. */
    interface BodyRouteOptions extends RouteOptions {
        /**
         * Which bodies the handler gets. Which Content-Types are text is set
         * by `settings.textTypes`.
         * - unset: text only (a string); a binary body it misses is warned
         *   about in the Log view
         * - `false`: text only, without that warning
         * - `true`: binary only (images, video, …), as a `Uint8Array`
         * - `"both"`: text as a string and binary as a `Uint8Array`
         *
         * Binary bodies are buffered whole and the response waits for the
         * handler: keep these routes narrow.
         *
         * @example { url: "*://cdn.example.com/*.png", binary: true }
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#binary-bodies
         */
        binary?: boolean | "both";
    }

    /** Route fields shared by `tweak.onSite`, `tweak.onPage` and `tweak.onOverlay`. */
    interface DocumentRouteOptions extends DocumentOptions {
        /** Frame URLs (top page and iframes) to run in. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /** Frame URLs to skip even when `url` matches. */
        exclude?: UrlPatterns;
        /**
         * What happens when a single-page app changes the URL in place
         * (history API, back/forward, `#hash`), without loading a new page.
         * - unset / `"load"`: matched once, against the URL the page
         *   loaded with; in-place URL changes don't start or stop it
         * - `"match"`: runs while the URL matches. It starts when the URL
         *   starts matching (at its `when`, or right away if that has
         *   passed) and ends when the URL stops matching: `ctx.signal`
         *   aborts and what the run set up is undone
         * - `"every"`: like `"match"`, and also runs again on each URL
         *   change while the URL still matches
         *
         * @example
         * // only on pull request pages, however you got there
         * tweak.onPage({ url: "https://github.com/tangistudio/TangiTweak/pull/*", navigation: "match" }, (ctx) => {
         *     ctx.mount("#partial-discussion-header", <Badge />);
         * });
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#single-page-apps
         */
        navigation?: "load" | "match" | "every";
        /**
         * `tweak.onSite` only: where this handler's `ctx.patch`es sit when
         * other tweaks patch the same function. Patches from every tweak
         * form one chain per function: `"base"` innermost (next to the
         * original), then `"site"`, then `"override"` outermost (it sees
         * the call first and the result last). Within a layer, the script
         * list order decides, then registration order: a later one sits
         * further out.
         *
         * Unset: the tweak's package.json `tangitweak.layer`, else
         * inferred from the hosts: `"base"` when a url pattern can match
         * any host (`"<all_urls>"`), `"site"` for named hosts. The user's
         * layer setting for the tweak overrides both this and package.json.
         *
         * @example { url: "<all_urls>", layer: "override" } // its patches wrap every other tweak's
         */
        layer?: "base" | "site" | "override";
    }

    /** `ctx.onNavigate`, on the `onSite`, `onPage` and `onOverlay` contexts. */
    interface NavigateCtx {
        /**
         * Run `fn` with the frame's new URL whenever it changes in place
         * (history API, back/forward, `#hash` changes), as single-page apps
         * do. The run goes on; returns a function that stops listening
         * (it also stops when the run ends). To start and stop with the
         * URL instead, use the route's `navigation`.
         *
         * @example
         * tweak.onOverlay("*://example.com/*", (ctx) => {
         *     const show = (url: string) => (badge.hidden = !url.includes("/cart"));
         *     show(ctx.url);
         *     ctx.onNavigate(show);
         * });
         */
        onNavigate(fn: (url: string) => void): () => void;
    }

    /** Route options for `tweak.onOverlay`. */
    interface OverlayRouteOptions extends DocumentRouteOptions {
        /**
         * Opt-in debugger-safe mode: render the overlay into a fixed closed
         * shadow root in the isolated world instead of an extension iframe so
         * external debugger extensions (such as Playwriter) can attach without
         * removing the overlay. Requires Chrome user scripts on MV3.
         *
         * @defaultValue `false`
         */
        debuggerSafe?: boolean;
    }

    /** Where an `onOverlay` handler runs: URL pattern(s) or {@link OverlayRouteOptions}. */
    type OverlayRoute = UrlPatterns | OverlayRouteOptions;

    /** Route options for `tweak.site`. */
    interface SiteRouteOptions {
        /** Top-frame page URLs to replace with your custom site. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /**
         * Top-frame page URLs to leave untouched (for example login or checkout
         * paths), even when `url` matches.
         */
        exclude?: UrlPatterns;
        /**
         * Whether matching tabs start in custom-site mode or on the original
         * site. Users can switch either way from the popup toggle.
         *
         * @defaultValue `"custom"`
         */
        defaultMode?: "custom" | "original";
        /**
         * Opt-in debugger-safe mode: host the custom site in a sandboxed
         * `srcdoc` iframe unlocked by a per-session CSP nonce instead of an
         * extension iframe so external debugger extensions (such as Playwriter)
         * can attach without removing the site.
         *
         * @defaultValue `false`
         */
        debuggerSafe?: boolean;
        /**
         * When in the document load the site handler runs. Defaults to
         * `"document_start"`.
         */
        when?: DocumentWhen;
        /**
         * What happens when the URL changes in place (`history.pushState`,
         * back/forward, `#hash`). Defaults to `"load"`.
         */
        navigation?: "load" | "match" | "every";
    }

    /** Where a `tweak.site` handler runs: URL pattern(s) or {@link SiteRouteOptions}. */
    type SiteRoute = UrlPatterns | SiteRouteOptions;

    /**
     * Where a page handler runs: URL pattern(s) or the full
     * {@link DocumentRouteOptions} form. The API says which world:
     *
     * | | runs in | sees | trusted |
     * |---|---|---|---|
     * | `tweak.onSite` | the site's JavaScript world | the site's DOM and globals (`window.myApp`) | no: the site can see and tamper with it |
     * | `tweak.onPage` | an isolated world | the site's DOM, none of its globals | yes |
     * | `tweak.onOverlay` | the script's own frame over the page (top frame) | its own DOM | yes |
     */
    type PageRoute = UrlPatterns | DocumentRouteOptions;

    /** Any function. */
    type Fn = (...args: any[]) => unknown;

    /**
     * A **handle**: the handler's functions, made async (what `tweak.onSite`,
     * `tweak.onPage` and `tweak.onOverlay` return). A handler that returns a
     * plain object of functions exposes them; any other return value
     * (nothing, a string, an element) exposes nothing.
     *
     * Call a handle from `onPage` or `onOverlay` code (trusted code). In
     * `onSite` code a call throws: the site could make it too. A call
     * waits, with no time limit, until the handler has run in that
     * frame, also across a reload of the script; arguments and results are
     * JSON (≤ 1 MB). It rejects with:
     * - `DisconnectedError`: the other side went away (the frame navigated, the overlay closed);
     * - `AbortError`: the calling code's run ended first (its script reloaded); the call is cancelled;
     * - `ReloadedError`: the handler's script reloaded while the function ran (call again: the new run answers);
     * - `WtCallError`: the function threw, doesn't exist, or the value isn't JSON.
     *
     * Results from an `onSite` handle are the site's data: treat them as untrusted input.
     *
     * @example
     * const site = tweak.onSite("*://example.com/*", () => ({ user: () => (window as any).myApp?.user?.name as string | undefined }));
     * tweak.onPage("*://example.com/*", async () => {
     *     const name = await site.user(); // string | undefined
     * });
     */
    type Remote<T> = [T] extends [Record<string, Fn>]
        ? { readonly [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }
        : {};

    /**
     * What every page handler's ctx has: its **run** and what the run sets
     * up. Saving the script runs the handler again (a new run); when it
     * returns, the old run's `signal` aborts, and what the old run set up
     * with `once`, `patch`, `style` and `mount` stays only if the new run
     * set it up too (a mount re-renders, a patch swaps its function); the
     * rest is undone. If the new run throws, the old one keeps running.
     */
    interface RunCtx {
        /**
         * Aborts when this run ends: the script was saved (a new run took
         * over), disabled or deleted. Pass it to `addEventListener`,
         * `fetch` and the like so they stop with the run.
         *
         * @example
         * tweak.onPage("*://example.com/*", (ctx) => {
         *     document.addEventListener("click", onClick, { signal: ctx.signal });
         *     const t = setInterval(poll, 1000);
         *     ctx.signal.addEventListener("abort", () => clearInterval(t));
         * });
         */
        readonly signal: AbortSignal;
        /**
         * `fn()`'s value, made once per page: later runs with the same
         * `key` get the same value (the cache is dropped when a run stops
         * asking for it).
         *
         * @example
         * const db = ctx.once("db", () => new Map<string, string>()); // survives saves
         */
        once<T>(key: string, fn: () => T): T;
        /**
         * Replace the function `obj[prop]` with `wrap(original)`. The
         * replacement is installed once (the site may keep a reference to
         * it); each run sets what it does, and once no run patches it any
         * more it calls the original.
         *
         * When several handlers or tweaks patch the same function, each
         * `orig` calls the patch below it: lower layers sit closer to the
         * original (see the route's `layer`), so the order doesn't depend
         * on which ran first. Removing one patch keeps the others.
         *
         * @example
         * tweak.onSite("*://example.com/*", (ctx) => {
         *     ctx.patch(history, "pushState", (orig) => function (this: History, ...args: any[]) {
         *         console.log("navigating to", args[2]);
         *         return orig.apply(this, args);
         *     });
         * });
         */
        patch<O extends object, K extends keyof O>(obj: O, prop: K, wrap: (orig: O[K]) => O[K]): void;
        /**
         * Add `css` to the page (its `<head>`, and each `ctx.mount` of the
         * script); removed once no run adds it any more.
         *
         * @example
         * ctx.style(`.ad-banner { display: none !important }`);
         */
        style(css: string): void;
        /**
         * The elements `selector` matches now, in page order. Your own
         * `ctx.mount` UI is never included.
         *
         * @example
         * const save = ctx.elements("button.save", { first: true })[0];
         * for (const img of ctx.elements("img", { shadow: true })) img.loading = "lazy";
         */
        elements<K extends keyof HTMLElementTagNameMap>(selector: K, opts?: ElementsOptions): HTMLElementTagNameMap[K][];
        elements<E extends Element = Element>(selector: string, opts?: ElementsOptions): E[];
        /**
         * Run `fn` on each element `selector` matches, now and as they're
         * added. When one leaves (removed, or it stops matching) its `signal`
         * aborts and the function `fn` returned runs. On a save every match
         * leaves and arrives again with the new `fn`; it all ends with the run.
         *
         * Changes are seen when elements are added or removed, or when an
         * attribute the selector uses changes. Focus, hover and properties
         * set by code (`input.value`) don't change attributes: for
         * `:focus`, `:hover` or `:checked` listen to events instead.
         *
         * Returns a function that stops it early.
         *
         * @example
         * ctx.elements("video", (video, signal) => {
         *     video.playbackRate = 2;
         *     video.addEventListener("ratechange", () => (video.playbackRate = 2), { signal });
         *     return () => tweak.log("a video left");
         * }, { shadow: true });
         */
        elements<K extends keyof HTMLElementTagNameMap>(selector: K, fn: (el: HTMLElementTagNameMap[K], signal: AbortSignal) => (() => void) | void, opts?: ObserveOptions): () => void;
        elements<E extends Element = Element>(selector: string, fn: (el: E, signal: AbortSignal) => (() => void) | void, opts?: ObserveOptions): () => void;
    }

    /** Options for `ctx.elements(selector, opts)`. */
    interface ElementsOptions {
        /**
         * Look inside shadow roots too. Each part of the selector must
         * match within one root: `"x-app .bar"` can't cross into
         * `<x-app>`'s shadow root, but `".bar"` finds it there.
         *
         * Closed roots are found too in `onSite` and in MV2 (Firefox)
         * `onPage`; in MV3 (Chrome) `onPage` only open roots are.
         */
        shadow?: boolean;
        /** Only the first match (with `fn`: it moves to the next when that one leaves). */
        first?: boolean;
        /** Where to look (default: the document). */
        root?: Document | Element | ShadowRoot;
    }

    /** Options for `ctx.elements(selector, fn, opts)`. */
    interface ObserveOptions extends ElementsOptions {
        /** Tells apart two calls with the same selector in one handler. */
        key?: string;
    }

    /** Where and how `ctx.mount(target, ui, opts)` places its UI. */
    interface MountOptions {
        /**
         * Where the UI goes, relative to each match:
         * - `"inside-last"` (default) / `"inside-first"`: its last or first child.
         * - `"before"` / `"after"`: its sibling.
         * - `"overlay"`: covering it (`position: absolute; inset: 0`, clicks
         *   pass through to the page except on your UI). A `static` match
         *   becomes `position: relative` while the overlay is there.
         */
        position?: "inside-last" | "inside-first" | "before" | "after" | "overlay";
        /** Tells apart two mounts at the same target and position. */
        key?: string;
        /** Only the first match. It moves to the next match when the page replaces it. */
        first?: boolean;
        /**
         * Put the UI back when the page removes it, for example when a
         * framework re-renders the match's children. It stops, with an
         * error in Problems, if the page keeps removing it (a fight).
         */
        autoRestore?: boolean;
        /** Also mount on matches inside shadow roots (see `ElementsOptions.shadow`). */
        shadow?: boolean;
    }

    /** What `onPage` and `onOverlay` ctx add: React UI and handle loops. */
    interface TrustedRunCtx extends RunCtx {
        /**
         * Render `ui` (JSX) into the page. Without a target it floats over
         * the page. With one, it goes on every element the selector matches,
         * now and later (or on that element), at `opts.position`. A match
         * that goes away unmounts its UI.
         *
         * `ui` can be a function. It's called with the anchor element, may
         * use hooks, and is re-run with the latest code on each save.
         *
         * Each save re-renders the same React roots, and named function
         * components keep their state, nested ones too (see "Component
         * state across saves" in docs/scripting.md). Once no run mounts
         * there any more it unmounts.
         *
         * In `onPage` the UI sits in a closed shadow root: the page's CSS
         * doesn't reach it, but `ctx.style` does. In `onOverlay` it goes into
         * the overlay's `<body>`.
         *
         * A handler has one mount per (target, position, key). Mounting there
         * again, also later in the run, re-renders it.
         *
         * Returns a function that removes this mount early.
         *
         * @example
         * tweak.onPage("*://example.com/*", (ctx) => {
         *     ctx.mount("#header", <button onClick={() => alert("hi")}>Hi</button>);
         *     ctx.mount(".card", (card) => <Badge id={card.id} />, { position: "overlay" });
         * });
         * tweak.onOverlay("*://example.com/*", (ctx) => ctx.mount(<Panel />));
         */
        mount(ui: unknown): () => void;
        mount(target: string | Element, ui: unknown | ((anchor: Element) => unknown), opts?: MountOptions): () => void;
        /**
         * Call `fn(...args)` over and over, yielding each answer: for a
         * handle function that answers when something happens. A call cut
         * by the other side's reload is made again; the loop ends when this
         * run does.
         *
         * @example
         * const site = tweak.onSite("*://example.com/*", (ctx) => {
         *     const logins: string[] = [], waiting: ((u: string) => void)[] = [];
         *     // answer every waiting call: one may be from a run that ended since
         *     window.addEventListener("app:login", (e: any) => (waiting.length ? waiting.splice(0).forEach((w) => w(e.detail)) : logins.push(e.detail)), { signal: ctx.signal });
         *     return { nextLogin: () => (logins.length ? Promise.resolve(logins.shift()!) : new Promise<string>((r) => waiting.push(r))) };
         * });
         * tweak.onPage("*://example.com/*", async (ctx) => {
         *     for await (const user of ctx.each(site.nextLogin)) tweak.log("login:", user);
         * });
         */
        each<A extends any[], T>(fn: (...args: A) => Promise<T>, ...args: A): AsyncIterableIterator<T>;
    }

    /** The context an `onSite` handler gets (`url` is the frame's URL). No `mount`: React isn't in the site's world. */
    interface SiteCtx extends RequestCtx, RunCtx, NavigateCtx, IframesCtx<SiteIframeCtx> {}

    /** What `ctx.iframes` adds for the iframe its `fn` runs in. */
    interface IframeInfo {
        /** The `<iframe>` element, in the parent page. */
        readonly iframe: HTMLIFrameElement;
        /** The iframe's document. The global `document` is still the parent page's. */
        readonly document: Document;
        /** The iframe's window. */
        readonly window: Window;
    }

    /** What an `onSite` handler's `ctx.iframes` passes `fn`: a run in one iframe. */
    interface SiteIframeCtx extends RunCtx, IframeInfo, IframesCtx<SiteIframeCtx> {}

    /** What an `onPage` handler's `ctx.iframes` passes `fn`: a run in one iframe. */
    interface PageIframeCtx extends TrustedRunCtx, IframeInfo, IframesCtx<PageIframeCtx>, Pick<PageCtx, "shortcut"> {}

    /**
     * `ctx.iframes`, on `onSite` and `onPage` contexts and on the iframe
     * runs it starts (so nested iframes can be followed level by level).
     *
     * @typeParam F The context `fn` gets in each iframe:
     *   {@link SiteIframeCtx} in `onSite` code, {@link PageIframeCtx} in
     *   `onPage` code.
     */
    interface IframesCtx<F> {
        /**
         * Run `fn` in every same-origin iframe of this document (or only
         * those `selector` matches), now and as they're added. `fn` gets a
         * run of its own in the iframe: `f.document`, `f.window`,
         * `f.iframe`, and `signal`, `style`, `patch`, `mount` and the rest,
         * all aimed at the iframe's document.
         *
         * It also reaches iframes the script may not run in itself, such as
         * the `about:blank` and `srcdoc` frames rich-text editors and mail
         * compose windows use.
         *
         * `fn` runs again when the iframe loads a new document (the
         * previous `f.signal` aborts) and on each save. Its run ends when
         * the iframe goes away or this run ends. Cross-origin iframes are
         * skipped: their document is out of reach. There's no
         * `crossOrigin` option here yet (passing one throws); only
         * `ctx.shortcut` follows them.
         *
         * Use `f.document`, not `document`, inside `fn`. Elements of the
         * iframe aren't `instanceof` the parent's classes (`HTMLElement`
         * and the like): use `f.window.HTMLElement` or check `tagName`.
         *
         * Returns a function that stops it early.
         *
         * @example
         * tweak.onPage("*://mail.example.com/*", (ctx) => {
         *     ctx.iframes("iframe.editor", (f) => {
         *         f.style("body { font-size: 16px }");
         *         f.document.addEventListener("keydown", onKey, { signal: f.signal });
         *     });
         * });
         */
        iframes(fn: (f: F) => unknown, opts?: IframeOptions): () => void;
        iframes(selector: string, fn: (f: F) => unknown, opts?: IframeOptions): () => void;
    }

    /** Options for `ctx.iframes`. */
    interface IframeOptions {
        /** Also follow iframes inside shadow roots (see `ElementsOptions.shadow`). */
        shadow?: boolean;
    }

    /**
     * Which iframes a shortcut also listens in: `true` (all child iframes,
     * same-origin only), `false` (none, like leaving it out), a selector,
     * or `{ selector, shadow, crossOrigin }`. Any other value makes
     * `ctx.shortcut` throw a `TypeError`.
     *
     * @example { iframes: true }
     * @example { iframes: "iframe.editor" }
     * @example { iframes: { selector: "iframe.editor", crossOrigin: true } }
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#keyboard-shortcuts
     */
    type ShortcutIframes = boolean | string | {
        /** Only iframes this CSS selector matches. Omit for all; a non-string or invalid selector throws. */
        selector?: string;
        /**
         * Also iframes inside shadow roots (closed ones not in MV3 `onPage`,
         * see {@link ElementsOptions.shadow}).
         *
         * @defaultValue `false`
         */
        shadow?: boolean;
        /**
         * Also iframes from other sites. TangiTweak listens inside them and
         * runs `fn` in this frame, as usual. There the key is always kept
         * from the iframe's page (`"pass"` can't give it back). Iframes nested in them and pages
         * they wipe with `document.open()` aren't followed.
         *
         * @defaultValue `false`
         */
        crossOrigin?: boolean;
    };

    /** Options for `ctx.shortcut`. */
    interface ShortcutOptions {
        /**
         * `"before-page"`: beat the page, which never sees the key;
         * `"after-page"`: run only if the page didn't handle the key (didn't
         * call `preventDefault` or stop it).
         *
         * @defaultValue `"before-page"`
         */
        priority?: "before-page" | "after-page";
        /**
         * Also count keys pressed in child iframes (nested ones too, the
         * same selector picking at each level): rich-text editors such as
         * Google Docs take typing in a hidden iframe. A page the iframe
         * replaces with `document.open()` is followed too, though the page
         * can get the first keys before the shortcut listens again.
         * `shadow`: iframes inside shadow roots too (closed ones not in
         * MV3 `onPage`, see `ElementsOptions.shadow`). `crossOrigin`: iframes
         * from other sites too (`fn` still runs here); there `"pass"`
         * doesn't give the key back, and their own iframes and
         * `document.open()` pages aren't followed.
         */
        iframes?: ShortcutIframes;
    }

    /** The context an `onPage` handler gets (`url` is the frame's URL). */
    interface PageCtx extends RequestCtx, TrustedRunCtx, NavigateCtx, IframesCtx<PageIframeCtx> {
        /**
         * Run `fn` when the user presses `keys` on the page: "Alt+Shift+M",
         * "Mod+K" (Mod = Cmd on macOS, Ctrl elsewhere), "Shift+F2", "Esc".
         * `""` adds nothing, so a `shortcut` param the user cleared just
         * works: `ctx.shortcut(cfg.toggle, fn)`.
         * Works at all times, text fields included. By default the shortcut
         * beats the page (which never sees the key); `"after-page"` fires
         * only if the page didn't handle it. Return `"pass"` from `fn` to
         * hand the key on to the page as if no shortcut matched (anything
         * else, `undefined` included, consumes it). If another script has the same
         * keys, the one higher in the script list wins (a Log warning).
         * Returns a function that removes it (it's also removed when the
         * run ends).
         *
         * onPage: keys pressed in the frame the handler runs in (`f.shortcut`
         * in `ctx.iframes`: in that iframe; `iframes`: in child iframes too). Overlay:
         * keys pressed in the page or in the overlay. `"pass"` works for
         * keys pressed in the overlay only: a page key reaches the overlay
         * after the page's turn, so it stays consumed.
         *
         * @example
         * tweak.onPage("*://example.com/*", (ctx) => {
         *     ctx.shortcut("Alt+Shift+H", () => { box.hidden = !box.hidden; });
         *     ctx.shortcut("Mod+K", openSearch, { priority: "after-page" });
         *     // Esc closes the box when it's open; otherwise the page gets Esc
         *     ctx.shortcut("Esc", () => (box.hidden ? "pass" : void (box.hidden = true)));
         * });
         */
        shortcut(keys: string, fn: () => unknown, opts?: ShortcutOptions): () => void;
    }

    /** The context an `onOverlay` handler gets (`url` is the page's URL). */
    interface OverlayCtx extends RequestCtx, TrustedRunCtx, NavigateCtx, Pick<PageCtx, "shortcut"> {}

    /** Current URL parts of the replaced page, matching React Router's location shape. */
    interface SiteLocation {
        /** Path portion starting with `"/"`. */
        readonly pathname: string;
        /** Query string including leading `"?"`, or `""`. */
        readonly search: string;
        /** Fragment including leading `"#"`, or `""`. */
        readonly hash: string;
        /** Full URL of the top-level page. */
        readonly href: string;
        /** Origin of the top-level page (e.g. `"https://www.costco.ca"`). */
        readonly origin: string;
        /** Hostname of the top-level page (e.g. `"www.costco.ca"`). */
        readonly hostname: string;
        /** Optional history state attached to the current navigation entry. */
        readonly state: unknown;
        /** Unique key for the current navigation entry. */
        readonly key: string;
    }

    /** Target path or partial location accepted by {@link SiteNavigator}. */
    type SiteTo =
        | string
        | {
              /** Pathname to navigate to. */
              pathname?: string;
              /** Query string starting with `"?"` or `""`. */
              search?: string;
              /** Hash starting with `"#"` or `""`. */
              hash?: string;
          };

    /**
     * History navigator bridged to the real top-frame address bar. Compatible
     * with React Router's `<Router location={loc} navigator={ctx.navigator}>`.
     * Intercepted routes update the address bar in place with
     * `history.pushState`; excluded or off-route paths perform a full
     * navigation so the real website loads.
     */
    interface SiteNavigator {
        /** Formats `to` as an `href` string for anchor links. */
        createHref(to: SiteTo): string;
        /** Navigates to `to`, pushing a history entry on the real address bar. */
        push(to: SiteTo, state?: unknown): void;
        /** Navigates to `to`, replacing the current history entry on the real address bar. */
        replace(to: SiteTo, state?: unknown): void;
        /** Moves backward or forward in session history by `delta` entries. */
        go(delta: number): void;
    }

    /** Async bridge to the replaced origin's `localStorage` or `sessionStorage`. */
    interface OriginStorage {
        /** Reads a key from the replaced origin's storage. */
        get(key: string): Promise<string | null>;
        /** Writes a key in the replaced origin's storage. */
        set(key: string, value: string): Promise<void>;
        /** Removes a key from the replaced origin's storage. */
        remove(key: string): Promise<void>;
        /** Lists all keys in the replaced origin's storage. */
        keys(): Promise<string[]>;
        /** Clears all keys in the replaced origin's storage. */
        clear(): Promise<void>;
    }

    /** Async bridge to the replaced origin's non-HttpOnly `document.cookie`. */
    interface OriginCookie {
        /** Returns the replaced origin's current `document.cookie` string. */
        get(): Promise<string>;
        /** Assigns a cookie assignment string to the replaced origin's `document.cookie`. */
        set(cookie: string): Promise<void>;
    }

    /** Async bridge to the replaced origin's IndexedDB object stores. */
    interface OriginIndexedDB {
        /** Reads one value by key from `dbName` / `storeName`. */
        get(dbName: string, storeName: string, key: IDBValidKey): Promise<unknown>;
        /** Lists all values in `dbName` / `storeName` (optional range query or limit). */
        getAll(dbName: string, storeName: string, count?: number): Promise<unknown[]>;
        /** Lists all keys in `dbName` / `storeName`. */
        keys(dbName: string, storeName: string): Promise<IDBValidKey[]>;
        /** Puts a value into `dbName` / `storeName` (creates the store if absent). */
        put(dbName: string, storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;
        /** Deletes one key from `dbName` / `storeName`. */
        delete(dbName: string, storeName: string, key: IDBValidKey): Promise<void>;
        /** Lists database names on the replaced origin when supported by the browser. */
        databases(): Promise<{
            /** Database name. */
            name?: string;
            /** Database schema version. */
            version?: number;
        }[]>;
    }

    /**
     * Async bridge to the replaced origin's cookies, Web Storage, IndexedDB
     * and same-origin media blobs.
     */
    interface OriginAccess {
        /** Async access to the replaced origin's `localStorage`. */
        readonly localStorage: OriginStorage;
        /** Async access to the replaced origin's `sessionStorage`. */
        readonly sessionStorage: OriginStorage;
        /** Async access to the replaced origin's `document.cookie`. */
        readonly cookie: OriginCookie;
        /** Async access to the replaced origin's `indexedDB`. */
        readonly indexedDB: OriginIndexedDB;
        /**
         * Fetches a URL as the replaced origin (sending its cookies) and
         * returns a `data:` or `blob:` URL usable in `<img>`, `<video>` or CSS
         * even when the custom site runs under a strict CSP.
         */
        blobUrl(url: string): Promise<string>;
    }

    /**
     * The context a `tweak.site` handler receives. Extends {@link OverlayCtx}
     * with full-page controls, real-address-bar routing and bridged access to
     * the replaced origin's storage and cookies.
     */
    interface SiteAppCtx extends OverlayCtx {
        /** Sets the browser tab title (`document.title` on the top frame). */
        setTitle(title: string): void;
        /** Sets the browser tab favicon on the top frame. */
        setFavicon(url: string): void;
        /**
         * Updates the top-frame URL. Matching paths use `history.pushState` (or
         * `replaceState` when `opts.replace` is true); excluded or off-route
         * paths perform a full navigation to the real site.
         */
        navigate(path: string, opts?: {
            /** Replace the current history entry instead of pushing a new one. */
            replace?: boolean;
        }): void;
        /** Current location of the top-level page, kept in sync across navigations. */
        readonly location: SiteLocation;
        /**
         * React Router compatible navigator (`<Router location={loc} navigator={ctx.navigator}>`)
         * synced with the real address bar.
         */
        readonly navigator: SiteNavigator;
        /** Switches the current tab back to the original website and reloads it. */
        showOriginal(): void;
        /** Bridged access to the replaced origin's storage, cookies, IndexedDB and media. */
        readonly origin: OriginAccess;
    }

    /** Header edits. */
    interface HeaderMod {
        /**
         * Set (or overwrite) these headers.
         *
         * @example
         * { set: { "x-debug": "1", "cache-control": "no-store" } }
         */
        set?: { [name: string]: string };
        /**
         * Remove these headers (case-insensitive names).
         *
         * @example
         * { remove: ["cookie", "x-tracking-id"] }
         */
        remove?: string[];
    }

    /**
     * A synthesized response: the `onRequest` → `{ replaceResponse }`
     * result (a replacement). The request never reaches the server.
     *
     * The mock then goes through the matching `onResponseHeaders` and
     * `onResponseBody` handlers like a network response, with
     * `ctx.replacedBy` set. Chromium's `extension` strategy serves it by
     * redirect instead: its response handlers don't run on it.
     *
     * The `extension` strategy serves only status 200 (any other status
     * isn't served: the request goes through unchanged, with a Log warning)
     * and ignores `headers` on Chromium.
     *
     * @example
     * tweak.onRequest({ url: "*://api.example.com/flags", strategy: "helper" }, () => ({
     *     replaceResponse: { body: { beta: true }, headers: { set: { "cache-control": "no-store" } } },
     * }));
     */
    interface ReplacementOptions {
        /**
         * Response body. A string is sent as-is; any other object is
         * JSON-serialized. A `Uint8Array` is sent as-is by the `extension`
         * strategy but decoded as UTF-8 text by the others, so it suits text
         * only there. `{ file }` serves a file reference.
         */
        body: string | Uint8Array | object | {
            /**
             * A `data:` URL (base64 or percent-encoded), decoded and served
             * with its media type (`text/plain` when it has none). Any
             * other string is served as the body itself: no file is read.
             *
             * @example { file: "data:text/html;base64,PGgxPkhpPC9oMT4=" }
             */
            file: string;
        };
        /**
         * HTTP status.
         *
         * @defaultValue `200`
         */
        status?: number;
        /**
         * Content-Type. Default: a `data:` file's own media type, else
         * guessed from the request URL's extension (`.js`, `.json`, `.css`,
         * `.html`, `.xml`), else from the resource type (HTML for documents
         * and frames, CSS, JavaScript), else `application/json` (whatever
         * the body is).
         */
        mime?: string;
        /** Extra response headers (not on Chromium's `extension` strategy). */
        headers?: {
            /** Headers to send with the replacement (`name → value`). */
            set?: { [name: string]: string };
        };
    }

    /**
     * What `onRequest` may return: **exactly one** of `replaceResponse`,
     * `redirect`, `block`, `allow` or `headers` (or nothing, to keep what
     * the earlier handlers decided). The first four are **decisions**: every
     * matching handler runs and the last decision wins. `headers` is not a
     * decision and stacks. To change a redirected request's headers, add an
     * `onRequest` handler for the redirect target: on most strategies the
     * redirected request runs through `onRequest` again.
     */
    type RequestResult =
        | OnlyOne<"replaceResponse", {
              /** Serve this replacement without contacting the network (a decision). */
              replaceResponse: ReplacementOptions;
          }>
        | OnlyOne<"redirect", {
              /** Redirect the request to this URL (a decision). */
              redirect: string;
          }>
        | OnlyOne<"block", {
              /** Block the request entirely (a decision). `false` leaves it alone. */
              block: boolean;
          }>
        | OnlyOne<"allow", {
              /**
               * Send the request to the network: undoes an earlier
               * handler's `block`, `redirect` or `replaceResponse` (a
               * decision; a later handler can still decide otherwise).
               *
               * @example
               * tweak.onRequest({ url: "*://ads.example.com/*", strategy: "helper" }, (ctx) => (ctx.url.includes("keep") ? { allow: true } : undefined));
               */
              allow: true;
          }>
        | OnlyOne<"headers", {
              /** Modify request headers on the way out (not final). */
              headers: HeaderMod;
          }>;

    /** `T`, with every other `onRequest` result key forbidden. */
    type OnlyOne<K extends RequestResultKey, T> = T & { [O in Exclude<RequestResultKey, K>]?: never };
    /**
     * The keys of an `onRequest` result. A result with more than one is
     * kept to the first in this order (a throttled Log warning names the
     * dropped ones).
     */
    type RequestResultKey = "replaceResponse" | "redirect" | "block" | "allow" | "headers";

    /** `onResponseHeaders` context: the request plus the response head. */
    interface ResponseHeaderCtx extends RequestCtx {
        /** HTTP status line, e.g. `"HTTP/1.1 200 OK"`. */
        statusLine: string;
        /** Response headers as they came from the network (or the mock), with the earlier handlers' edits. */
        responseHeaders: HeaderPair[];
        /**
         * Set when the response is a mock (an `onRequest` `replaceResponse`
         * result) rather than the network's: who made it. `undefined` for a
         * real response.
         *
         * @example
         * tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => {
         *     if (ctx.replacedBy) return { headers: { set: { "x-mocked-by": ctx.replacedBy.tweak } } };
         * });
         */
        replacedBy?: ReplacedBy;
    }

    /** The mock a response handler runs on: see `ctx.replacedBy`. */
    interface ReplacedBy {
        /** The name of the tweak whose `onRequest` made the mock. */
        tweak: string;
        /** Which of its handlers made it, e.g. `"onRequest #1"`. */
        handler: string;
    }

    /** What `onResponseHeaders` may return. */
    interface ResponseHeaderResult {
        /** Response header edits; applied in script order. */
        headers?: HeaderMod;
    }

    /** `onResponseBody` context. */
    interface BodyCtx extends RequestCtx {
        /** Content-Type reported by the server, if known. */
        mime?: string;
        /** Response status code, when available. */
        status?: number;
        /**
         * Set when the body is a mock (an `onRequest` `replaceResponse`
         * result) rather than the network's: who made it. `undefined` for a
         * real response.
         *
         * @example
         * tweak.onResponseBody({ url: "*://api.example.com/*", strategy: "helper" }, (ctx, body) => {
         *     if (ctx.replacedBy) return body.replace("Mock", `Mock from ${ctx.replacedBy.tweak}`);
         * });
         */
        replacedBy?: ReplacedBy;
    }

    /**
     * Per-script persistent key/value storage (JSON-serializable values),
     * the type of `tweak.storage`. Each script has its own, kept by the
     * background in the extension's local storage and lasts across reloads
     * and browser restarts. Background
     * handlers, `onPage`, `onOverlay` and `onSite` code all reach the same
     * one.
     *
     * Keys starting with `$store:` hold the saved copies of
     * {@link Tweak.globalStore}s (`"$store:<name>"`); `set` on one logs a
     * warning, since the store overwrites it on its next save.
     */
    interface Storage {
        /**
         * Read a value; resolves to `undefined` when the key was never set
         * (in `onPage` code, also when the background can't be reached).
         *
         * @example
         * const hits = (await tweak.storage.get("hits")) ?? 0;
         */
        get(key: string): Promise<any>;
        /**
         * Store a value (persists across reloads and browser restarts).
         * In `onPage` code it resolves even when the background can't be
         * reached and nothing was stored.
         *
         * @example
         * await tweak.storage.set("hits", hits + 1);
         */
        set(key: string, value: any): Promise<void>;
    }

    /** A JSON value: what a {@link Tweak.globalStore} may hold. */
    type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

    /** Options for {@link Tweak.globalStore}. */
    interface StoreOptions<T> {
        /**
         * What survives a browser restart: `true` (default) the whole store,
         * `false` nothing (it still survives an MV3 service-worker restart),
         * or a list of top-level fields.
         */
        persist?: boolean | (keyof T & string)[];
    }

    /**
     * `tweak.fetch` options: `RequestInit` plus where the request comes
     * from. `signal` is ignored (it can't reach the background) and
     * `credentials` defaults to `"include"`. Request and response bodies
     * are capped at 10 MB each (a `RangeError` past it).
     */
    interface FetchInit extends RequestInit {
        /**
         * `"background"`: the extension fetches, with its host permissions
         * (no CORS) and the browser's cookies. `"page"`: the page fetches (its
         * origin, cookies and CORS), from an overlay only (elsewhere it
         * rejects). Default: `"page"` in an overlay, `"background"` elsewhere.
         * An overlay's own `fetch()` is the page's too. Any other value is a
         * `TypeError`.
         */
        from?: "page" | "background";
        /** Skip every script's handlers (this script's too) for this request; the Log shows it as `bypass`. */
        bypass?: boolean;
    }

    /** Timing for `tweak.onSite`, `tweak.onPage` and `tweak.onOverlay` (part of the route object). */
    interface DocumentOptions {
        /**
         * **When** the handler runs, relative to the page's own loading.
         * `onSite` runs before the site, `onPage`/`onOverlay` when the DOM
         * is ready; `when` changes that. Default: `"document_start"` for
         * `tweak.onSite` (to get in ahead of the site's scripts: patch
         * `fetch`, catch a store as it's created), `"document_end"` for
         * `tweak.onPage` and `tweak.onOverlay` (DOM work needs `<body>`).
         *
         * **How it gets there:** in every frame (top page *and* iframes) the
         * extension injects a small hook at `document_start`. The hook asks
         * the background for the scripts with a page route covering *that
         * frame's* URL, compiles them, and schedules each matching handler
         * according to its own `when`.
         *
         * | `when` | Fires | DOM state |
         * |---|---|---|
         * | `"document_start"` *(onSite)* | as soon as the script is compiled | only `<html>`; `head`/`body` usually `null` |
         * | `"document_end"` *(onPage, onOverlay)* | at `DOMContentLoaded` (DOM parsed) | whole DOM queryable; images/iframes may still load |
         * | `"document_idle"` | after the page's `load` event | every subresource finished |
         *
         * **`"document_start"`**: runs while the HTML is still being parsed,
         * so `querySelector` finds (almost) nothing. Use it to get in *ahead*
         * of page code: stub or wrap globals (`window.fetch`, `navigator.*`),
         * observe `document` with a `MutationObserver`, add capture-phase
         * listeners.
         * - *Race caveat:* in the MV2 build the script arrives within ~1 ms and
         *   reliably beats the page's scripts. In the MV3 build a cold service
         *   worker can take ~50–100 ms to answer, so early inline `<script>`s
         *   **may already have run**. Don't rely on winning the race for
         *   correctness: use `onResponseBody` when you must change what page
         *   code sees.
         *
         * **`"document_end"`**: at `DOMContentLoaded` (DOM parsed):
         * `defer`/module scripts have run; images,
         * stylesheets and iframes may still be loading, and frameworks (React,
         * Vue, …) may not have hydrated yet, so a re-render can overwrite your
         * change. The right choice for most title/text/attribute tweaks. If
         * the page is already past this point when the script arrives (slow
         * bundle, bfcache restore), the handler runs immediately.
         *
         * **`"document_idle"`**: after the page's `load` event. Best for
         * reading final layout/sizes or tweaking content that page scripts
         * build during load. The slowest choice: one hanging image or ad
         * iframe delays it. Runs immediately if `load` already fired. Unlike
         * Chrome's content-script `run_at: "document_idle"` (which can fire
         * before `load`), this **always** waits for `load`.
         *
         * **Applies to every value:**
         * - Runs **once** per document load, per matching frame. SPA route
         *   changes (`pushState`) don't re-run it unless the route sets
         *   `navigation` (then `when` is the earliest it starts); framework
         *   re-renders never do: start a `MutationObserver` inside the
         *   handler to keep re-applying.
         * - Saving the script while the page is open runs the handler again
         *   **immediately**, regardless of `when` (a new run): what it sets
         *   up with `ctx.once` / `ctx.patch` / `ctx.style` / `ctx.mount` is
         *   kept or undone, the previous run's `ctx.signal` aborts. No
         *   `document.readyState` guards needed.
         * - `ctx.mount(target, ui)` waits for `target`, so an `onPage` at
         *   `document_start` can still draw once the target appears.
         * - A script may register several page handlers, each with its
         *   own route and `when`. Handlers with the same `when` run in
         *   script-list order, then registration order.
         * - Async handlers are not awaited; `when` controls only when they
         *   *start*.
         * - `onSite`: if the page's CSP forbids `eval`, the handler falls
         *   back to the isolated world: same DOM and timing, but
         *   page-defined globals (e.g. `window.myApp`) are not visible.
         *
         * @example
         * // onPage default: document_end (DOMContentLoaded)
         * tweak.onPage("*://example.com/*", () => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * tweak.onPage({ url: "*://example.com/*", when: "document_start" }, () => {
         *     Object.defineProperty(navigator, "webdriver", {
         *         get: () => false,
         *     });
         * });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * tweak.onPage({ url: "*://example.com/*", when: "document_idle" }, () => {
         *     const apply = () => {
         *         for (const ad of document.querySelectorAll(".ad")) ad.remove();
         *     };
         *     apply();
         *     new MutationObserver(apply).observe(document.body, {
         *         childList: true,
         *         subtree: true,
         *     });
         * });
         */
        when?: "document_start" | "document_end" | "document_idle";
    }

    // ---- tweak.params: typed, user-adjustable parameters ----

    /**
     * A length of time: a string of numbers with units `s`, `m`, `h` and `d`
     * (`"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1h30m"`), or a number of
     * milliseconds.
     */
    type Duration = number | `${number}${"s" | "m" | "h" | "d"}` | (string & {});

    /** What a `tweak.every` handler receives. */
    interface EveryCtx {
        /** Aborts when the run's 60 s are up: check it between steps of a long run. */
        signal: AbortSignal;
        /** Why it runs: on schedule (`"alarm"`), overdue at browser start (`"startup"`) or **Run now** in the Editor (`"manual"`). */
        reason: "alarm" | "startup" | "manual";
        /** When it last ran, in ms since epoch (none on the first run). */
        lastRun?: number;
        /**
         * Unschedule it until the tweak is saved, turned off and on again or
         * the user clicks **Run now**. For a stop that lasts across saves,
         * pass a function as the interval and keep the state in a store.
         */
        stop(): void;
    }

    /** A toast's kind: it picks the accent color and the icon. */
    type ToastKind = "info" | "success" | "warning" | "error";

    /** A corner (or edge center) of the tab where toasts stack. */
    type ToastPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

    /** A button on a toast. */
    interface ToastAction {
        /** What `tweak.onToastAction` receives as `actionId`. */
        id: string;
        /** The button's text. */
        label: string;
        /** An http(s) URL the button opens in a new tab (the action still reaches `tweak.onToastAction`). */
        url?: string;
    }

    /**
     * How a tweak's toasts look. Every key is optional: the default look is
     * finished without any. Colors are CSS colors.
     *
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#toast-styles
     */
    interface ToastStyle {
        /** The corner the toasts go to, unless the user picked one (default `"bottom-right"`). */
        position?: ToastPosition;
        /** The accent: the stripe, the icon and the buttons (by default it follows the kind). */
        accent?: string;
        /** The card's background. */
        background?: string;
        /** The text color. */
        text?: string;
        /** The border color. */
        border?: string;
        /** Corner radius, in pixels or any CSS length. */
        radius?: number | string;
        /** Width in pixels, 280 to 480 (default 360). */
        width?: number;
        /** The CSS font family. */
        font?: string;
        /** Used while the system is in dark mode: colors, radius, width and font. */
        dark?: Omit<ToastStyle, "dark" | "position" | "css" | "titleFlash" | "iconDot">;
        /**
         * Extra CSS (up to 8 KB) inside each toast's own shadow root, so it
         * styles only this tweak's toasts. Target the parts: `[part=toast]`,
         * `icon`, `title`, `message`, `actions`, `action`, `close`, `source`
         * and `progress`, and the variables `--tt-accent`, `--tt-bg`,
         * `--tt-text`, `--tt-border`, `--tt-radius` and `--tt-font`.
         */
        css?: string;
        /** Flash the tab title while a toast waits in a background tab (default true). */
        titleFlash?: boolean;
        /** Put a dot on the tab icon while a toast waits in a background tab (default true). */
        iconDot?: boolean;
    }

    /** What `tweak.toast` takes besides a plain message. */
    interface ToastOptions {
        /** The bold first line. */
        title?: string;
        /** The text under it. Plain text, never HTML. */
        message?: string;
        /** Default `"info"`. */
        kind?: ToastKind;
        /** An emoji or short text, an image URL (http(s), `data:image` or an imported image) or `false` for none. */
        icon?: string | false;
        /** What a click on the toast opens in a new tab: http(s) only. */
        url?: string;
        /** Up to 2 buttons. A string is a button whose label is its id. */
        actions?: (ToastAction | string)[];
        /** How long it stays on screen (default `"6s"`; errors default to `"sticky"`). Its timer pauses while the tab is hidden or hovered. */
        duration?: Duration | "sticky";
        /** Unique in the tweak: a toast with the same id replaces it in place. */
        id?: string;
        /**
         * Which tab shows it:
         * - `"active"`: the tab in front (the default in background code);
         * - `"this"`: the calling page's tab (the default in `onPage` and `onOverlay` code);
         * - a URL pattern or list: every open tab that matches.
         */
        where?: "active" | "this" | UrlPatterns;
        /** How long it waits for a tab that can show it (default `"1h"`, at most `"7d"`). */
        ttl?: Duration;
        /** Its own look, over the tweak's {@link Tweak.toastStyle}. */
        style?: ToastStyle;
        /**
         * What its tab does while it waits unseen in the background:
         * `"tab"` (the default) flashes the title and dots the icon,
         * `"window"` also asks the browser window for attention and `"none"`
         * does neither (and lets the timer run while the tab is hidden).
         */
        attention?: "none" | "tab" | "window";
        /** The {@link Tweak.toastPane} that draws it. Fill `title` and `message` too: they show if the pane can't. */
        pane?: string;
        /** What the pane gets as `toast.data`: JSON, up to 32 KB. */
        data?: unknown;
    }

    /** What became of a toast. */
    interface ToastResult {
        /** The toast's id (made up when it had none). */
        id: string;
        /** `"shown"` on a tab, `"queued"` until a tab can show it, or `"dropped"` (muted, rate-limited or too many). */
        status: "shown" | "queued" | "dropped";
        /** Why it was dropped. */
        reason?: string;
    }

    /** What a user did to a toast, as `tweak.onToastAction` receives it. */
    interface ToastEvent {
        /** The toast's id. */
        toastId: string;
        /** The button's id, `"click"` (the card, when it has a `url`) or `"close"` (closed by the user). */
        actionId: string;
        /** What a pane passed to `ui.action(id, value)`. */
        value?: unknown;
    }

    /** The toast a pane draws. */
    interface PaneToast<T> {
        /** The toast's id. */
        id: string;
        /** What `tweak.toast` passed as `data`. */
        data: T;
        /** The toast's title, if any. */
        title?: string;
        /** The toast's message, if any. */
        message?: string;
        /** The toast's kind. */
        kind: ToastKind;
    }

    /** What a pane can do to its toast. */
    interface PaneUi {
        /** Report an action: it reaches `tweak.onToastAction` with `value`. The toast stays. */
        action(id: string, value?: unknown): void;
        /** Close the toast. */
        close(): void;
        /** Stop its timer, e.g. once the user starts typing. */
        keepOpen(): void;
        /** Draw it again with new data. */
        update(data: unknown): void;
    }

    /**
     * A tweak's package.json fields as TangiTweak reads them: the npm
     * fields (`name`, `version`, `description`, `author`, `license`,
     * `homepage`) and the `"tangitweak"` block (`displayName`, `icon`,
     * `updateURL`, `connect`, `minTangiTweakVersion`).
     *
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/packages.md
     */
    interface Metadata {
        /**
         * Shown when installing and in the Explorer: `tangitweak.displayName`,
         * else the npm `name`. Without either, the tweak's folder name.
         */
        name?: string;
        /** Dotted version, e.g. `"1.2.0"`. An update to a lower one waits for review. */
        version?: string;
        /**
         * Minimum TangiTweak version required, e.g. `"0.35.0"`: the lowest
         * version `dependencies.tangitweak` allows, else
         * `tangitweak.minTangiTweakVersion`. Warns on import and install, and
         * holds auto-updates while this browser has an older TangiTweak.
         */
        minTangiTweakVersion?: string;
        /** One line about what the tweak does: its tooltip in the Editor and popup. */
        description?: string;
        /**
         * `tangitweak.icon`, shown in the Explorer and popup: a relative
         * `.svg`/`.png`/… path in the tweak, a `data:` or `https://` URL, or
         * inline `<svg>` markup.
         */
        icon?: string;
        /** A link shown when installing. */
        homepage?: string;
        /** Who made it, shown as "by …" when installing: the npm `author` string or the `name` of an `{ "name": … }` object. */
        author?: string;
        /** The license, e.g. `"MIT"`, shown when installing. */
        license?: string;
        /**
         * Where updates come from, instead of where it was installed from: a
         * package.json or .zip URL, a GitHub file or folder
         * (`github.com/o/r/tree/main/dir`), a gist (`gist.github.com/u/id`) or a
         * gist's raw file URL. A copy installed from a folder or zip updates
         * from it too. An update that changes it waits for review.
         */
        updateURL?: string;
        /**
         * `tangitweak.connect`: the hosts the tweak's `tweak.fetch` calls
         * reach from `onPage` code (these and their subdomains; names are
         * lowercased). The install page lists them. An update that adds one
         * waits for review.
         */
        connect?: string[];
    }

    /** An on/off switch: a checkbox in the ⚙ dialog. */
    interface ParamDefBoolean {
        /** Picks this kind of param. A stored value that isn't a boolean falls back to the default. */
        type: "boolean";
        /** Default `false`. */
        default?: boolean;
        /** Shown next to the control and in settings.json. */
        description?: string;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "boolean", default: true, parse: (on) => (on ? "verbose" : "quiet") }
         */
        parse?: (raw: boolean) => unknown;
    }
    /** A number: a number input in the ⚙ dialog. */
    interface ParamDefNumber {
        /** Picks this kind of param. A stored value that isn't a finite number falls back to the default. */
        type: "number";
        /** Default `0`. */
        default?: number;
        /** Shown next to the control and in settings.json. */
        description?: string;
        /** Lower bound; the UI clamps typed values. */
        min?: number;
        /** Upper bound; the UI clamps typed values. */
        max?: number;
        /** Step for the number input. Default `1`; use e.g. `0.1` for decimals. */
        step?: number;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "number", default: 2, parse: (sec) => sec * 1000 } // seconds → ms
         */
        parse?: (raw: number) => unknown;
    }
    /** Free text: a text input (or textarea) in the ⚙ dialog. */
    interface ParamDefString {
        /** Picks this kind of param. A stored value that isn't a string falls back to the default. */
        type: "string";
        /**
         * Edit in a textarea. Multi-line string parameter.
         */
        multiline?: boolean;
        /** Default `""`. */
        default?: string;
        /** Shown next to the control and in settings.json. */
        description?: string;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "string", default: "https://api.example.com", parse: (s) => new URL(s) }
         */
        parse?: (raw: string) => unknown;
    }
    /** One of fixed choices: a dropdown in the ⚙ dialog. */
    interface ParamDefEnum {
        /** Picks this kind of param. A stored value not among `choices` falls back to the default. */
        type: "enum";
        /** The allowed values; the param is typed as their union. */
        choices: string[];
        /** Default: the first choice (`""` when `choices` is empty). */
        default?: string;
        /** Shown next to the control and in settings.json. */
        description?: string;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "enum", choices: ["500", "503"], parse: (c) => Number(c) }
         *
         * `raw` is typed `string` here (always one of `choices` at run time).
         */
        parse?: (raw: string) => unknown;
    }
    /** A list of strings: one entry per line in the ⚙ dialog. */
    interface ParamDefStringList {
        /** Picks this kind of param. A stored value that isn't a list of strings falls back to the default; `parse` gets a copy. */
        type: "stringList";
        /** Default `[]`. */
        default?: string[];
        /** Shown next to the control and in settings.json. */
        description?: string;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) }
         */
        parse?: (raw: string[]) => unknown;
    }
    /**
     * Keys for {@link PageCtx.shortcut}: the ⚙ dialog records them as
     * you press them, with buttons to remove the shortcut and reset it to
     * the default. The value is the keys ("Mod+Shift+K", Mod being Cmd on
     * macOS and Ctrl elsewhere), or `""` once removed.
     *
     * @example
     * const cfg = tweak.params({ toggle: { type: "shortcut", default: "Alt+Shift+H" } });
     * tweak.onOverlay("*://example.com/*", (ctx) => {
     *     ctx.shortcut(cfg.toggle, () => { box.hidden = !box.hidden; });
     * });
     */
    interface ParamDefShortcut {
        /** Picks this kind of param. A stored value that isn't a shortcut falls back to the default. */
        type: "shortcut";
        /** Default `""` (none). A default that isn't a shortcut is a script error. */
        default?: string;
        /** Shown next to the control and in settings.json. */
        description?: string;
        /**
         * Turn the raw value into what the script receives: the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.json keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         */
        parse?: (raw: string) => unknown;
    }
    /** One adjustable parameter, discriminated by `type`. */
    type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList | ParamDefShortcut;

    /**
     * A nested object grouping parameters (or sub-sections) into collapsible
     * sections in the popup and nested maps in settings.json.
     */
    interface ParamGroup {
        readonly [key: string]: ParamDef | ParamGroup;
    }

    /** The raw (stored, edited) value type of a param def: what `parse` receives. */
    type ParamRawValue<D extends ParamDef> = D extends ParamDefBoolean
        ? boolean
        : D extends ParamDefNumber
          ? number
          : D extends ParamDefString
            ? string
            : D extends ParamDefEnum
              ? D["choices"][number]
              : D extends ParamDefStringList
                ? string[]
                : D extends ParamDefShortcut
                  ? string
                  : never;

    /**
     * The value type a param def resolves to: `parse`'s return type when
     * the def has one, else {@link TangiTweak.ParamRawValue}.
     */
    type ParamValue<D extends ParamDef> = D extends {
        /** The def's parser, whose return type `R` is the param's type. */
        parse: (raw: never) => infer R;
    } ? R : ParamRawValue<D>;

    /**
     * `true` when a {@link ParamsOf} entry is read-only from code: a param
     * with `parse` (code sees the parsed value, not the stored one) or a
     * section (assign to its params instead).
     */
    type ParamIsReadonly<V> = V extends ParamDef ? (V extends {
        /** Any parser makes the param read-only. */
        parse: Function;
    } ? true : false) : true;
    /** The value of one {@link ParamsOf} entry: a param's {@link ParamValue} or a section's own {@link ParamsOf}. */
    type ParamEntryValue<V> = V extends ParamDef ? ParamValue<V> : V extends ParamGroup ? ParamsOf<V> : never;

    /**
     * Resolved parameter values, typed from the defs (and nested sections)
     * you passed. Leaf params are assignable from handler code
     * (`cfg.on = false`, `cfg.network.host = "b.com"`), except params with
     * `parse`.
     */
    type ParamsOf<T extends ParamGroup> = {
        -readonly [K in keyof T as ParamIsReadonly<T[K]> extends false ? K : never]: ParamEntryValue<T[K]>;
    } & {
        readonly [K in keyof T as ParamIsReadonly<T[K]> extends true ? K : never]: ParamEntryValue<T[K]>;
    };

}

/**
 * The `tweak` object's type, {@link TangiTweak.Tweak}. A second block of the
 * same namespace, so the registration functions read apart from the types
 * they use.
 */
declare namespace TangiTweak {
    /**
     * The script API: `import { tweak } from "tangitweak"`.
     *
     * A script is a file that registers handlers at top level. Each handler
     * takes its own **route** first (a URL pattern, a list or a route object
     * with `url`, `exclude`, `methods`, `resourceTypes`, `strategy`), then the handler:
     *
     * ```ts
     * tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
     * ```
     *
     * The tweak's entry registers them; its other files are *modules*: they
     * run when the entry imports them, and what they register is the tweak's.
     *
     * **Stacking.** When several handlers match one request they run in list
     * order (scripts top to bottom in the Editor, then registration order):
     * - `onRequest`: **all** matching handlers run; the last decision
     *   (`replaceResponse`/`redirect`/`block`/`allow`) wins. Headers-only or
     *   `void` results keep the earlier decision; header edits stack (later
     *   wins per header) and a later handler's `ctx.requestHeaders` shows them.
     * - `onResponseHeaders`: **all** matching handlers run; `set` is applied in
     *   order (later overwrites), `remove` accumulates.
     * - `onResponseBody`: transforms **compose**: each output is the next input.
     *
     * A mock (`replaceResponse`) goes through the response handlers too,
     * with `ctx.replacedBy` set.
     *
     * Handlers on different strategies run independently, each on its own
     * strategy (see {@link TangiTweak.Strategy}).
     *
     * **Async.** Every handler may return a Promise. On Chromium's
     * `"extension"` strategy `onRequest`/`onResponseHeaders` must be
     * synchronous (an async result is ignored with a warning); every other
     * strategy awaits it.
     *
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#multiple-handlers--how-they-stack
     */
    interface Tweak {
        /**
         * Intercept a request before it is sent. Return **one** of
         * `{ replaceResponse }`, `{ redirect }`, `{ block }`, `{ allow }` or
         * `{ headers }` (a combination is a type error; at runtime only the
         * first, in that order, applies and a warning is logged).
         *
         * **Decisions** (every matching handler runs; the last decision wins):
         * - `replaceResponse`: synthesize the response (a mock); the network is
         *   never contacted. The mock still goes through `onResponseHeaders`
         *   and `onResponseBody`. On Chromium's `"extension"` strategy it is
         *   served as a data-URL redirect, so only status 200 is possible there.
         * - `redirect`: continue at another URL.
         * - `block`: fail the request.
         * - `allow`: undo an earlier decision: the request goes to the network.
         *
         * **Not a decision:** `{ headers }` stacks; returning nothing keeps the
         * earlier decision.
         *
         * A handler that throws is logged and skipped: the next one runs.
         *
         * @param route Where it applies: see {@link TangiTweak.RouteOptions}.
         * @param handler Called once per matching request with its context.
         *
         * @example
         * // answer an endpoint without the network
         * tweak.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => ({
         *     replaceResponse: { body: { id: Number(ctx.groups.id), name: "Mock" } },
         * }));
         *
         * @example
         * // add a header to every POST, on the debugger
         * tweak.onRequest({ url: "*://example.com/*", methods: ["POST"], strategy: "debugger" }, () => ({
         *     headers: { set: { "x-debug": "1" } },
         * }));
         */
        onRequest(route: TangiTweak.RouteOptions, handler: (ctx: TangiTweak.RequestCtx) => TangiTweak.Awaitable<TangiTweak.RequestResult | void>): void;

        /**
         * Inspect / modify response headers. **All** matching handlers run.
         * Not available on the `"page"` strategy (the page can't change headers
         * before the browser enforces them).
         *
         * @param route Where it applies: see {@link TangiTweak.RouteOptions}.
         * @param handler Called when the response headers arrive.
         *
         * @example
         * tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
         *     headers: {
         *         set: { "access-control-allow-origin": "*" },
         *         remove: ["content-security-policy"],
         *     },
         * }));
         */
        onResponseHeaders(
            route: TangiTweak.RouteOptions,
            handler: (ctx: TangiTweak.ResponseHeaderCtx) => TangiTweak.Awaitable<TangiTweak.ResponseHeaderResult | void>
        ): void;

        /**
         * Transform the response body: receives the original body and returns
         * the new one. Matching transforms compose in order.
         *
         * The handler gets text bodies (a string) only, unless its route sets
         * `binary: true` (binary bodies such as images and video only, as a
         * `Uint8Array`) or `binary: "both"`. `binary: false` keeps text only
         * and silences the "body is binary" warning. Which Content-Types are
         * text: `settings.textTypes`.
         *
         * Needs a strategy that reads bodies: `"helper"`, `"debugger"`, `"page"`
         * (page fetch/XHR only) or `"extension"` on Firefox. Chromium's
         * `"extension"` strategy can't read bodies: the handler doesn't run there and
         * the Log view says so.
         *
         * @param route Where it applies: see {@link TangiTweak.RouteOptions}.
         * @param transform Receives the context and the original body; returns
         * the new body, or nothing (`undefined` / `null`) to leave it as it is.
         * Any body returned counts as a change, even the same one: it's
         * re-encoded and served in place of the original.
         *
         * @example
         * tweak.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "helper" }, (ctx, body) => {
         *     return body.replace("DEBUG=false", "DEBUG=true");
         * });
         * @example
         * // binary: true, to swap an image
         * tweak.onResponseBody({ url: "*://example.com/logo.png", binary: true, strategy: "helper" }, async (ctx, body) => {
         *     const res = await fetch("https://example.org/other.png");
         *     return new Uint8Array(await res.arrayBuffer());
         * });
         */
        onResponseBody(
            route: TangiTweak.BodyRouteOptions & {
                /** Unset or `false`: text bodies only, as a string. */
                binary?: false;
            },
            transform: (ctx: TangiTweak.BodyCtx, body: string) => TangiTweak.Awaitable<string | Uint8Array | void>
        ): void;
        onResponseBody(
            route: TangiTweak.BodyRouteOptions & {
                /** Binary bodies only, as a `Uint8Array`. */
                binary: true;
            },
            transform: (ctx: TangiTweak.BodyCtx, body: Uint8Array) => TangiTweak.Awaitable<string | Uint8Array | void>
        ): void;
        onResponseBody(
            route: TangiTweak.BodyRouteOptions,
            transform: (ctx: TangiTweak.BodyCtx, body: string | Uint8Array) => TangiTweak.Awaitable<string | Uint8Array | void>
        ): void;

        /**
         * Run a handler in the **site's own JavaScript world**: it reads the
         * site's globals (`window.myApp`, its Redux store) directly. The site
         * can see and tamper with it, so it's untrusted: no stores, and it
         * can't call handles. Return functions for the script's `onPage` and
         * `onOverlay` code to call ({@link TangiTweak.Remote}).
         *
         * Runs once per document load in every frame whose URL matches the
         * route, by default before the site's own scripts (`when:
         * "document_start"`; `document.body` is usually `null` then). See
         * {@link TangiTweak.DocumentOptions.when} for timing and
         * {@link TangiTweak.PageRoute} for the three places. On Chrome (MV3) it
         * runs through user scripts, which must be turned on (the Editor shows
         * how).
         *
         * @example
         * const site = tweak.onSite("*://example.com/*", () => ({
         *     user: () => (window as any).myApp?.user?.name as string | undefined,
         *     dispatch: (action: { type: string }) => (window as any).__store.dispatch(action),
         * }));
         */
        onSite<T = void>(route: TangiTweak.PageRoute, handler: (ctx: TangiTweak.SiteCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

        /**
         * Run a handler in the page: the resilient way to change titles, text
         * and DOM content. Works no matter how the response arrived
         * (service-worker-served HTML, cached pages, hydration). Strategies
         * don't apply.
         *
         * Runs once per document load in every frame whose URL matches the
         * route, by default at `DOMContentLoaded` (`when: "document_end"`), in
         * an isolated world that shares the page's DOM but not its JavaScript.
         * It's trusted: it has the script's stores and calls its handles
         * (read the site's globals through a {@link onSite} handle, draw on the
         * overlay through an {@link onOverlay} one, top frame). On Chrome
         * (MV3) it runs through user scripts, which must be turned on (the
         * Editor shows how).
         *
         * The handler may return an object of functions, for the script's
         * other `onPage` and `onOverlay` code to call ({@link TangiTweak.Remote}).
         *
         * @param route Frame URL pattern(s), or `{ url, exclude, when }`. See
         * {@link TangiTweak.DocumentOptions.when} for exact timing, the MV3
         * `document_start` race, SPA/re-render behavior and live-update re-runs.
         * @param handler Receives the same `ctx` shape as `onRequest` (`url` is
         * the frame's URL). May be async (not awaited).
         *
         * @example
         * tweak.onPage("*://example.com/*", () => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // read the site's state through an onSite handle
         * const site = tweak.onSite("*://example.com/*", () => ({ user: () => (window as any).myApp?.user?.name }));
         * const state = tweak.pageStore({ user: "" });
         * tweak.onPage("*://example.com/*", async () => {
         *     const u = await site.user();
         *     if (typeof u === "string") state.user = u;
         * });
         */
        onPage<T = void>(route: TangiTweak.PageRoute, handler: (ctx: TangiTweak.PageCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

        /**
         * Draw this script's **overlay**: a transparent frame over the page
         * (top frame only) with its own `window` and `document`, which the
         * site can't see or reach. What it draws is visible and clickable;
         * everywhere else, clicks go through to the page. It has the script's
         * stores, `fetch`es as the page, calls the script's `onSite` and
         * `onPage` handles, and the Editor's Preview shows it. All of the
         * script's matching overlay handlers run in it, sharing top-level
         * variables.
         *
         * By default the frame is a TangiTweak extension page, which isolates
         * the overlay from the site's CSP and scripts. Chrome blocks other
         * debugger extensions (such as Playwriter) from attaching while a
         * foreign extension iframe is in the tab. Pass `debuggerSafe: true` in
         * the route options to opt into rendering inside a fixed closed shadow
         * root in the isolated world so debugger extensions can attach without
         * removing the overlay.
         *
         * @param route Page URL pattern(s), or `{ url, exclude, when, debuggerSafe }`.
         * @param handler Draws the GUI. May return functions for this script's
         * onPage code to call.
         *
         * @example
         * tweak.onOverlay("*://example.com/*", () => {
         *     const b = document.body.appendChild(document.createElement("button"));
         *     b.textContent = "Hi";
         *     b.style.cssText = "position:fixed;right:16px;bottom:16px";
         * });
         */
        onOverlay<T = void>(route: TangiTweak.OverlayRoute, handler: (ctx: TangiTweak.OverlayCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

        /**
         * Replace a matching website in place with your own full-viewport app
         * while keeping the real URL in the address bar and authenticated
         * access to the origin's cookies, `fetch`, `localStorage`,
         * `sessionStorage` and `indexedDB` via `ctx.origin` and `tweak.fetch`.
         *
         * Matching documents are silenced via a DNR `Content-Security-Policy`
         * header so the original site's scripts, styles and media do not run.
         * Users can switch any tab between the custom site and the original
         * site in one click from the popup. Pass `debuggerSafe: true` to host
         * the custom site in a sandboxed `srcdoc` iframe unlocked by a
         * per-session CSP nonce so external debugger extensions (such as
         * Playwriter) can attach without removing it.
         *
         * @param route Page URL pattern(s), or `{ url, exclude, defaultMode, debuggerSafe }`.
         * @param handler Renders the custom site. Receives {@link TangiTweak.SiteAppCtx}.
         *
         * @example
         * tweak.site({ url: "https://example.com/*", exclude: ["https://example.com/login*"] }, (ctx) => {
         *     ctx.setTitle("My Custom Site");
         *     ctx.mount(document.body, <h1>Hello from {ctx.location.pathname}</h1>);
         * });
         */
        site<T = void>(route: TangiTweak.SiteRoute, handler: (ctx: TangiTweak.SiteAppCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

        /**
         * Declare adjustable parameters, editable from the popup's ⚙ dialog,
         * the Editor and settings.json without touching the script. Returns
         * the current values (stored values over your defaults), typed from
         * your defs. Routes may be built from them: a change re-runs the
         * script. Libraries may declare params too (listed in the popup; one
         * that registers handlers only for some value becomes a script then).
         * Definitions may come from an import (`{ env: envParam }`, `{ ...defs }`).
         *
         * The values can be changed, like a valtio proxy: assign one
         * (`cfg.enabled = false`) or change a list in place
         * (`cfg.hosts.push("a.com")`) from a handler: onPage, onOverlay or
         * network code, not onSite code and not the top level. The value is
         * checked against its type (a wrong one throws), seen right away, and
         * saved like a ⚙ change: logged, written to settings.json, and the
         * script hot-reloads with it. A param with `parse` can't be assigned.
         *
         * @param defs Parameter name → definition (`type`, `default`, optional
         *   `description` and `parse`; see {@link TangiTweak.ParamDef}), or a
         *   nested section object ({@link TangiTweak.ParamGroup}) grouping
         *   related parameters in the popup and settings.json. With `parse`, the
         *   param's value is the parser's result (raw value in, e.g. a `URL` out)
         *   while the stored/edited value stays raw.
         * @returns The current values, typed from `defs`.
         *
         * @example
         * const cfg = tweak.params({
         *     enabled: { type: "boolean", default: true, description: "Return errors" },
         *     network: {
         *         status: { type: "enum", choices: ["500", "503"], default: "500" },
         *         hosts: { type: "stringList", default: ["staging.example.com"] },
         *     },
         * });
         *
         * tweak.onRequest({ url: cfg.network.hosts.map((h) => `*://${h}/api/*`), strategy: "helper" }, () => {
         *     if (cfg.enabled) return { replaceResponse: { status: Number(cfg.network.status), body: { error: "forced" } } };
         * });
         *
         * @example
         * // a page button turns the mock off and on (saved, the script re-runs)
         * tweak.onOverlay("*://app.example.com/*", (ctx) => {
         *     const btn = ctx.once("btn", () => document.body.appendChild(document.createElement("button")));
         *     btn.textContent = cfg.enabled ? "Mock: on" : "Mock: off";
         *     btn.onclick = () => (cfg.enabled = !cfg.enabled);
         * });
         *
         * @example
         * // parse: the script gets a URL (cfg.origin: URL), the ⚙ dialog edits the string
         * const cfg = tweak.params({
         *     origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
         * });
         * tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
         *     headers: { set: { "access-control-allow-origin": cfg.origin.origin } },
         * }));
         */
        params<const T extends TangiTweak.ParamGroup>(defs: T): TangiTweak.ParamsOf<T>;

        /**
         * Per-script key/value storage (async, persistent): see
         * {@link TangiTweak.Storage}. It works in network handlers, `onPage`,
         * `onOverlay` and `onSite` code, all reaching the same copy in the
         * background. In `onSite` code the site can see the values and send
         * its own `get`/`set` calls, so keep secrets out of a script with
         * `onSite` handlers.
         *
         * @example
         * tweak.onRequest({ url: "*://example.com/*", strategy: "helper" }, async () => {
         *     const hits = ((await tweak.storage.get("hits")) ?? 0) + 1;
         *     await tweak.storage.set("hits", hits);
         * });
         */
        storage: TangiTweak.Storage;

        /**
         * Reactive [valtio](https://valtio.dev) store shared across the entire browser.
         *
         * - **Lifetime:** One copy across all tabs and pages. Survives reloads,
         *   navigations, closing tabs and script saves; by default (`persist: true`
         *   or `persist: ["field"]`) also browser restarts (saved in the tweak's `.tweak/stores/<id>.json`).
         *   With `{ persist: false }`, resets when the browser quits.
         * - **Handlers:** All network handlers (`rules`, `page`, `debugger`,
         *   `extension`, `helper`, sync and after `await`), `tweak.onPage`,
         *   `tweak.onOverlay`, and top-level/timer code. **Throws in `tweak.onSite`**
         *   (untrusted site world: use {@link siteStore}).
         *
         * Call at top level; values must be JSON (≤ 1 MB).
         *
         * @param id The store's ID, unique in the tweak: lowercase letters,
         *   digits, `-`, `_` and `.` (not first).
         *
         * @example
         * const state = tweak.globalStore("state", { mocking: true, hits: 0 });
         * tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => {
         *     state.hits++;
         *     if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
         * });
         */
        globalStore<T extends object>(id: string, initial: T, opts?: TangiTweak.StoreOptions<T>): T;

        /**
         * Reactive [valtio](https://valtio.dev) store scoped to one browser tab.
         *
         * - **Lifetime:** One copy per browser tab (`tabId`; subframes share their
         *   top tab's copy). **Survives page reloads, cross-page navigations, and
         *   script saves** in that tab; dropped when the tab closes or the browser
         *   quits (never persisted to a store file).
         * - **Handlers:** All network handlers (`rules` included: builds per-tab
         *   `tabIds` / `excludedTabIds` session rules on change; on `page`,
         *   `debugger`, `extension`, and `helper`, **read/write synchronously before
         *   the first `await`**), `tweak.onPage`, and `tweak.onOverlay`. **Throws in
         *   `tweak.onSite`** and when read at top level or in background timers.
         *
         * @example
         * const tab = tweak.tabStore({ staging: false });
         * tweak.onRequest({ url: "https://api.example.com/*", strategy: "rules" }, (ctx) =>
         *     tab.staging ? { redirect: `https://staging-api.example.com/${ctx.groups["0"]}` } : undefined,
         * );
         * tweak.onOverlay("https://example.com/*", () => {
         *     // toggle tab.staging, then refresh: this tab's requests redirect from the start
         * });
         */
        tabStore<T extends object>(initial: T): T;

        /**
         * Reactive [valtio](https://valtio.dev) store scoped to a single page document load.
         *
         * - **Lifetime:** One copy per top-frame document (subframes share their top
         *   page's copy). Survives SPA route changes and script saves; **resets to
         *   `initial` on reload or cross-document navigation**, and drops when the
         *   page unloads or the tab closes (never persisted to a store file).
         * - **Handlers:** Network handlers on `page`, `debugger`, `extension`, and
         *   `helper` (**synchronously before the first `await`**; pageless requests
         *   get a throwaway copy of `initial`), `tweak.onPage`, and `tweak.onOverlay`.
         *   **Throws in `strategy: "rules"`** (use {@link tabStore} for per-tab
         *   rules), **`tweak.onSite`**, and top-level/timer code.
         *
         * @example
         * const page = tweak.pageStore({ staging: false });
         * tweak.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
         *     if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
         * });
         * tweak.onOverlay("https://example.com/*", () => {
         *     // a checkbox bound to page.staging (useSnapshot(page) from "valtio")
         * });
         */
        pageStore<T extends object>(initial: T): T;

        /**
         * Reactive [valtio](https://valtio.dev) store living in the site's own JavaScript world.
         *
         * - **Lifetime:** One copy per page JS world. Survives SPA route changes and
         *   hot script saves; **resets to `initial` on reload or navigation**, and
         *   disappears when the document unloads (never persisted).
         * - **Handlers:** `tweak.onSite` (direct synchronous access), `tweak.onPage` (live
         *   mirror), and `tweak.onOverlay` (live mirror of the top frame's copy).
         *   **Throws in all network handlers** (`onRequest`,
         *   `onResponseHeaders`, `onResponseBody` on every strategy) and inside
         *   imported libraries.
         * - **Trust:** Untrusted page data: the site's own scripts can read, mutate,
         *   or forge its values. Keep private/trusted state in {@link globalStore},
         *   {@link tabStore}, or {@link pageStore}.
         *
         * @example
         * const flags = tweak.siteStore({ loggedIn: false, mock: false });
         * tweak.onSite("https://example.com/*", () => {
         *     flags.loggedIn = !!document.cookie.match(/session=/);
         *     if (flags.mock) (window as any).__MOCK__ = true;
         * });
         * tweak.onOverlay("https://example.com/*", () => {
         *     // a checkbox bound to flags.mock (useSnapshot(flags) from "valtio")
         * });
         */
        siteStore<T extends object>(initial: T): T;

        /**
         * `fetch` for scripts. By default it runs in the background with the
         * extension's host permissions (no CORS) and the browser's cookies
         * (`credentials` defaults to `"include"`) and returns a normal
         * `Response`. `bypass: true` keeps every script's handlers (this
         * one's too) off the request, e.g. to get the real response a mock
         * replaces; the Log lists it as a `bypass`.
         *
         * - The URL must be absolute for a background fetch (a `TypeError`
         *   otherwise); `onPage` code and `from: "page"` resolve relative
         *   URLs against the page.
         * - Request and response bodies are capped at 10 MB each (a
         *   `RangeError` past it).
         * - `init.signal` is ignored: an abort can't reach the background.
         * - In `onPage` code it reaches only the hosts in package.json's
         *   `"tangitweak.connect"` and their subdomains (the page's process
         *   runs that code, so it can't send the background anywhere else);
         *   any other host rejects, naming the host to add.
         * - In `onSite` code it rejects: use the page's `fetch`.
         *
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#tweakfetch
         * @example
         * const real = await (await tweak.fetch("https://api.example.com/user", { bypass: true })).json();
         */
        fetch(input: string | URL | Request, init?: TangiTweak.FetchInit): Promise<Response>;

        /**
         * Run `handler` on a schedule, in the background, also while no tab
         * is open: usually to `tweak.fetch` something and compare it with
         * last time (kept in a {@link globalStore}). Call at top level.
         *
         * - `interval` is a {@link TangiTweak.Duration}, at least `"1m"`
         *   (shorter is raised to 1 minute with a warning in Problems).
         * - Or a function that returns one, or `false` to unschedule. It
         *   runs again whenever a store it read changes, so the UI or page
         *   code can turn polling on and off by changing a store.
         * - A run that's overdue when the browser starts runs once, with
         *   `ctx.reason` `"startup"`. Runs never overlap.
         * - A run gets 60 s and up to 20 `tweak.fetch` calls. After 5
         *   failures in a row the interval doubles, up to 1 day, until a run
         *   works again.
         * - In a packaged tweak `tweak.fetch` reaches only the hosts in
         *   package.json's `"tangitweak.connect"`.
         * - The Editor's **Schedules** list shows each one with **Run now**
         *   and **Pause**. A pause is the user's: the tweak can't undo it.
         *
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#tweakevery
         * @example
         * const seen = tweak.globalStore("seen", { tag: "" });
         * tweak.every("1h", async (ctx) => {
         *     const r = await tweak.fetch("https://api.github.com/repos/owner/repo/releases/latest");
         *     const { tag_name, html_url } = await r.json();
         *     if (seen.tag && tag_name !== seen.tag) tweak.toast({ title: `${tag_name} is out`, url: html_url });
         *     seen.tag = tag_name;
         * });
         */
        every(interval: TangiTweak.Duration | (() => TangiTweak.Duration | false | null | undefined), handler: (ctx: TangiTweak.EveryCtx) => TangiTweak.Awaitable<void>): void;

        /**
         * Show a toast: a small card that pops up inside the tab, on top of
         * the page. It isn't a system notification and needs no permission.
         * Toasts from all tweaks stack in the corners of the tab, each with
         * its own look and a "from <tweak>" line.
         *
         * - Call it from a handler: an `every`, a network handler, `onPage`
         *   or `onOverlay` code (not at top level; in `onSite` it rejects).
         * - With no tab to show it, it waits up to `ttl` and shows when one
         *   connects. In a background tab the title flashes and the icon
         *   gets a dot until the user comes back.
         * - Each tweak may show 1 new toast every 10 s and 20 an hour;
         *   updating one with the same `id` doesn't count. The user can mute
         *   a tweak's toasts from the popup.
         *
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#tweaktoast
         * @example
         * tweak.toast("Saved");
         * tweak.toast({ kind: "success", title: "Back in stock", url: "https://shop.example.com/item/42", actions: [{ id: "buy", label: "Buy now" }] });
         */
        toast(message: string | TangiTweak.ToastOptions): Promise<TangiTweak.ToastResult>;

        /**
         * Set the look of this tweak's toasts (only this tweak's). Call at
         * top level. Several calls merge, later keys win; each toast's own
         * `style` goes on top.
         *
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#toast-styles
         * @example
         * tweak.toastStyle({ accent: "#e8590c", radius: 4, dark: { background: "#1b1b1f" } });
         */
        toastStyle(style: TangiTweak.ToastStyle): void;

        /**
         * Handle clicks on this tweak's toasts: a button (its `id`), the card
         * itself (`"click"`, when it has a `url`) or the close button
         * (`"close"`). Call at top level. It runs in the background, also
         * after the browser restarted the extension.
         *
         * @example
         * tweak.onToastAction(({ toastId, actionId }) => {
         *     if (actionId === "snooze") snoozed.until = Date.now() + 3_600_000;
         * });
         */
        onToastAction(handler: (event: TangiTweak.ToastEvent) => TangiTweak.Awaitable<void>): void;

        /**
         * Register a pane: a React component that draws the inside of a
         * toast, picked per toast with `tweak.toast({ pane: name, data })`.
         * Call at top level. TangiTweak keeps the corner, the stacking, the
         * timer and the "from <tweak>" line; the pane gets up to 480 × 480
         * px. When it can't be drawn the toast shows its `title` and
         * `message` instead.
         *
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#toast-panes
         * @example
         * tweak.toastPane<{ price: number }>("price", (t, ui) => (
         *     <div>Now {t.data.price} € <button onClick={() => ui.action("buy")}>Buy</button></div>
         * ), { sample: { price: 12 } });
         */
        toastPane<T = unknown>(
            name: string,
            render: (toast: TangiTweak.PaneToast<T>, ui: TangiTweak.PaneUi) => unknown,
            opts?: {
                /** Data for the Editor's Preview > Toasts list. */
                sample?: T;
            },
        ): void;

        /**
         * Write an info line to the Editor's Log view, tagged with this
         * script's name (`[name] tweak.log: …`). Lines from page code are
         * tied to its tab; lines from network handlers and top-level code
         * aren't tied to a tab.
         *
         * The arguments are joined with spaces: strings as they are, errors
         * as their stack, functions as `[function name]` and anything else
         * as JSON (or `String()` when it can't be). A line is cut at 4000
         * characters. The script's `console.*` calls reach the Log too.
         *
         * @example
         * tweak.log("request to", ctx.url, { method: ctx.method });
         */
        log(...args: unknown[]): void;

        /**
         * `true` in Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Opera…).
         * Always the opposite of {@link isFirefox}.
         *
         * @example
         * tweak.onResponseBody({ url: "*://example.com/app.js", strategy: tweak.isFirefox ? "extension" : "helper" }, (ctx, body) => body.replace("DEBUG=false", "DEBUG=true"));
         */
        readonly isChrome: boolean;

        /** `true` in Firefox. Always the opposite of {@link isChrome}. */
        readonly isFirefox: boolean;

        /**
         * `true` in the Manifest V2 build (`dist/`: Firefox, and Chromium browsers
         * that still load MV2 extensions). Always the opposite of {@link isMV3}.
         */
        readonly isMV2: boolean;

        /**
         * `true` in the Manifest V3 build (`dist-mv3/`: current Chrome / Edge),
         * where the `extension` strategy isn't available.
         *
         * @example
         * tweak.onRequest({ url: "*://api.example.com/*", strategy: tweak.isMV3 ? "debugger" : "extension" }, fn);
         */
        readonly isMV3: boolean;

        /**
         * `true` on macOS. At most one of `isMac`, {@link isWindows} and
         * {@link isLinux} is `true`; on Android and ChromeOS none is.
         *
         * @example
         * ctx.shortcut(tweak.isMac ? "Meta+Shift+P" : "Ctrl+Shift+P", openPalette);
         */
        readonly isMac: boolean;

        /** `true` on Windows. See {@link isMac}. */
        readonly isWindows: boolean;

        /** `true` on desktop Linux (not Android or ChromeOS). See {@link isMac}. */
        readonly isLinux: boolean;
    }
}

/**
 * The TangiTweak API. Everything a bundle's files register belongs to
 * its tweak. Each file gets its own `tweak` object, so handlers are known
 * by their order in their file ("the 2nd `onPage`"), and tab/page/site
 * stores by their order among that file's `tabStore` / `pageStore` /
 * `siteStore` calls.
 */
declare module "tangitweak" {
    /**
     * This file's `tweak` object: see {@link TangiTweak.Tweak}. Outside the
     * browser (the SDK's own `index.js`, in plain Vitest tests) it's a
     * stand-in: handlers are recorded but never called, params return their
     * defaults and stores are plain valtio objects.
     *
     * @example
     * import { tweak } from "tangitweak";
     * tweak.onPage("*://example.com/*", () => { document.title = "🎯 " + document.title; });
     */
    export const tweak: TangiTweak.Tweak;
}

/**
 * An `.svg` data file imports as its markup, a string:
 * `import logo from "./icons/logo.svg"; el.innerHTML = logo;`
 */
declare module "*.svg" {
    /** The file's SVG markup (`'<svg …>…</svg>'`), e.g. for `innerHTML`. */
    const markup: string;
    export default markup;
}

/**
 * A `.md` data file imports as its Markdown text, a string:
 * `import readme from "./README.md";`
 */
declare module "*.md" {
    /** The file's Markdown source text. */
    const markdown: string;
    export default markdown;
}

/**
 * Image data files import as their `data:image/...;base64,...` URL:
 * `import icon from "./icon.png"; img.src = icon;`
 */
declare module "*.png" {
    /** The image as a `data:image/png;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.jpg` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.jpg" {
    /** The image as a `data:image/jpeg;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.jpeg` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.jpeg" {
    /** The image as a `data:image/jpeg;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.gif` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.gif" {
    /** The image as a `data:image/gif;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.webp` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.webp" {
    /** The image as a `data:image/webp;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.ico` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.ico" {
    /** The image as a `data:image/x-icon;base64,…` URL. */
    const url: string;
    export default url;
}
/** A `.avif` data file imports as its `data:` URL (see the `.png` module). */
declare module "*.avif" {
    /** The image as a `data:image/avif;base64,…` URL. */
    const url: string;
    export default url;
}
