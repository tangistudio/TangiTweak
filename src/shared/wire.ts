/**
 * The message protocol every TangiTweak link speaks: one envelope shape,
 * typed ops, requests with answers and timeouts and one-way pushes.
 *
 * ## Links
 *
 * The background holds the one true state of every script's stores (the
 * owner, `background/engine/storeOwner.ts`) and does what page code may not
 * (fetch from the extension, read `tweak.storage`, save params). Everything
 * else reaches it over a link, each named by a number used across the code:
 *
 * - **L1: owner ⇄ script instance.** The contexts that compile every
 *   script (background code, network handlers) hold store replicas
 *   (`shared/storeReplica.ts`) and use the background's `tweak.fetch`. MV3:
 *   the sandbox ⇄ offscreen document ⇄ `chrome.runtime` messages ⇄ the
 *   service worker (`background/sandbox.ts`, `background/engine/stores.ts`).
 *   MV2: the background page compiles the scripts itself, so its replicas
 *   reach the owner through an {@link endpointPair}.
 * - **L2: owner ⇄ bridge.** Each frame's bridge content script
 *   (`hook/bridge.ts`) opens a `tt-bridge` port
 *   (`background/engine/bridgePorts.ts`). It hears `bundle.update`, relays
 *   its overlays' store ops, fetches and calls and (MV2/Firefox) those of
 *   the isolated onPage code it runs. The background trusts a bridge only
 *   as far as its frame: each op names a script `s` that must have been
 *   granted there (`background/engine/overlayLinks.ts`).
 * - **L3: bridge ⇄ overlay.** A top-frame bridge frames each script's
 *   `tweak.onOverlay` GUI (`overlay/overlayRuntime.ts`) and hands it a
 *   `MessagePort`. The frame proves itself with `hello`, then reaches its
 *   stores, `tweak.fetch`, `tweak.storage` and params through the bridge;
 *   the bridge fetches as the page, matches its shortcuts and clips the
 *   frame to the areas it draws.
 * - **L4: hook ⇄ bridge.** Plain `window.postMessage`, not this protocol.
 * - **L5: Editor ⇄ owner.** The Editor's Preview tab (`ui/state/preview.ts`)
 *   opens a `tt-preview` port, gets one script granted with `preview.open`
 *   and then hosts that script's overlay frame the way a bridge does (L3
 *   between the Editor and its frame).
 * - **L6: isolated world ⇄ owner (Chrome MV3).** A script's onPage code
 *   runs in a `chrome.userScripts` world (`hook/isolated.ts`) that opens a
 *   `tt-user-script` port, binds it to its script with `iso.load` and gets
 *   its stores, Log, `tweak.storage` and (top frame) calls to and from its
 *   overlay, which the owner relays through the tab's top-frame bridge.
 *
 * `tangitweak/test` stands in for the bridge and the background with
 * {@link endpointPair}s, so tests run the same ops in one process.
 *
 * ## Messages
 *
 * Every message is an {@link Envelope} or an array of them (a batch).
 * Ops are declared once in {@link WireOps}: those with `req`/`res` are calls
 * ({@link Endpoint.call} → {@link Endpoint.handle}), those with `push` are
 * one-way ({@link Endpoint.push} → {@link Endpoint.on}). An envelope's `s`
 * says which script (or store tag) the op is about; a link that serves many
 * scripts checks it against what it granted and refuses or drops the rest.
 *
 * A call waits {@link WIRE_TIMEOUT_MS} for its answer (or
 * {@link EndpointOptions.timeoutMs}), then rejects with a `TimeoutError`;
 * closing the link rejects it with a `DisconnectedError`; a handler's throw
 * comes back as an error with the same `name` and `message`. Pushes are
 * fire-and-forget: nothing says whether anyone listened. On one endpoint,
 * messages leave in the order they're sent, even with
 * {@link EndpointOptions.batchMs}.
 *
 * ## Carriers
 *
 * An {@link Endpoint} is one side of one link. It only needs a `send`
 * function; whatever carries the messages calls {@link Endpoint.receive}
 * with what arrives. The adapters at the end wire the usual carriers:
 *
 * - {@link portEndpoint}: a `chrome.runtime` port. Port messages are JSON,
 *   so every `Uint8Array` (fetch bodies) is packed as `{ __ttBytes:
 *   "<base64>" }` on the way out and unpacked on the way in
 *   (`shared/bytesPack.ts`). The port disconnecting closes the endpoint.
 * - {@link messagePortEndpoint}: a `MessagePort` (structured clone, so bytes
 *   travel as they are).
 * - {@link endpointPair}: two endpoints in one context (the MV2 background,
 *   the owner's per-context links, tests).
 *
 * Bodies are capped at {@link FETCH_MAX_BYTES} (`shared/ttFetch.ts`).
 *
 * @module
 */

import { packBytes, unpackBytes } from "./bytesPack";
import type { RouteMeta } from "./route";
import type { ShippedLib } from "./scriptImports";
import type { RpcCall, RpcResult } from "./rpc";
import type { SiteDown, SiteUp } from "./siteStoreHost";
import type { ToastPosition, ToastResult, ToastSpec, ToastView } from "./toast";

/** A JSON value: what store data, store ops and most op arguments are made of. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * One store mutation: a path of keys and array indexes from the store's
 * root, set to a value (`"set"`) or deleted (`"del"`).
 */
export type StoreOp = ["set", (string | number)[], Json] | ["del", (string | number)[]];

/**
 * Which top-level fields of a store persist across browser restarts:
 * `true` for all of them, `false` for none or the names of the ones that do.
 */
export type StorePersist = boolean | string[];

/**
 * A `tweak.fetch` request as it crosses a link, with its body read into
 * bytes. `shared/ttFetch.ts` builds it from a `Request` and back.
 */
export interface WireRequest {
    /** The absolute URL to fetch. */
    url: string;
    /** The HTTP method. */
    method: string;
    /** The request headers as name/value pairs, in order (a name may repeat). */
    headers: [string, string][];
    /** The request body, at most {@link FETCH_MAX_BYTES}. Absent for a request without one. */
    body?: Uint8Array;
    /** The request's `credentials` mode, when set. */
    credentials?: RequestCredentials;
    /** The request's `redirect` mode, when set. */
    redirect?: RequestRedirect;
    /** The request's `cache` mode, when set. */
    cache?: RequestCache;
    /** The request's `referrer`, when set. */
    referrer?: string;
    /** The request's `referrerPolicy`, when set. */
    referrerPolicy?: ReferrerPolicy;
}

