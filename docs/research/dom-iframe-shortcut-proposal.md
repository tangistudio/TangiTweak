# DOM, iframe, and shortcut API proposal

Status: draft proposal, no runtime code changed yet. Branch base: `fe58bd5` (`Add ctx.iframes for onPage and onSite handlers`).

## Motivating case and goals

Real-world trigger (`rename-tab.ts`):
- A script registers `ctx.shortcut(cfg.shortcut, ...)` inside `tt.onPage("<all_urls>", ...)` on the top frame (`if (window.top !== window) return`).
- On Google Docs (`https://docs.google.com/*`), editing focus sits inside a hidden same-origin `about:blank` iframe (`.docs-texteventtarget-iframe`) that also calls `document.open()`, wiping `window` listeners. Top-window `keydown` listeners never see keys pressed while editing.
- Similar gaps show up when targets, editors, or hidden iframes live inside open or closed Shadow DOMs, or inside cross-origin embeds.

### Goals

1. **`ctx.elements`**: A general DOM API on `RunCtx` for finding elements right now and tracking arrive/leave over time, with an optional `shadow` flag that reaches both open and closed Shadow DOMs.
2. **`ctx.mount` reuse**: `ctx.mount` reuses `ctx.elements` under the hood instead of maintaining its own selector observer loop, and gains `shadow?: boolean`.
3. **`ctx.iframes` reuse + `crossOrigin`**: `ctx.iframes` reuses `ctx.elements` to discover `<iframe>` elements (including inside Shadow DOMs via `shadow?: boolean`). `crossOrigin?: boolean` is **deferred** (see [Phases](#phases)) because it needs the user's callback to run in another site's process.
4. **`ctx.shortcut` composition**: `ctx.shortcut` gains optional `iframes` (with `crossOrigin` and `shadow` support) built on top of `ctx.elements` and `ctx.iframes` so shortcuts work seamlessly across rich-text editor iframes, hidden shadow iframes, `document.open()` frames, and cross-origin embeds. Cross-origin shortcuts never run user code in the child: the child only reports "keys pressed" and `fn` runs in the parent.

### Phases

1. **Phase 1 (fixes Google Docs)**: `ctx.elements`, `ctx.mount` + `ctx.iframes` refactor onto it, `shadow` everywhere, same-origin / `about:blank` / `document.open()` iframe recovery, and `ctx.shortcut({ iframes })` for same-origin frames.
2. **Phase 2**: `ctx.shortcut({ iframes: { crossOrigin: true } })` via verified frame grants (see [Cross-origin shortcuts](#4-cross-origin-shortcuts-iframes--crossorigin-true-)). No change to how scripts are delivered.
3. **Phase 3**: `scriptLint` static checks (Monaco, Problems, external ESLint plugin).
4. **Deferred until a real use case**: `ctx.iframes(fn, { crossOrigin: true })`. It is the only feature that needs (a) user code delivered into a frame whose URL the script does not match and (b) a rule for which variables a callback may use across processes. Both are described in [Deferred: cross-origin `ctx.iframes`](#deferred-cross-origin-ctxiframes).

---

## Proposed API surface (`src/types/tt-api.d.ts`)

### 1. `ctx.elements`: DOM finding, arrive/leave, and Shadow DOM (`RunCtx`)

Lives on `RunCtx`, making it available everywhere: `onSite`, `onPage`, `onOverlay`, `SiteIframeCtx`, and `PageIframeCtx`. Mirrors `ctx.iframes` ergonomics: omit the callback to **query now**, pass a callback to **observe arrive + leave**.

```ts
interface ElementsOptions {
    /** Traverse open and closed Shadow DOMs (skips TangiTweak's own mount roots). */
    shadow?: boolean;
    /** Stop at / track only the first match. */
    first?: boolean;
    /** Root to search or observe within (defaults to current `document` or `f.document`). */
    root?: ParentNode;
}

interface ObserveOptions extends ElementsOptions {
    /** Distinguish multiple observers on the same selector in one handler across hot-saves. */
    key?: string;
}

type ElementHandler<E extends Element = Element> =
    (el: E, signal: AbortSignal) => (() => void) | void;

interface RunCtx {
    // ...existing: signal, once, patch, style

    // 1) Find matching elements right now:
    elements<K extends keyof HTMLElementTagNameMap>(
        selector: K,
        opts?: ElementsOptions,
    ): HTMLElementTagNameMap[K][];
    elements<E extends Element = Element>(
        selector: string,
        opts?: ElementsOptions,
    ): E[];

    // 2) Detect arrive + leave (now and on future mutations; returns stop()):
    elements<K extends keyof HTMLElementTagNameMap>(
        selector: K,
        fn: ElementHandler<HTMLElementTagNameMap[K]>,
        opts?: ObserveOptions,
    ): () => void;
    elements<E extends Element = Element>(
        selector: string,
        fn: ElementHandler<E>,
        opts?: ObserveOptions,
    ): () => void;
}
```

#### Semantics
- **Only page changes are seen**: observe mode reacts to elements being added/removed and attribute changes. Focus, hover, and properties set by code (`box.checked = true`, `input.value = "x"`) do not change the page, so selectors like `"input:focus"`, `":hover"`, or `":checked"` will not fire when those change. Use the browser's events instead, for example `document.addEventListener("focusin", fn, { signal: ctx.signal })`.
- **Selectors never cross a shadow boundary**: with `shadow: true`, the selector is matched separately inside the document and inside each shadow root. `"app-shell .toolbar"` does **not** find a `.toolbar` that lives inside `<app-shell>`'s shadow root, because from inside that root `app-shell` is not an ancestor. Use a selector that is true inside one root (`".toolbar"`), then filter with `el.getRootNode()` if needed.
- **Find mode (`ctx.elements(selector, opts)`)**: Synchronous snapshot returning matching elements in document/tree order, skipping TangiTweak's own `[data-tangitweak-mount]` hosts. When `first: true`, stops at the first match and returns a 0-or-1-element array.
- **Observe mode (`ctx.elements(selector, fn, opts)`)**:
  - Calls `fn(el, signal)` for every element currently matching `selector` and for any element that later enters the tree or mutates attributes to match `selector`.
  - When `el` leaves the DOM, stops matching `selector`, or the observer/run stops, `signal` aborts and any cleanup function returned by `fn` runs once.
  - Across hot-saves, claims are keyed by `(handler, selector, first, shadow, root, key)` in `ScriptLife`, matching `ctx.mount` and `ctx.iframes`.
  - When `first: true`, tracks one active match at a time; if that match leaves or stops matching, falls through to the next match in tree order.
- **Shared watcher, separate handles**: `ctx.elements`, `ctx.mount`, and `ctx.iframes` share one `MutationObserver` per root underneath, but each call gets its own subscription (own `stop()`, own per-element `signal`, own hot-save claim). Stopping a user's `ctx.elements("iframe", ...)` never stops internal iframe tracking. The observer disconnects when its last subscription stops.

#### Examples
```ts
const saveBtn = ctx.elements("button.save", { shadow: true, first: true })[0];

ctx.elements("video", (video, signal) => {
    video.playbackRate = 2;
    video.addEventListener("ratechange", enforce, { signal });
    return () => console.log("video left DOM", video);
}, { shadow: true });
```

---

### 2. `ctx.mount`: reuses `ctx.elements`

`MountOptions` gains `shadow?: boolean`, and `MountOwner` in `src/shared/runLifecycle.ts` delegates target finding and arrive/leave detection to `ctx.elements`:

```ts
interface MountOptions {
    position?: "inside-last" | "inside-first" | "before" | "after" | "overlay";
    key?: string;
    first?: boolean;
    autoRestore?: boolean;
    /** Mount onto targets inside open or closed Shadow DOMs. */
    shadow?: boolean;
}
```

#### Reuse notes
- `MountOwner` drops its custom document-wide `MutationObserver` and `anchorsOf` selector scan in favor of `ctx.elements(target, ..., { shadow: o.shadow, first: o.first })`.
- Preserves existing `single` (`first: true`) behavior where the single React root moves to the replacement anchor without losing component state.
- Preserves `autoRestore`: when enabled, watches the mounted slot's parent container so page removals of `<tangitweak-mount>` restore cleanly with the existing fight-detection guard.
- `ctx.style` continues to mirror `<style>` tags into every mounted shadow slot automatically.

---

### 3. `ctx.iframes`: reuses `ctx.elements` + adds `crossOrigin` and `shadow`

```ts
interface IframeOptions {
    /** Find `<iframe>` elements inside open and closed Shadow DOMs. */
    shadow?: boolean;
    /** DEFERRED (not in phases 1-3): also run inside cross-origin iframes. */
    crossOrigin?: boolean;
}

interface CrossOriginIframeInfo {
    /** `HTMLIFrameElement` when same-origin; `null` when cross-origin (separate OS process). */
    readonly iframe: HTMLIFrameElement | null;
    readonly crossOrigin: boolean;
    readonly url: string;
    readonly document: Document;
    readonly window: Window;
}

interface IframesCtx<F> {
    iframes(
        fn: (f: F) => unknown,
        opts?: IframeOptions & { crossOrigin?: false },
    ): () => void;
    iframes(
        selector: string,
        fn: (f: F) => unknown,
        opts?: IframeOptions & { crossOrigin?: false },
    ): () => void;
    iframes(
        fn: (f: Omit<F, "iframe"> & CrossOriginIframeInfo) => unknown,
        opts: IframeOptions & { crossOrigin: true },
    ): () => void;
    iframes(
        selector: string,
        fn: (f: Omit<F, "iframe"> & CrossOriginIframeInfo) => unknown,
        opts: IframeOptions & { crossOrigin: true },
    ): () => void;
}
```

Phases 1-3 ship only the first two overloads (`shadow` only). The `crossOrigin: true` overloads above are the deferred design.

Additionally, `PageIframeCtx` gains `f.shortcut(...)` (by including `Pick<PageCtx, "shortcut">` or sharing a base shortcut interface) so an `onPage` iframe callback can bind shortcuts directly in that subframe as well.

---

### 4. `ctx.shortcut`: composes `ctx.elements` + `ctx.iframes`

Available identically on `PageCtx`, `OverlayCtx`, and `PageIframeCtx`:

```ts
type ShortcutIframesOption =
    | boolean
    | string
    | {
          selector?: string;
          crossOrigin?: boolean;
          shadow?: boolean;
      };

interface ShortcutOptions {
    priority?: "before-page" | "after-page";
    /** Follow child iframes (`true`, selector string, or `{ selector, crossOrigin, shadow }`). */
    iframes?: ShortcutIframesOption;
}

// On PageCtx, OverlayCtx, PageIframeCtx:
shortcut(keys: string, fn: () => unknown, opts?: ShortcutOptions): () => void;
```

#### Examples
```ts
// Google Docs and rich-text editors (same-origin + about:blank + document.open() iframes)
ctx.shortcut(cfg.shortcut, renameTab, { iframes: true });

// Only specific editor iframes
ctx.shortcut(cfg.shortcut, renameTab, { iframes: "iframe.docs-texteventtarget-iframe" });

// Hidden iframes in closed Shadow DOMs + cross-origin embeds
ctx.shortcut(cfg.shortcut, renameTab, {
    iframes: { crossOrigin: true, shadow: true },
});
```

---

## API cookbook (examples across every call shape)

### A. `ctx.elements`: querying now vs. tracking arrive + leave

#### 1. Synchronous snapshot (typed by tag name or explicit generic)
```ts
tt.onPage("*://news.ycombinator.com/*", (ctx) => {
    // Tag-name overload infers HTMLAnchorElement[]
    const links = ctx.elements("a");
    tt.log("total links:", links.length);

    // Complex selector with explicit element type
    const external = ctx.elements<HTMLAnchorElement>('a[href^="https://"]');
    for (const a of external) a.rel = "noopener noreferrer";
});
```

#### 2. Finding a single element inside open or closed Shadow DOM (`shadow` + `first`)
```ts
tt.onPage("*://portal.example.com/*", (ctx) => {
    // Stops as soon as the first match is found, walking open and closed shadow roots
    const exportBtn = ctx.elements<HTMLButtonElement>("button.export-csv", {
        shadow: true,
        first: true,
    })[0];

    ctx.shortcut("Mod+Shift+E", () => exportBtn?.click());
});
```

#### 3. Scoped query within a container (`root`)
```ts
tt.onPage("*://dashboard.example.com/*", (ctx) => {
    ctx.elements("section.metrics-card", (card) => {
        // Search only inside `card` (and any shadow roots nested under `card`)
        const inputs = ctx.elements("input", { root: card, shadow: true });
        for (const input of inputs) input.autocomplete = "off";
    });
});
```

#### 4. Arrive + leave with `signal` (auto-cleanup on removal or hot-save)
```ts
tt.onPage("<all_urls>", (ctx) => {
    // Runs for every <video> already on the page AND any added later (SPA routes, infinite scroll, shadow players)
    ctx.elements(
        "video",
        (video, signal) => {
            const enforce = () => {
                if (video.playbackRate !== 1.75) video.playbackRate = 1.75;
            };
            enforce();
            // Listener is automatically removed when this <video> leaves the DOM or the script reloads
            video.addEventListener("ratechange", enforce, { signal });
        },
        { shadow: true },
    );
});
```

#### 5. Explicit leave cleanup + attribute-driven match/unmatch
```ts
tt.onPage("*://app.example.com/*", (ctx) => {
    // Attribute mutations count too: arrives when [open] is added, leaves when [open] is removed or dialog disconnects
    ctx.elements("dialog[open], .modal.is-active", (modal) => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        tt.log("modal opened:", modal.id);

        return () => {
            document.body.style.overflow = prev;
            tt.log("modal closed or removed:", modal.id);
        };
    });
});
```

#### 6. Tracking only the primary match across SPA replacements (`first: true`)
```ts
tt.onPage("*://music.example.com/*", (ctx) => {
    // Tracks one <audio> at a time; if removed, cleans up and falls through to the next <audio>
    ctx.elements(
        "audio",
        (audio, signal) => {
            audio.volume = 0.5;
            audio.addEventListener("play", () => tt.log("playing", audio.src), { signal });
        },
        { first: true, shadow: true },
    );
});
```

#### 7. Early `stop()` (one-shot wait) and `key` (multiple observers on one selector)
```ts
tt.onPage("*://shop.example.com/*", (ctx) => {
    // One-shot: dismiss the cookie banner the first time it appears, then disconnect
    const stopBanner = ctx.elements(
        "button[data-accept-cookies]",
        (btn) => {
            btn.click();
            stopBanner();
        },
        { shadow: true, first: true },
    );

    // Two independent observers on "input" in the same handler, kept distinct across hot-saves via `key`
    ctx.elements("input", (el) => (el.spellcheck = false), { key: "no-spellcheck" });
    ctx.elements(
        "input",
        (el, signal) => {
            el.addEventListener("focus", () => el.select(), { signal });
        },
        { key: "select-on-focus" },
    );
});
```

#### 8. Using `ctx.elements` inside `tt.onSite` (reading site properties on closed-shadow nodes)
```ts
const site = tt.siteStore("player", { videoId: "" });

tt.onSite("*://video.example.com/*", (ctx) => {
    // Reaches into custom elements whose attachShadow({ mode: "closed" }) hid el.shadowRoot from normal DOM queries
    ctx.elements(
        ".internal-stage",
        (stage) => {
            site.videoId = String((stage as any).__playerInstance?.currentId ?? "");
            return () => {
                site.videoId = "";
            };
        },
        { shadow: true, first: true },
    );
});
```

---

### B. `ctx.mount`: JSX mounts backed by `ctx.elements`

#### 9. Mounting React UI onto every match inside Shadow DOMs (`shadow: true`)
```tsx
function CopyIdButton({ anchor }: { anchor: Element }) {
    const id = anchor.getAttribute("data-issue-id") ?? "";
    return <button onClick={() => navigator.clipboard.writeText(id)}>Copy #{id}</button>;
}

tt.onPage("*://tracker.example.com/*", (ctx) => {
    ctx.style(`button { font: 12px system-ui; padding: 2px 6px; cursor: pointer; }`);

    // Finds every issue header inside open or closed web components, mounting a Shadow-isolated React root next to each
    ctx.mount(
        ".header-actions[data-issue-id]",
        (anchor) => <CopyIdButton anchor={anchor} />,
        { position: "inside-first", shadow: true },
    );
});
```

#### 10. Single persistent mount (`first: true` + `shadow: true`) that keeps React state across SPA re-renders
```tsx
import { useState } from "react";

function NotesDrawer() {
    const [note, setNote] = useState("");
    return <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Scratch note..." />;
}

tt.onPage("*://app.example.com/*", (ctx) => {
    // One React root: if the SPA tears down and recreates <app-shell>'s toolbar, NotesDrawer moves to the new toolbar with `note` intact.
    // `.top-toolbar` lives inside <app-shell>'s shadow root, so the selector names only the toolbar.
    ctx.mount(".top-toolbar", <NotesDrawer />, {
        position: "inside-last",
        first: true,
        shadow: true,
        autoRestore: true,
    });
});
```

#### 11. Overlay badge on Shadow DOM cards + direct `Element` mount
```tsx
function PriceDiff({ card }: { card: Element }) {
    const price = card.getAttribute("data-price");
    return <span style={{ position: "absolute", top: 8, right: 8 }}>{price}</span>;
}

tt.onPage("*://travel.example.com/*", (ctx) => {
    // Cover each <hotel-card> inside Shadow DOM; clicks pass through except on the span
    ctx.mount("hotel-card", (card) => <PriceDiff card={card} />, {
        position: "overlay",
        shadow: true,
    });

    // Or query a specific element first with ctx.elements and mount directly onto that Element
    const sidebar = ctx.elements("aside.filters", { shadow: true, first: true })[0];
    if (sidebar) ctx.mount(sidebar, <div>Custom filter header</div>, { position: "before" });
});
```

---

### C. `ctx.iframes`: same-origin, Shadow DOM, `f.shortcut`, and `crossOrigin`

#### 12. All same-origin iframes (including `about:blank`, `srcdoc`, and `document.open()` editors)
```tsx
tt.onPage("*://mail.example.com/*", (ctx) => {
    ctx.iframes((f) => {
        // Everything on `f` targets `f.document`, not the parent `document`
        f.style(`body { font-family: "JetBrains Mono", monospace !important; line-height: 1.6; }`);

        f.elements("blockquote", (quote) => {
            (quote as HTMLElement).dataset.collapsed = "true";
        });

        f.mount("body", <div style={{ opacity: 0.6 }}>Compose helper active</div>, {
            position: "inside-last",
            first: true,
        });
    });
});
```

#### 13. Selector-filtered iframes inside closed Shadow DOM + nested `f.iframes`
```ts
tt.onPage("*://cms.example.com/*", (ctx) => {
    // Finds <iframe class="wysiwyg-frame"> even when buried inside closed web components
    ctx.iframes(
        "iframe.wysiwyg-frame",
        (f) => {
            f.document.designMode = "on";

            // Nested iframes inside that editor frame also work
            f.iframes("iframe.preview-embed", (nested) => {
                nested.style(`body { zoom: 0.9; }`);
            });
        },
        { shadow: true },
    );
});
```

#### 14. Per-iframe shortcuts with `f.shortcut` (using `f.iframe` in the parent DOM)
```ts
tt.onPage("*://tickets.example.com/*", (ctx) => {
    ctx.iframes(
        "iframe.reply-editor",
        (f) => {
            // `f.iframe` is the <iframe> element in the parent document, so we can click the sibling Send button
            f.shortcut("Mod+Enter", () => {
                const row = f.iframe.closest(".reply-box");
                row?.querySelector<HTMLButtonElement>("button.send")?.click();
            });
        },
        { shadow: true },
    );
});
```

#### 15. DEFERRED: Cross-origin iframes in `tt.onPage` (`crossOrigin: true`) with shared `tt.pageStore`

> Deferred design (not in phases 1-3). Kept to show the intended shape. The callback uses only `embeds` (a `tt.pageStore`, shared across frames) and `f`, never a variable local to the handler.

```tsx
import { useSnapshot } from "valtio";

const embeds = tt.pageStore("embeds", { urls: [] as string[], focusedUrl: "" });

tt.onPage("*://docs-portal.example.com/*", (ctx) => {
    if (window.top !== window) return;

    ctx.iframes(
        "iframe",
        (f) => {
            // Runs in-process when same-origin (`f.iframe` is HTMLIFrameElement),
            // and inside the subframe's isolated world when cross-origin (`f.iframe` is null)
            if (!embeds.urls.includes(f.url)) embeds.urls.push(f.url);

            f.window.addEventListener(
                "focus",
                () => {
                    embeds.focusedUrl = f.url;
                },
                { signal: f.signal },
            );
        },
        { crossOrigin: true, shadow: true },
    );

    function EmbedStatus() {
        const snap = useSnapshot(embeds);
        return (
            <div style={{ position: "fixed", bottom: 12, right: 12 }}>
                {snap.urls.length} frames · active: {snap.focusedUrl || "top"}
            </div>
        );
    }
    ctx.mount(<EmbedStatus />);
});
```

#### 16. DEFERRED: Cross-origin iframes in `tt.onSite` (`crossOrigin: true`) patching widget globals

> Deferred design (not in phases 1-3).

```ts
tt.onSite("*://checkout.example.com/*", (ctx) => {
    if (window.top !== window) return;

    // Patches window.fetch inside both same-origin and cross-origin embedded widget iframes
    ctx.iframes(
        "iframe.widget-frame",
        (f) => {
            f.patch(f.window, "fetch", (orig) => function (this: Window, ...args) {
                tt.log("widget fetch in", f.url, String(args[0]));
                return orig.apply(this, args);
            });
        },
        { crossOrigin: true, shadow: true },
    );
});
```

---

### D. `ctx.shortcut`: top window, Google Docs `document.open()`, Shadow iframes, and `crossOrigin`

#### 17. Motivating case (`rename-tab.ts`): user-configurable shortcut that works in Google Docs
```ts
const cfg = tt.params({
    shortcut: { type: "shortcut", default: "Alt+Shift+R", description: "Rename current tab" },
});
const tab = tt.tabStore("customTitle", { title: "" });

tt.onPage("<all_urls>", (ctx) => {
    if (window.top !== window) return;

    const applyTitle = () => {
        if (tab.title) document.title = tab.title;
    };
    applyTitle();

    // `iframes: true` catches keys pressed inside Google Docs' hidden `.docs-texteventtarget-iframe`
    // (`about:blank` + `document.open()`), Notion/Confluence/TinyMCE editors, and dynamically added frames
    ctx.shortcut(
        cfg.shortcut,
        () => {
            const next = prompt("Tab title:", tab.title || document.title);
            if (next === null) return;
            tab.title = next.trim();
            applyTitle();
        },
        { iframes: true },
    );
});
```

#### 18. Targeting only specific editor iframes (`iframes: selector`)
```ts
tt.onPage("https://docs.google.com/document/*", (ctx) => {
    if (window.top !== window) return;

    // Listens on the top window plus matching iframes only
    ctx.shortcut(
        "Mod+Shift+C",
        () => {
            tt.log("Word count shortcut triggered while editing");
        },
        { iframes: "iframe.docs-texteventtarget-iframe" },
    );
});
```

#### 19. Universal command palette in `tt.onOverlay` (`crossOrigin: true` + `shadow: true`)
```tsx
import { useState } from "react";

tt.onOverlay("<all_urls>", (ctx) => {
    let toggle = () => {};

    function Palette() {
        const [open, setOpen] = useState(false);
        toggle = () => setOpen((v) => !v);
        if (!open) return null;
        return (
            <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center" }}>
                <input autoFocus placeholder="Run command..." onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
            </div>
        );
    }

    ctx.mount(<Palette />);

    // Fires even if focus is inside a YouTube embed, CodeSandbox cross-origin preview,
    // or a support chat iframe hidden inside a closed Shadow DOM
    ctx.shortcut("Mod+K", () => toggle(), {
        iframes: { crossOrigin: true, shadow: true },
    });
});
```

#### 20. Shadow iframe option + `priority: "after-page"` + `"pass"` fallback
```ts
tt.onPage("*://ide.example.com/*", (ctx) => {
    if (window.top !== window) return;

    let drawerOpen = false;
    const setDrawer = (v: boolean) => {
        drawerOpen = v;
    };

    // Only runs if neither the main page nor the focused editor iframe consumed Mod+B
    ctx.shortcut("Mod+B", () => setDrawer(!drawerOpen), {
        priority: "after-page",
        iframes: { shadow: true },
    });

    // When drawer is closed, returns "pass" so the iframe's own autocomplete/modal still receives Esc
    ctx.shortcut(
        "Esc",
        () => {
            if (!drawerOpen) return "pass";
            setDrawer(false);
        },
        { iframes: { shadow: true } },
    );
});
```

#### 21. Scoped cross-origin selector + dynamic removal (`off()`)
```ts
tt.onPage("*://studio.example.com/*", (ctx) => {
    if (window.top !== window) return;

    // Listen only on top frame + preview iframes (including cross-origin sandboxed previews inside Shadow DOM)
    const startPreviewHotkeys = () =>
        ctx.shortcut(
            "Esc",
            () => {
                exitFullscreenPreview();
                stopHotkeys();
            },
            {
                iframes: {
                    selector: 'iframe[data-role="preview"]',
                    crossOrigin: true,
                    shadow: true,
                },
            },
        );

    let stopHotkeys = () => {};
    function exitFullscreenPreview() {
        document.querySelector(".preview-shell")?.classList.remove("fullscreen");
    }
    stopHotkeys = startPreviewHotkeys();
});
```

---

## Verified architecture and browser mechanics

### 1. Closed Shadow DOM across all execution worlds

Browser behavior verified in headless Chrome:
- **`onSite` (`MAIN` world, `src/hook/hook.ts`)**: At `document_start`, patch `Element.prototype.attachShadow` (and apply the same patch to same-origin child `iframe.contentWindow.Element.prototype.attachShadow` on frame attach) to record `WeakMap<Element, ShadowRoot>` while leaving `el.shadowRoot === null` untouched for page scripts.
  - **New roots**: the patch itself reports each new root to `ElementsOwner`, which scans and observes it right away. Attaching a shadow root does not cause a DOM mutation in the light tree, so waiting for a `MutationObserver` record would miss it.
  - **Roots that existed before the patch** (created before `document_start` code ran, or parsed from declarative `<template shadowrootmode="closed">`): the patch never sees these. When `shadow: true` is first used, `hook.ts` asks the `ISOLATED` world once to list closed hosts it can read with `chrome.dom.openOrClosedShadowRoot`, then reads each root with the same probe handshake as `onPage` (below).
- **`bridge.ts` (`ISOLATED` content script, MV2 `onPage` + MV3 bridge)**: Native `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, requires zero manifest permissions; Firefox exposes `el.openOrClosedShadowRoot`). Also reads declarative `<template shadowrootmode="closed">` parsed before scripts run.
- **`onPage` (`USER_SCRIPT` world in MV3, `src/hook/isolated.ts`)**: `chrome.dom` is not exposed in `USER_SCRIPT` world, and `CustomEvent.detail` cannot pass DOM nodes across isolated worlds, **but** `Node.prototype.parentNode` does not hide closed `ShadowRoot`s (only the `Element.prototype.shadowRoot` getter checks `mode === "closed"`).
  - Synchronous probe handshake: `isolated.ts` creates one detached `Comment` node (`probe`), temporarily marks/attaches a synchronous bridge request for `host`, `bridge.ts` resolves `const sr = chrome.dom.openOrClosedShadowRoot(host)` and appends `probe` to `sr`, `isolated.ts` synchronously reads `probe.parentNode as ShadowRoot`, removes `probe` in the same call stack, and caches `host -> sr` in a `WeakMap<Element, ShadowRoot>`. Zero async IPC and no node left behind.
  - **Known side effect**: the probe is briefly added to and removed from the shadow root, so a page `MutationObserver` watching that root receives one add + one remove record. Only probe a host when a `shadow: true` call needs it, and only once per host (cached). Documented in `docs/scripting.md`.
- **Shadow tree observation**: `MutationObserver` with `subtree: true` does not cross shadow boundaries. `ElementsOwner` attaches observers to `root` plus each discovered `ShadowRoot` when `shadow: true`, deriving `attributeFilter` from the CSS selector where statically known (for example `childList` only for `"iframe"`, `["class"]` for `".active"`).

### 2. Surviving `document.open()` in hidden editor iframes (Google Docs)

Verified against WHATWG HTML *document open steps* and headless Chrome:
- Calling `childDoc.open()` removes all event listeners registered on both `childDoc` and `childWin`, and does **not** fire `iframe` `load` until `childDoc.close()` is called (Google Docs keeps the stream open or reopens it without a `load` event).
- However, `childDoc.open()` **preserves** `MutationObserver` registrations on `childDoc` and queues a `childList` mutation record when clearing the document's children.
- `IframesOwner` (and `ctx.shortcut` on same-origin subframes) watches `childDoc` via `MutationObserver` to detect `document.open()` wipes immediately, re-attaching `watchShortcuts(childWin, ...)` and re-running frame hooks even if `document.close()` is never called.
- **Small gap**: the browser reports that change a moment after the wipe (as a microtask, a few milliseconds at most). A key pressed inside that moment is missed. That's acceptable, because nobody types in the instant the editor resets.

### 3. Manifest frame coverage (`about:blank` and `srcdoc`)

- `manifest.json` and `scripts/build.mjs` currently inject `bridge.js` and `hook.js` with `"all_frames": true`, which skips `about:blank` and `srcdoc` frames unless `"match_about_blank": true` and `"match_origin_as_fallback": true` are also set.
- Adding `"match_about_blank": true` and `"match_origin_as_fallback": true` ensures `bridge.js` and `hook.js` are present inside nested `about:blank`, `blob:`, and `srcdoc` subframes as well.

### 4. Cross-origin shortcuts (`iframes: { crossOrigin: true }`)

`bridgePorts.ts` and `overlayLinks.ts` already track `(tabId, frameId)` per subframe, and `pageOfFrame` already resolves subframes (`frameId !== 0`) to the tab's page record, so `tt.pageStore`, `tt.tabStore`, and `tt.globalStore` already share state across cross-origin subframes.

**No user code runs in the child.** `bridge.js` is already injected into every frame (`all_frames: true`), so the child frame only needs a key list, not the user's script. That is why this needs no change to `userScripts.ts`, `siteCode.ts`, `pipeline.ts`, or the `isolated.ts` route check.

1. **Child watches keys only**: the background sends the claimed child frame's `bridge.ts` the spec `(keys, priority)`. The child runs local `watchShortcuts`, calls `preventDefault()` + `stopImmediatePropagation()` **synchronously** on the real `KeyboardEvent`, and sends `"shortcut.fire"` back to the parent frame (`isolated.ts`, `bridge.ts`, or `overlayRuntime.ts`).
2. **`fn` runs in the parent**, in the handler's normal closure. Variables, `this`, and helpers all work as usual, with nothing copied across processes.

#### Verifying the child frame (grants)

A `postMessage` token only helps the child *find* the parent. It is not proof, because page scripts can also post messages to the iframe. The background decides, using browser APIs the page cannot fake:

| Step | Chrome (MV3) | Firefox (MV2) |
| --- | --- | --- |
| Parent finds the `<iframe>` via `ctx.elements` (selector + `shadow`) | same | same |
| Learn the child's `frameId` | Parent sends `contentWindow.postMessage({ __ttFrameClaim: token }, "*")`. Child `bridge.ts` accepts it only if `e.source === window.parent`, then claims `token` over its own port. | Parent calls `browser.runtime.getFrameId(iframeEl)` directly. No message needed. |
| Background checks the relation | `chrome.webNavigation.getFrame({ tabId, frameId: child })` must report `parentFrameId === parentFrameId` (permission already in the MV3 manifest). | `getFrameId` result comes from the browser, so it is already trusted. |

Grant rules:
- A grant is bound to `(tabId, parentFrameId, childFrameId, scriptId, run, shortcut id)` plus the child's `documentId` where available (Chrome).
- Tokens are random, single-use, and expire after a few seconds if unclaimed.
- A grant is revoked when the child navigates (`webNavigation.onCommitted` / port disconnect), the `<iframe>` leaves the DOM (`ctx.elements` leave `signal`), the shortcut's `off()` runs, or the script stops, reloads, or is hot-saved.
- The child never learns `fn`, only `(keys, priority)`.

`"pass"` stays a same-frame feature: a cross-origin child must decide synchronously, before the parent hears about the key, so matched keys are always consumed (same as `onOverlay` today).

### Deferred: cross-origin `ctx.iframes`

Not in phases 1-3. Recorded so the problems are not forgotten:
- **Delivery**: `isolated.ts` exits early when no route matches `location.href`, and `overlayLinks.ts` `iso.load` refuses such frames. Running a callback inside a `youtube.com` iframe from a `docs.google.com` script needs a new authorized delivery path through `userScripts.ts`, `siteCode.ts`, and `engine/pipeline.ts`, using the same grants as above.
- **Variables are copies, not shared**: the child frame has its own copy of every module variable. `let count = 0; ctx.iframes(f => count++, { crossOrigin: true })` would leave the parent's `count` at 0 with no error. Only `tt.pageStore`, `tt.tabStore`, and `tt.globalStore` are shared. Globals like `document` and `window` mean the child's.
- **Capture contract** needed before shipping: which names a callback may use (`f`, `tt.*Store` handles, imports, top-level helpers that themselves follow the rule), how `this`, `arguments`, bound functions, and runtime option objects are handled, plus a runtime guard for what lint cannot see.

### 5. Static analysis (`acorn` + `eslint-scope`), Monaco live squiggles, and ESLint plugin

Instead of maintaining fragile regex scans in `src/shared/compile.ts` (`onSiteUses`, `rulesProblems`, `netSiteStoreProblems`) that miss helper functions and misflag shadowed locals, one shared `sucrase` + `acorn` + `eslint-scope` pass (`src/shared/scriptLint.ts`) statically analyzes scripts. Bundle size and speed are unmeasured; measure before committing to it in the editor.

- **Rules checked statically before runtime**:
  1. **`no-invalid-world-access` (Error/Warning, replaces regex `onSiteUses` & `netSiteStoreProblems`)**: Flags `tt.onSite` handlers referencing `pageStore` / `tabStore` / `globalStore` or cross-world handles (`onPage` / `onOverlay`), and network handlers referencing `tt.siteStore`, resolving scope shadowing and calls to top-level helper functions.
  2. **`no-rules-side-effects` (Warning, replaces regex `rulesProblems`)**: Flags per-request side effects (`console.*`, `tt.log`, `fetch`, timers, store mutations) inside `strategy: "rules"` handlers and helpers they call.
  3. **`valid-selectors-and-shortcuts` (Error)**: Validates static string-literal (or top-level `const` string) CSS selectors in `ctx.elements` / `ctx.mount` / `ctx.iframes` / `ctx.shortcut({ iframes })` and shortcut specs in `ctx.shortcut(...)`. Warns when a `shadow: true` selector uses a descendant combinator that looks like it spans a host (for example `"app-shell .toolbar"`).
  4. **`no-cross-origin-iframe-capture`**: ships only with the deferred cross-origin `ctx.iframes`.
  - Registrations made inside helpers (for example an imported `install(ctx)` that calls `ctx.shortcut`) are valid when called synchronously during setup (`src/shared/pageShim.ts`, `test/libRegistrations.test.ts`), so there is deliberately **no** "top-level registrations only" rule.

- **Limits**:
  - Lint runs on `sucrase` output, which keeps line numbers but not exact columns. Diagnostics point to the **line**; the editor highlights the whole line.
  - Lint only sees what is written statically (string literals, top-level `const`s). Runtime checks in `compile.ts` and the runtimes stay in place; lint is an early warning, not the guard.

- **Surfaced everywhere from one rule engine**:
  1. **Monaco Editor (live as you type)**: `src/ui/tsWorkspace.ts` runs `scriptLint` after stripping TS/JSX with `sucrase` and publishes line-level squiggles via `monaco.editor.setModelMarkers`.
  2. **Save / Problems view**: `src/shared/compile.ts` runs the same pass on save so unopened scripts and folder-synced files report line-level diagnostics in **Problems**.
  3. **External editors (VS Code / Cursor / Neovim)**: `src/shared/generatedFiles.ts` + `src/background/folderSync.ts` write `.tangitweak/eslint-plugin.mjs` exposing the same rules as an ESLint flat-config plugin that external editors can import in `eslint.config.mjs` (users bring their own TypeScript parser setup).

---

## Key files in scope

| File | Role in implementation |
| --- | --- |
| `package.json` | Add `eslint-scope` alongside already-present `acorn` (`^8.16.0`) and `sucrase`. |
| `src/types/tt-api.d.ts` | Public types and JSDoc for `ctx.elements`, `MountOptions.shadow`, `IframeOptions`, `ShortcutOptions`, and `PageIframeCtx.shortcut`. |
| `src/shared/domElements.ts` (new) | Selector query + one shared `MutationObserver` per root with separate per-caller subscriptions + open/closed shadow root walker (fed directly by new-root reports) + selector `attributeFilter` extraction. |
| `src/shared/runLifecycle.ts` | Expose `ctx.elements`; refactor `MountOwner` and `IframesOwner` onto `ctx.elements`; add `document.open()` survival to `IframesOwner`. |
| `src/shared/shortcut.ts` | Extend `ShortcutOptions`; compose `FrameShortcuts` with `ctx.iframes` (phase 1) and verified cross-origin frame grants (phase 2). |
| `src/shared/scriptLint.ts` (new) | Shared `acorn` + `eslint-scope` analyzer (phase 3: world-boundary checks, `rules` side effects, static selector/shortcut validation). |
| `src/shared/compile.ts` | Wire `scriptLint` line-level diagnostics into compilation (runtime checks stay); replace regex `onSiteUses` / `rulesProblems` / `netSiteStoreProblems`. |
| `src/ui/tsWorkspace.ts` | Publish live `scriptLint` diagnostics as Monaco markers (`setModelMarkers`) while typing. |
| `src/shared/generatedFiles.ts` & `src/background/folderSync.ts` | Generate `.tangitweak/eslint-plugin.mjs` in synced folders for external ESLint setups. |
| `src/hook/hook.ts` | Early `attachShadow` WeakMap tracker for `MAIN` world (`onSite`) and same-origin child frames; reports new roots directly; one-time lookup of pre-existing closed roots via the `ISOLATED` world. |
| `src/hook/isolated.ts` | Synchronous `Comment`-probe closed-shadow reader (probe only on demand, cached per host) + `onPage` iframe shortcut and `iframes` wiring. |
| `src/hook/bridge.ts` | `chrome.dom.openOrClosedShadowRoot` service, frame discovery (`postMessage` token on Chrome, `runtime.getFrameId` on Firefox), child-frame key-only shortcut listener, and `onOverlay` iframe shortcut forwarding. |
| `src/overlay/overlayRuntime.ts` | Forward `ShortcutOptions` (`iframes`) over the overlay link. |
| `src/background/engine/overlayLinks.ts` & `bridgePorts.ts` | Verify parent/child with `webNavigation.getFrame` (Chrome) or `runtime.getFrameId` (Firefox); issue single-use grants bound to script/run/document; revoke on navigation, iframe removal, `off()`, stop, reload, or hot-save; route `shortcut.fire` to the parent. |
| `manifest.json` & `scripts/build.mjs` | Add `match_about_blank: true` and `match_origin_as_fallback: true` to `bridge.js` and `hook.js` content scripts. |
| `docs/scripting.md` | User-facing documentation for `ctx.elements`, `shadow` (selectors stay within one shadow root; probe side effect), focus/hover/property changes not detected (use events), and `ctx.shortcut` iframe options. |
| _Deferred only_: `src/background/userScripts.ts`, `src/shared/siteCode.ts`, `src/background/engine/pipeline.ts` | Authorized delivery of callbacks into non-matching cross-origin frames for `ctx.iframes({ crossOrigin: true })`. |

---

## Resolved & open design questions

1. **`ShortcutOptions.shadow` placement — Resolved (Alternative A)**:
   `shadow` lives strictly inside `iframes: { selector?, crossOrigin?, shadow? }` (no duplicate top-level `ShortcutOptions.shadow`, since normal `keydown` events inside Shadow DOM already reach `window`).
2. **Cross-origin `ctx.iframes` — Deferred**:
   Cross-origin shortcuts ship without it, because the child only reports keys and `fn` runs in the parent. `ctx.iframes(fn, { crossOrigin: true })` waits for a real use case; it needs an authorized delivery path and a capture contract (see [Deferred: cross-origin `ctx.iframes`](#deferred-cross-origin-ctxiframes)).
3. **Static linting scope — Resolved**:
   `scriptLint` (`acorn` + `eslint-scope`) covers world-boundary mistakes, `strategy: "rules"` side effects, and static selectors/shortcuts, with line-level diagnostics in Monaco, **Problems**, and `.tangitweak/eslint-plugin.mjs`. No "top-level registrations only" rule, since helper registrations during setup are supported. Runtime checks remain.
4. **`"pass"` return value on cross-origin shortcuts**:
   Just like `onOverlay` shortcuts today, a synchronous `"before-page"` key in another process must decide whether to `preventDefault()` before an async hop completes. Consuming matched keys synchronously in cross-origin frames (matching `onOverlay`'s documented behavior) keeps `"before-page"` reliable; `"pass"` continues to work synchronously in the current frame and all same-origin iframes (including Google Docs).