/**
 * A `tweak.fetch` response as it crosses a link, with its whole body read
 * into bytes.
 */
export interface WireResponse {
    /** The HTTP status code. */
    status: number;
    /** The HTTP status text. */
    statusText: string;
    /** The final URL, after redirects. */
    url: string;
    /** The response headers as name/value pairs, in order. */
    headers: [string, string][];
    /** The response body, at most {@link FETCH_MAX_BYTES}. */
    body: Uint8Array;
}

/** A store's state as the owner holds it, at one revision. */
export interface StoreSnapshot {
    /** The store's revision: 0 when the owner creates or loads it, plus one for every change it commits. */
    rev: number;
    /** The store's data at that revision. */
    data: Json;
}

/**
 * Every op, declared once: `req`/`res` for calls, `push` for one-way
 * messages. {@link Endpoint.call}, {@link Endpoint.push},
 * {@link Endpoint.handle} and {@link Endpoint.on} are typed over it.
 *
 * Each entry says which link it travels (L1 to L6, see the module
 * overview), who sends it and who handles it. `s` is the envelope's script
 * id (see {@link Envelope}); a relay that serves several scripts passes it
 * on or rewrites it.
 */
export interface WireOps {
    /**
     * A script declared a store. Its {@link StoreReplica} hub sends it when
     * a script calls `tweak.globalStore`, `tweak.pageStore` or
     * `tweak.tabStore` and again after every reconnect and recompile. The
     * owner (`storeOwner.ts`) creates the store or merges the fields it
     * lacks from `initial` and commits them as a `store.patch`. Bridges, the
     * Editor preview and the owner's overlay links pass it on for the
     * scripts they granted.
     */
    "store.declare": {
        push: {
            /** The store's id, unique in the script. */
            name: string;
            /** The initial value: the JSON part of a global store's or the template every page or tab copy starts from. */
            initial: Json;
            /** Which fields persist. Always `false` for page and tab stores. */
            persist: StorePersist;
            /** `"page"` for `tweak.pageStore`, `"tab"` for `tweak.tabStore`, absent for a global store. */
            scope?: "page" | "tab";
        };
    };
    /**
     * A replica subscribes to a store's patches and catches up. Its hub
     * calls it when the replica is created and after a reconnect, a
     * recompile or a gap in the revisions it received. The owner adds the
     * link to the store's subscribers and answers with the snapshot only
     * when the replica's `rev` is stale or missing. A dead page's copy
     * answers with revision 0 and the template. Relays refuse a page that
     * isn't the grant's page or its tab.
     */
    "store.sub": {
        req: {
            /** The store's id. */
            name: string;
            /** The revision the replica holds. Absent before its first sync. */
            rev?: number;
            /** Which copy of a page or tab store: the page key or tab scope key. Absent for a global store. The same on every store op. */
            page?: string;
        };
        res: {
            /** The owner's current revision. */
            rev: number;
            /** The data at `rev`. Absent when the replica already had `rev`. */
            data?: Json;
            /** The ids of recently applied `store.set` ops (at most 256), so the replica can drop the pending ones already in `data`. */
            ops: string[];
        };
    };
    /**
     * A replica's local changes. Its hub sends one per store per microtask
     * of writes and sends still-pending ones again after it resyncs. The
     * owner ignores a duplicate `op` or a dead page's copy, checks the ops
     * and the result's size (`STORE_MAX_BYTES`), then applies them and
     * commits a `store.patch`. A refused set comes back as `store.reject`.
     */
    "store.set": {
        push: {
            /** The store's id. */
            name: string;
            /** This change's id, unique across contexts (`<context>.<random>:<seq>`). The resulting patch carries it back. */
            op: string;
            /** The mutations, in order. */
            ops: StoreOp[];
            /** Which page or tab copy (see `store.sub`). */
            page?: string;
        };
    };
    /**
     * A committed change. The owner sends it to every subscribed link and
     * every link attached with `all` after it applies a `store.set`, merges
     * a `store.declare` or replaces the store's data. Replicas apply patches in revision order:
     * an old one is ignored and a gap makes the replica resync with
     * `store.sub`.
     */
    "store.patch": {
        push: {
            /** The store's id. */
            name: string;
            /** The revision this patch makes. */
            rev: number;
            /** The mutations, in order. */
            ops: StoreOp[];
            /** The `store.set` op it applied, so the replica that sent it drops it from pending. Absent for any other change. */
            op?: string;
            /** Which page or tab copy (see `store.sub`). */
            page?: string;
        };
    };
    /**
     * The owner refused a `store.set`. Sent only to the link the set came
     * from. The replica drops the pending op, logs the reason as an error
     * and shows the owner's data again.
     */
    "store.reject": {
        push: {
            /** The store's id. */
            name: string;
            /** The refused `store.set`'s op id. */
            op: string;
            /** Why it was refused, for the script's Log. */
            reason: string;
            /** Which page or tab copy (see `store.sub`). */
            page?: string;
        };
    };
    /**
     * A page ended (it navigated or its tab closed) and its page store
     * copies are gone. The owner sends it to every subscribed link and every
     * link attached with `all`; replicas delete that page's copies.
     */
    "store.drop": {
        push: {
            /** The page key that ended. */
            page: string;
        };
    };
    /**
     * The current stores of some scripts, to prime a context before their
     * code compiles. The MV3 sandbox calls it over L1 for scripts it hasn't
     * primed yet; the owner answers from `storeOwner.init`. Page and tab
     * copies are keyed `name + "\u0000" + page` (see `storeKey`).
     */
    "store.init": {
        req: {
            /** The script ids to prime. */
            scripts: string[];
        };
        res: { [scriptId: string]: { [name: string]: StoreSnapshot } };
    };
    /**
     * `tweak.fetch(…, { from: "background" })`: fetch from the background,
     * outside any page. Sent by the MV3 sandbox (L1), by an overlay through
     * its bridge (L3 then L2), by MV3 isolated onPage code (L6, where only
     * the script's `"tangitweak.connect"` hosts are reachable) and by the
     * Editor preview's frame (L5). The background answers for script `s`.
     */
    fetch: {
        req: {
            /** The request. */
            request: WireRequest;
            /** True to keep every script's handlers away from it. */
            bypass: boolean;
            /** Unused: no sender sets it and no handler reads it. */
            tabId?: number;
        };
        /** The response, its body read in full. */
        res: WireResponse;
    };
    /**
     * Registers a one-shot bypass (§3.5) so the next matching request in
     * the tab skips every script. A bridge calls it over L2 just before it
     * makes a page fetch with `bypass` for script `s`'s overlay. The
     * background requires an overlay grant and keeps the bypass for 10 s.
     */
    "bypass.add": {
        req: {
            /** Ignored: the bridge sends -1 and the background uses the link's tab. */
            tabId: number;
            /** The request's method, upper case. */
            method: string;
            /** The request's absolute URL. */
            url: string;
        };
        res: {};
    };
    /**
     * Scripts changed. The background pushes it to every bridge (L2) and
     * to the Editor preview (L5) after a recompile. A bridge fetches its
     * bundle again and updates the overlays whose code changed; the preview
     * reloads when its script did.
     */
    "bundle.update": {
        push: {
            /** The scripts and the hash of their code. Bridges get the enabled ones, the preview all of them. */
            scripts: {
                /** The script's id. */
                s: string;
                /** The hash of its code. */
                codeHash: string;
            }[];
        };
    };

    // ---- the overlay (L3: overlay ⇄ bridge; L2 for what the bridge relays) ----
    /**
     * L3: the overlay frame starts. The frame's boot code calls it first,
     * with the nonce from its URL's hash, to prove it's the frame the bridge
     * (or the Editor preview) made. A wrong or repeated nonce closes the link
     * as `"refused"`. The host then asks for `overlay.init` over L2 (or L5)
     * and answers with it, `phase` filled in. A bridge closes a link that
     * doesn't say hello within 15 s.
     */
    hello: {
        req: {
            /** The one-time nonce the host put in the frame's URL. */
            nonce: string;
        };
        /** What the overlay runs, with `phase` filled in. */
        res: OverlayInit;
    };
    /**
     * L2: the bridge is about to frame script `s`'s overlay. A top-frame
     * bridge calls it before it creates the frame and again with a fresh
     * nonce after its link reconnects. The background refuses unless the
     * frame is the top frame, `url` has the port's origin and the script has
     * an overlay there. It then grants the overlay's ops for `s` on this
     * link (`overlay.init`, `store.*`, `fetch`, `bypass.add`). On Firefox
     * the frame first checks its nonce with the background, which accepts
     * it once within 60 s.
     */
    "overlay.open": {
        req: {
            /** The one-time nonce the frame will say hello with (at least 16 characters). */
            nonce: string;
            /** The page's URL, which picks the overlay's routes. */
            url: string;
        };
        res: {};
    };
    /**
     * L2/L5: what script `s`'s overlay runs in this frame. The bridge calls
     * it on `hello` and when the script changes; the Editor preview does the
     * same over L5. Refused unless `s` was granted by `overlay.open` (or
     * `preview.open`) and still has an overlay there. The answer has no
     * `phase`: the host adds it.
     */
    "overlay.init": {
        req: {};
        /** What the overlay runs, without `phase`. */
        res: OverlayInit;
    };
    /**
     * L2: script `s`'s overlay closed or reloaded. The bridge pushes it when
     * it removes the frame; the background drops the grant and the
     * overlay's store link. On Chrome MV3 it also tells the same document's
     * isolated onPage code (L6), whose calls to the overlay then fail.
     */
    "overlay.closed": { push: {} };
    /**
     * L3: the script changed, so recompile in place. The bridge and the
     * Editor preview push it to a running frame with a fresh
     * {@link OverlayInit} (from `overlay.init`). The overlay keeps its old
     * code if the new one fails to compile.
     */
    "overlay.update": {
        /** What the overlay runs now, with `phase` filled in. */
        push: OverlayInit;
    };
    /**
     * L3: `tweak.fetch(…, { from: "page" })` (the default in an overlay) and
     * the overlay's `window.fetch`. The bridge fetches as the page: with the
     * page's cookies (`credentials: "include"` unless the request says
     * otherwise) and the URL resolved against the page's. With `bypass` it
     * first calls `bypass.add`. The Editor preview, which has no page,
     * fetches from the background instead.
     */
    pagefetch: {
        req: {
            /** The request. */
            request: WireRequest;
            /** True to keep every script's handlers away from it. */
            bypass: boolean;
        };
        /** The response, its body read in full. */
        res: WireResponse;
    };
    /**
     * L3: the page reached a `when` phase. The bridge pushes
     * `"document_end"` on `DOMContentLoaded` and `"document_idle"` on
     * `load`; the phase at hello time comes in {@link OverlayInit.phase}.
     * The overlay runs the handlers now due.
     */
    when: {
        push: {
            /** The phase reached. */
            phase: "document_start" | "document_end" | "document_idle";
        };
    };
    /**
     * L3: the overlay's visible areas. The overlay measures what it drew
     * and pushes them when they change; the bridge clips its frame to them
     * so the rest of the page stays clickable.
     */
    rects: {
        push: {
            /** The areas as `[x, y, width, height]` in CSS pixels of the viewport. Empty: nothing to show. */
            rects: [number, number, number, number][];
        };
    };
    /** L3: the user pressed in the overlay. The bridge brings its frame in front of the other overlays. */
    focus: { push: {} };
    /**
     * A line for script `s`'s Log. An overlay pushes its errors, unhandled
     * rejections and console output to its host (L3); the bridge writes them
     * as the overlay's. The Editor preview (L5) and MV3 isolated onPage code
     * (L6) push to the background, which checks the level and cuts the text
     * to 8000 characters.
     */
    log: {
        push: {
            /** The severity. A bridge logs any other value as `"info"`. */
            level: "debug" | "info" | "warn" | "error";
            /** The text. */
            msg: string;
        };
    };
    /**
     * L3: the page navigated in place (history API, hash change). The
     * bridge pushes the new URL; the overlay updates `ctx.url` and runs its
     * navigation handlers.
     */
    nav: {
        push: {
            /** The page's new URL. */
            url: string;
        };
    };
    /**
     * Reads script `s`'s `tweak.storage`. Sent by an overlay (L3, the bridge
     * answers through the background), MV3 isolated onPage code (L6) and the
     * Editor preview (L5), each for its own script only.
     */
    "storage.get": {
        req: {
            /** The key to read. */
            key: string;
        };
        res: {
            /** The stored value. */
            value: any;
        };
    };
    /** Writes script `s`'s `tweak.storage`. Sent and answered like `storage.get`. */
    "storage.set": {
        req: {
            /** The key to write. */
            key: string;
            /** The value to store. */
            value: any;
        };
        res: {};
    };
    /**
     * The code assigned a param, saved like a ⚙ change. Sent like
     * `storage.get` (L3 through the bridge, L6, L5) for script `s` or one of
     * the libraries it imports.
     */
    "param.set": {
        req: {
            /** The param's key. */
            key: string;
            /** The new value. */
            value: any;
            /** The imported library whose param it is. Absent: the script's own. */
            lib?: string;
        };
        res: {};
    };
    /**
     * L3: `ctx.shortcut` registered keys. The overlay pushes it; the bridge
     * listens for the keys in the page (warning in the Log when another
     * overlay's shortcut takes them) and answers presses with
     * `shortcut.fire`.
     */
    "shortcut.add": {
        push: {
            /** The overlay's id for this shortcut (at most 32 characters). */
            id: string;
            /** The key combination (at most 64 characters). */
            keys: string;
            /** `"before-page"`: run first and keep the key from the page. `"after-page"`: run only when the page didn't handle the key. */
            priority: "before-page" | "after-page";
            /** `ctx.shortcut`'s `iframes` option, normalized: also count keys pressed in these iframes of the page. Null or absent: none. */
            iframes?: {
                /** Only iframes this CSS selector matches. Absent: all. */
                selector?: string;
                /** Also iframes inside shadow roots. */
                shadow: boolean;
                /** Also iframes from other sites, watched through `frameKeys.*`. */
                crossOrigin: boolean;
            } | null;
        };
    };
    /** L3: the overlay dropped a shortcut. */
    "shortcut.remove": {
        push: {
            /** The id it was added with. */
            id: string;
        };
    };
    /** L3: a shortcut's keys were pressed in the page. The bridge brings the overlay to the front and pushes it; the overlay runs the shortcut's function. */
    "shortcut.fire": {
        push: {
            /** The id it was added with. */
            id: string;
        };
    };

    // ---- shortcuts in cross-origin iframes (shared/frameKeys.ts; L2 bridges and L6 isolated links) ----
    /**
     * A parent frame offers to watch keys in a child frame. Its bridge (L2)
     * or MV3 isolated code (L6) calls it, then posts `token` into the
     * iframe. The background keeps the offer until it's withdrawn or the
     * link closes.
     */
    "frameKeys.offer": {
        req: {
            /** A random 32-hex-digit token naming this offer. */
            token: string;
            /** The key combination to watch. */
            keys: string;
            /** The shortcut's priority (see `shortcut.add`). */
            priority: "before-page" | "after-page";
            /** Firefox: the child's frameId as the parent read it. Absent: the background checks the frame tree instead. */
            child?: number;
        };
        res: {};
    };
    /** A parent frame's shortcut or iframe is gone. The parent pushes it; the background drops the offer and tells the child to stop. */
    "frameKeys.withdraw": {
        push: {
            /** The offer's token. */
            token: string;
        };
    };
    /**
     * L2: a child frame's bridge received a token posted by its parent. The
     * background checks the child sits under the offering frame, then
     * answers with `frameKeys.watch`.
     */
    "frameKeys.claim": {
        push: {
            /** The token the parent posted. */
            token: string;
        };
    };
    /** L2: the background tells a child frame's bridge to watch keys for a checked claim. */
    "frameKeys.watch": {
        push: {
            /** The claimed token. */
            token: string;
            /** The key combination to watch. */
            keys: string;
            /** The shortcut's priority. */
            priority: "before-page" | "after-page";
        };
    };
    /** L2: the background tells a child frame's bridge to stop watching (the offer was withdrawn or claimed by another frame). */
    "frameKeys.unwatch": {
        push: {
            /** The token to stop watching. */
            token: string;
        };
    };
    /** The keys were pressed in the child. The child's bridge pushes it to the background, which pushes it on to the parent's link; the parent runs the shortcut. */
    "frameKeys.hit": {
        push: {
            /** The offer's token. */
            token: string;
        };
    };
    /** L3: the overlay's `tweak.siteStore` mirrors write to the site's world. The bridge passes on the overlay's own script's messages to the page's hook. */
    "site.up": {
        /** A mirror connecting, writing or disconnecting. */
        push: SiteUp;
    };
    /** L3: the site's world answers the overlay's subscriptions (the bridge sends each overlay only its own) and says when it (re)started. */
    "site.down": {
        /** A snapshot, a change with the ops it acknowledges or the world being ready. */
        push: SiteDown;
    };
    /** L3: the bridge's L2 link came back and the overlay was granted again. The overlay's replicas resubscribe. */
    "store.resync": { push: {} };
    /**
     * A call to an exposed function (`shared/rpc.ts`). On L3 the overlay
     * sends its calls to onPage and onSite code to the bridge and the
     * bridge sends onPage code's calls to the overlay. On L6 MV3 isolated
     * code and the background exchange calls to and from the overlay.
     */
    "rpc.call": {
        /** The call: its id, the handle, the function's name and the arguments. */
        push: RpcCall;
    };
    /** The answer to an `rpc.call`, on the same link in the other direction. */
    "rpc.result": {
        /** The answer, with the call's id. */
        push: RpcResult;
    };

    // ---- MV3 isolated-world onPage code (L6: chrome.userScripts world ⇄ owner; L2 for the relay) ----
    /**
     * L6: what script `s` runs in this frame's user-script world. The
     * isolated runtime calls it once its link is up and on `iso.update`. The
     * background refuses unless `url` has the port's origin, the world is
     * the script's and the script has isolated onPage code for `url`. It
     * binds the link to `s` (replacing an older link of the same frame and
     * script). A refusal (other than a timeout or a closed link) stops the
     * isolated runtime.
     */
    "iso.load": {
        req: {
            /** The frame's URL. */
            url: string;
        };
        /** What the world runs. */
        res: IsoInit;
    };
    /** L6: the built-in React chunk's source, for isolated code that imports React. The isolated runtime evaluates it in its world. */
    "builtin.react": {
        /** No arguments. */
        req: Record<string, never>;
        /** The chunk's JS source. */
        res: string;
    };
    /**
     * L2 (MV2/Firefox, where the bridge runs isolated onPage code): let
     * script `s`'s isolated code at `url` use its stores. Its store ops then
     * go over L2 tagged `ISO_STORE_TAG + s` (the overlay's are tagged `s`).
     * Refused on Chrome MV3, for another origin or when the script has no
     * isolated onPage code there.
     */
    "iso.stores": {
        req: {
            /** The frame's URL. */
            url: string;
        };
        res: {};
    };
    /**
     * L2 (MV2/Firefox): `tweak.fetch` from script `s`'s isolated onPage
     * code, which the bridge runs. The background fetches, reaching only the
     * script's `"tangitweak.connect"` hosts. Refused like `iso.stores`.
     */
    "iso.fetch": {
        req: {
            /** The frame's URL. */
            url: string;
            /** The request. */
            request: WireRequest;
            /** True to keep every script's handlers away from it. */
            bypass: boolean;
        };
        /** The response, its body read in full. */
        res: WireResponse;
    };
    /** L6: this world's onPage code ran on its document, once per document. The background tags the document's Network row. */
    ran: {
        push: {
            /** The API that ran. */
            api: "onPage";
            /** The script's name. */
            name: string;
        };
    };
    /** L6: scripts changed. The isolated runtime calls `iso.load` again and runs again when the code hash moved. */
    "iso.update": { push: {} };
    /**
     * L2: a call between script `s`'s overlay (behind the top-frame bridge)
     * and its MV3 isolated code (behind the background). The background
     * relays it to and from L6 as `rpc.call`, waiting up to 5 s for the
     * other side's link (a new page's may not be up yet). It answers with an
     * error itself when the isolated code isn't running or a link closes.
     */
    "iso.call": {
        /** The call, as in `rpc.call`. */
        push: RpcCall;
    };
    /** L2: the answer to an `iso.call`. */
    "iso.result": {
        /** The answer, as in `rpc.result`. */
        push: RpcResult;
    };

    // ---- the Editor preview (L5: the Editor ⇄ owner, one script at a time; L3 as above between the Editor and its frame) ----
    /**
     * L5: preview script `s`'s overlay as if on `url` in a frame with this
     * one-time nonce. The Editor's Preview tab calls it when it shows a
     * script or the user picks a URL. The background refuses a nonce under
     * 16 characters and drops an earlier script's grant on this link. Then
     * `overlay.init`, `store.*`, `fetch`, `storage.*`, `param.set` and `log`
     * work for `s` on this link; scripts changing come as `bundle.update`.
     */
    "preview.open": {
        req: {
            /** The one-time nonce the frame will say hello with. */
            nonce: string;
            /** The page URL to preview. `""`: the first URL its onOverlay routes name. */
            url: string;
        };
        res: {
            /** The URL used. */
            url: string;
            /** The script's name. */
            name: string;
            /** How many onOverlay handlers the script has. */
            handlers: number;
            /** How many of them match `url`. */
            matching: number;
        };
    };
    /**
     * `tweak.toast` from code that isn't the background's: L1 (the MV3
     * sandbox), L6 (MV3 isolated onPage code) and L2 (an overlay). The
     * background's toast center checks that script `s` runs there, checks
     * the toast again, then routes, rate-limits and queues it like one from
     * background code.
     */
    toast: {
        req: {
            /** The toast, checked by the caller's shim. */
            spec: ToastSpec;
        };
        /** What became of it. */
        res: ToastResult;
    };
    /** L2: `tweak.toast` from MV2/Firefox isolated onPage code, which the bridge runs. Checked like `iso.fetch`. */
    "iso.toast": {
        req: {
            /** The frame's URL. */
            url: string;
            /** The toast, checked by the caller's shim. */
            spec: ToastSpec;
        };
        /** What became of it. */
        res: ToastResult;
    };
    /** L2: the background shows a toast in this tab (top frame only). The bridge draws it in its shadow root. */
    "toast.show": {
        push: {
            /** The toast, ready to draw. */
            toast: ToastView;
        };
    };
    /** L2: the background takes a toast down (its tweak was turned off or muted, or it showed in another tab). */
    "toast.dismiss": {
        push: {
            /** The toast's key. */
            key: string;
        };
    };
    /**
     * L2: the user did something to a toast: clicked it or a button
     * (`actionId`), closed it (`"close"`), or it timed out (`"timeout"`, not
     * passed to the tweak). A pane's `ui.action(id, value)` comes as `value`.
     */
    "toast.event": {
        push: {
            /** The toast's key. */
            key: string;
            /** What happened: an action's id, `"click"`, `"close"` or `"timeout"`. */
            actionId: string;
            /** What a pane passed to `ui.action`. */
            value?: unknown;
            /** Whether the toast is gone from the tab. */
            closed?: boolean;
        };
    };
    /** L2: the user dragged the toast stack to another corner on this site (null: Reset position). */
    "toast.corner": {
        push: {
            /** The site. */
            host: string;
            /** The corner, or null to forget it. */
            position: ToastPosition | null;
        };
    };
    /** L2: on each new port, the toasts this tab still shows (none in a new document). */
    "toast.sync": {
        push: {
            /** The keys of the toasts it shows. */
            keys: string[];
        };
    };
}

/**
 * What a user-script world needs to run a script's onPage code: the answer
 * to `iso.load` (L6, Chrome MV3). The background builds it from the
 * compiled bundle and the owner's stores.
 */
export interface IsoInit {
    /** The script's id. */
    s: string;
    /** The script's name, for its Log. */
    name: string;
    /** The script's runnable JS. */
    src: string;
    /** The hash of the script's code. `iso.update` reruns the code only when it changed. */
    codeHash: string;
    /** The version of its onSite code (the hook's `domHandlers[].v`): calls to its onSite handles matching the page carry it. */
    siteV: string;
    /** The script's param values. */
    params: Record<string, any>;
    /** The libraries the script imports, shipped with it. */
    libs: ShippedLib[];
    /** True when the script has an overlay on this page (top frame only). */
    overlay: boolean;
    /** The script's stores now (its `tweak.pageStore` copies: this page's), keyed like `store.init`. */
    stores: { [name: string]: StoreSnapshot };
    /** Imported libraries' stores now (`lib.id` → stores), keyed like `store.init`. Absent when it imports none. */
    libStores?: { [scriptId: string]: { [name: string]: StoreSnapshot } };
    /** The page the frame is part of (its top frame's document): the only one whose `tweak.pageStore` copies it reaches. */
    page: string;
}

/**
 * L2: the tag prefix of isolated onPage code's store ops (MV2/Firefox).
 * The bridge sends them with `s` set to this prefix plus the script id, so
 * the background tells them from the same script's overlay ops (tagged
 * with the bare id) and checks them against the `iso.stores` grant.
 * Patches and rejects come back tagged the same way.
 */
export const ISO_STORE_TAG = "iso\u0000";

/**
 * What an overlay frame needs to run its script: the answer to
 * `overlay.init` (L2/L5), handed to the frame in `hello` and
 * `overlay.update` (L3).
 */
export interface OverlayInit {
    /** The script's id. */
    s: string;
    /** The script's name, for its Log. */
    name: string;
    /** The script's runnable JS (never sent through the page). */
    code: string;
    /** The hash of the script's code. Hosts compare it to tell whether the overlay needs `overlay.update`. */
    codeHash: string;
    /** Its onOverlay routes matching the page. */
    routes: RouteMeta[];
    /** The page's URL. */
    url: string;
    /** The script's param values. */
    params: Record<string, any>;
    /** Global stores and this page's copies of page stores (`storeKey`). */
    stores: { [name: string]: StoreSnapshot };
    /** Imported libraries' stores now (`lib.id` → stores), keyed like `store.init`. Absent when it imports none. */
    libStores?: { [scriptId: string]: { [name: string]: StoreSnapshot } };
    /** The page the overlay is on (src/background/engine/pages.ts): its `tweak.pageStore` copies. */
    page: string;
    /** The libraries the script imports, shipped with it. */
    libs: ShippedLib[];
    /** True to load the built-in React first. */
    react: boolean;
    /** The page's current `when` phase. The host adds it; the background leaves it out. */
    phase?: "document_start" | "document_end" | "document_idle";
}

/** The names of the ops that are calls (they have `req` and `res`). */
type ReqOps = { [K in keyof WireOps]: WireOps[K] extends { req: any } ? K : never }[keyof WireOps];
/** The names of the ops that are one-way pushes. */
type PushOps = { [K in keyof WireOps]: WireOps[K] extends { push: any } ? K : never }[keyof WireOps];
/** The arguments of call op `K`. */
export type ReqOf<K extends ReqOps> = WireOps[K] extends {
    /** The arguments. */
    req: infer R;
} ? R : never;
/** The answer to call op `K`. */
export type ResOf<K extends ReqOps> = WireOps[K] extends {
    /** The answer. */
    res: infer R;
} ? R : never;
/** The arguments of push op `K`. */
export type PushOf<K extends PushOps> = WireOps[K] extends {
    /** The arguments. */
    push: infer P;
} ? P : never;
export type { ReqOps, PushOps };

/**
 * One message on a link. Every envelope carries `v: 1`, the protocol
 * version; an endpoint answers a request of another version with a
 * `VersionError` and drops anything else of another version.
 *
 * - `req`: a call. `id` numbers it on the sending endpoint (from 1), `op`
 *   names it, `s` says which script (or store tag) it's about and `a` holds
 *   its arguments.
 * - `res`: the answer to the request with the same `id`, either `ok: true`
 *   with the result `r` (`null` when the handler returned nothing) or
 *   `ok: false` with the error's `name` and `message` in `e`.
 * - `push`: a one-way message, like a request without an `id`.
 *
 * `s` is left out when the sender passes none.
 */
export type Envelope =
    | {
          /** The protocol version. */
          v: 1;
          /** A call. */
          t: "req";
          /** The call's number on the sending endpoint. */
          id: number;
          /** The op's name, a key of {@link WireOps}. */
          op: string;
          /** The script (or store tag) it's about. */
          s?: string;
          /** The op's arguments. */
          a: unknown;
      }
    | {
          /** The protocol version. */
          v: 1;
          /** An answer. */
          t: "res";
          /** The `id` of the call it answers. */
          id: number;
          /** The call succeeded. */
          ok: true;
          /** The handler's result (`null` for `undefined`). */
          r: unknown;
      }
    | {
          /** The protocol version. */
          v: 1;
          /** An answer. */
          t: "res";
          /** The `id` of the call it answers. */
          id: number;
          /** The call failed. */
          ok: false;
          /** The error, rebuilt on the caller's side with the same name and message. */
          e: {
              /** The error's `name` (`"Error"` when it had none). */
              name: string;
              /** The error's `message`. */
              message: string;
          };
      }
    | {
          /** The protocol version. */
          v: 1;
          /** A one-way message. */
          t: "push";
          /** The op's name, a key of {@link WireOps}. */
          op: string;
          /** The script (or store tag) it's about. */
          s?: string;
          /** The op's arguments. */
          a: unknown;
      };

/** What a link's carrier delivers per message: one envelope or a batch of them in send order. */
export type WireMessage = Envelope | Envelope[];

/**
 * How long {@link Endpoint.call} waits for an answer when
 * {@link EndpointOptions.timeoutMs} isn't set, in milliseconds. Past it,
 * the call rejects with a `TimeoutError`. Closing the link rejects pending
 * calls right away with a `DisconnectedError` instead.
 */
export const WIRE_TIMEOUT_MS = 30000;
/**
 * The largest message meant for a link, in bytes (fetch bodies excepted).
 * Nothing checks it yet: store values are capped by the owner instead.
 */
export const WIRE_MAX_BYTES = 1024 * 1024;
/**
 * The largest `tweak.fetch` body, in bytes, either way. `shared/ttFetch.ts`
 * throws a `RangeError` for a larger request body and stops reading a
 * larger response body with one.
 */
export const FETCH_MAX_BYTES = 10 * 1024 * 1024;

function namedError(name: string, message: string): Error {
    const e = new Error(message);
    e.name = name;
    return e;
}

/** How an {@link Endpoint} behaves. */
export interface EndpointOptions {
    /** How long a call waits for its answer, in milliseconds. Defaults to {@link WIRE_TIMEOUT_MS}. */
    timeoutMs?: number;
    /**
     * Collect outgoing pushes for this many milliseconds and send them as
     * one batch message. 0 or absent: send each push at once. Calls and
     * answers aren't delayed; they send the pushes queued before them first.
     */
    batchMs?: number;
    /** Called with a line of diagnostics when a message is dropped or malformed, a push listener throws or a send fails. */
    debug?: (msg: string) => void;
}

type ReqHandler = (a: any, s: string | undefined, ep: Endpoint) => unknown;
type PushHandler = (a: any, s: string | undefined, ep: Endpoint) => void;

/**
 * One side of one link: sends calls and pushes, routes what arrives to the
 * handlers and listeners registered for each op and answers calls.
 * See the module overview for the links and {@link Envelope} for the
 * messages.
 */
export class Endpoint {
    private seq = 0;
    private readonly pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private readonly reqHandlers = new Map<string, ReqHandler>();
    private readonly pushHandlers = new Map<string, PushHandler[]>();
    private readonly closeHandlers: ((reason: string) => void)[] = [];
    private queue: Envelope[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** True once {@link Endpoint.close} ran (by either side or a send failing). A closed endpoint ignores what arrives and makes no new calls or pushes. */
    closed = false;

    /**
     * Makes an endpoint. Pass what arrives from the other side to
     * {@link Endpoint.receive}.
     *
     * @param sendRaw Delivers one message to the other side. If it throws,
     *   the endpoint closes as `"send failed: …"`.
     * @param opts Timeout, batching and diagnostics.
     */
    constructor(
        private readonly sendRaw: (msg: WireMessage) => void,
        private readonly opts: EndpointOptions = {}
    ) {}

    /**
     * Sends a call and waits for its answer.
     *
     * @param op The op.
     * @param a Its arguments.
     * @param s The script (or store tag) it's about. Left out of the envelope when undefined.
     * @returns The handler's result.
     * @throws `DisconnectedError` when the link is closed or closes first,
     *   `TimeoutError` after {@link EndpointOptions.timeoutMs} (or
     *   {@link WIRE_TIMEOUT_MS}) without an answer, `UnknownOpError` when
     *   the other side handles no such op, `VersionError` when it speaks
     *   another protocol version or the handler's error with its `name`
     *   and `message`.
     */
    call<K extends ReqOps>(op: K, a: ReqOf<K>, s?: string): Promise<ResOf<K>> {
        if (this.closed) return Promise.reject(namedError("DisconnectedError", `${op}: the link is closed`));
        const id = ++this.seq;
        return new Promise<ResOf<K>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(namedError("TimeoutError", `${op}: no answer within ${Math.round((this.opts.timeoutMs ?? WIRE_TIMEOUT_MS) / 1000)} s`));
            }, this.opts.timeoutMs ?? WIRE_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ v: 1, t: "req", id, op, ...(s !== undefined ? { s } : {}), a });
        });
    }

    /**
     * Sends a one-way message, at once or with the next batch
     * ({@link EndpointOptions.batchMs}). Does nothing on a closed link.
     *
     * @param op The op.
     * @param a Its arguments.
     * @param s The script (or store tag) it's about. Left out of the envelope when undefined.
     */
    push<K extends PushOps>(op: K, a: PushOf<K>, s?: string): void {
        if (this.closed) return;
        const env: Envelope = { v: 1, t: "push", op, ...(s !== undefined ? { s } : {}), a };
        if (!this.opts.batchMs) return this.send(env);
        this.queue.push(env);
        this.flushTimer ??= setTimeout(() => this.flush(), this.opts.batchMs);
    }

    /**
     * Answers calls of `op` with what `fn` returns (or resolves to). One
     * handler per op: a later one replaces it. A throw or rejection answers
     * with that error; `undefined` is sent as `null`. A call of an op
     * without a handler is answered with an `UnknownOpError`.
     *
     * @param fn Gets the arguments, the envelope's `s` and this endpoint.
     */
    handle<K extends ReqOps>(op: K, fn: (a: ReqOf<K>, s: string | undefined, ep: Endpoint) => ResOf<K> | Promise<ResOf<K>>): void {
        this.reqHandlers.set(op, fn as ReqHandler);
    }

    /**
     * Listens for pushes of `op`. Several listeners run in the order they
     * were added; one that throws is reported to
     * {@link EndpointOptions.debug} and doesn't stop the rest. A push
     * nobody listens to is dropped.
     *
     * @param fn Gets the arguments, the envelope's `s` and this endpoint.
     */
    on<K extends PushOps>(op: K, fn: (a: PushOf<K>, s: string | undefined, ep: Endpoint) => void): void {
        const list = this.pushHandlers.get(op) ?? [];
        list.push(fn as PushHandler);
        this.pushHandlers.set(op, list);
    }

    /**
     * Runs `fn` once when the link closes, with the reason given to
     * {@link Endpoint.close}. On a link already closed it runs at once with
     * `"closed"`. Its exceptions are ignored.
     */
    onClose(fn: (reason: string) => void): void {
        if (this.closed) fn("closed");
        else this.closeHandlers.push(fn);
    }

    /**
     * Handles a message from the other side: one envelope or a batch.
     * Ignored once closed. Malformed envelopes, answers to unknown calls
     * and pushes nobody listens to are dropped.
     */
    receive(msg: unknown): void {
        if (this.closed) return;
        if (Array.isArray(msg)) {
            for (const m of msg) this.receiveOne(m);
            return;
        }
        this.receiveOne(msg);
    }

    /**
     * Closes the link: sends the queued pushes, rejects every pending call
     * with a `DisconnectedError` carrying `reason` and runs the
     * {@link Endpoint.onClose} handlers. Closing again does nothing. It
     * doesn't tell the other side: only an {@link endpointPair} closes both,
     * so whoever owns a port disconnects it too.
     *
     * @param reason Why, passed to the close handlers and the rejected calls.
     */
    close(reason = "disconnected"): void {
        if (this.closed) return;
        this.flush();
        this.closed = true;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(namedError("DisconnectedError", reason));
        }
        this.pending.clear();
        for (const fn of this.closeHandlers.splice(0)) {
            try {
                fn(reason);
            } catch {}
        }
    }

    /** Sends the pushes queued by {@link EndpointOptions.batchMs} now, as one message (a single envelope when there's one). */
    flush(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        const q = this.queue;
        this.queue = [];
        if (q.length === 1) this.sendSafe(q[0]);
        else if (q.length) this.sendSafe(q);
    }

    private send(env: Envelope): void {
        // keep order: queued pushes go first
        if (this.queue.length) this.flush();
        this.sendSafe(env);
    }

    private sendSafe(msg: WireMessage): void {
        try {
            this.sendRaw(msg);
        } catch (e: any) {
            this.opts.debug?.(`send failed: ${e?.message || e}`);
            this.close(`send failed: ${e?.message || e}`);
        }
    }

    private receiveOne(env: any): void {
        if (!env || typeof env !== "object" || typeof env.t !== "string") return this.opts.debug?.("dropped a malformed message");
        if (env.v !== 1) {
            // a newer protocol: say so to a caller, drop anything else
            if (env.t === "req" && typeof env.id === "number") this.answerError(env.id, namedError("VersionError", `unsupported protocol version ${env.v}`));
            return;
        }
        if (env.t === "res") {
            const p = this.pending.get(env.id);
            if (!p) return;
            this.pending.delete(env.id);
            clearTimeout(p.timer);
            if (env.ok) p.resolve(env.r);
            else p.reject(namedError(String(env.e?.name || "Error"), String(env.e?.message || "error")));
            return;
        }
        if (env.t === "push") {
            const list = this.pushHandlers.get(env.op);
            if (!list) return this.opts.debug?.(`ignored unknown push "${env.op}"`);
            for (const fn of list) {
                try {
                    fn(env.a, env.s, this);
                } catch (e: any) {
                    this.opts.debug?.(`push "${env.op}" handler threw: ${e?.message || e}`);
                }
            }
            return;
        }
        if (env.t === "req") {
            const fn = this.reqHandlers.get(env.op);
            if (!fn) return this.answerError(env.id, namedError("UnknownOpError", `unknown op "${env.op}"`));
            let out: unknown;
            try {
                out = fn(env.a, env.s, this);
            } catch (e: any) {
                return this.answerError(env.id, e);
            }
            Promise.resolve(out).then(
                (r) => this.send({ v: 1, t: "res", id: env.id, ok: true, r: r === undefined ? null : r }),
                (e) => this.answerError(env.id, e)
            );
        }
    }

    private answerError(id: number, e: any): void {
        this.send({ v: 1, t: "res", id, ok: false, e: { name: String(e?.name || "Error"), message: String(e?.message ?? e) } });
    }
}

// ---- adapters ----

/**
 * An endpoint over a `chrome.runtime` port (L2, L5, L6). Port messages are
 * JSON, so every `Uint8Array` is packed as `{ __ttBytes: "<base64>" }` on
 * the way out and unpacked on the way in. The port disconnecting closes the
 * endpoint as `"the port disconnected"`; closing the endpoint doesn't
 * disconnect the port.
 *
 * @param port The connected port.
 * @param opts Timeout, batching and diagnostics.
 * @returns The endpoint, already listening to the port.
 */
export function portEndpoint(port: chrome.runtime.Port, opts?: EndpointOptions): Endpoint {
    const ep = new Endpoint((msg) => port.postMessage(packBytes(msg)), opts);
    port.onMessage.addListener((m: any) => ep.receive(unpackBytes(m)));
    port.onDisconnect.addListener(() => {
        void (globalThis as any).chrome?.runtime?.lastError;
        ep.close("the port disconnected");
    });
    return ep;
}

/**
 * An endpoint over a `MessagePort` (L3). Messages are structured clones,
 * so bytes travel as they are. It takes the port's `onmessage` (which
 * starts the port). A `MessagePort` doesn't say when the other side goes
 * away, so the endpoint stays open until someone closes it.
 *
 * @param mp The port.
 * @param opts Timeout, batching and diagnostics.
 * @returns The endpoint, already listening to the port.
 */
export function messagePortEndpoint(mp: MessagePort, opts?: EndpointOptions): Endpoint {
    const ep = new Endpoint((msg) => mp.postMessage(msg), opts);
    mp.onmessage = (ev) => ep.receive(ev.data);
    return ep;
}

/**
 * Two connected endpoints in one context, for tests, the MV2 background
 * page and the owner's per-context links. Like a real link, delivery is
 * async (a microtask) and copies each message (`structuredClone` or a JSON
 * round trip without it). Closing either one closes the other with the
 * same reason.
 *
 * @param opts Timeout, batching and diagnostics, for both endpoints.
 * @returns The two endpoints; what one sends, the other receives.
 */
export function endpointPair(opts?: EndpointOptions): [Endpoint, Endpoint] {
    const clone: (v: any) => any = typeof structuredClone === "function" ? structuredClone : (v) => JSON.parse(JSON.stringify(v));
    let a!: Endpoint;
    let b!: Endpoint;
    const deliver = (to: () => Endpoint) => (msg: WireMessage) => {
        const copy = clone(msg);
        queueMicrotask(() => to().receive(copy));
    };
    a = new Endpoint(deliver(() => b), opts);
    b = new Endpoint(deliver(() => a), opts);
    a.onClose((r) => b.close(r));
    b.onClose((r) => a.close(r));
    return [a, b];
}
