/**
 * `"tangitweak/test"`: test a tweak with Vitest the way it runs in the
 * browser.
 *
 * Tweak authors import this entry of the SDK in their test files. It offers
 * three styles:
 *
 * - Fixtures ({@link test}, {@link createTweakTest}): `page`, `browser`,
 *   `net`, `tweak` and `mount` ({@link TweakFixtures}). Each test loads its
 *   own copy of the tweak through TangiTweak's compiler (the test loader,
 *   {@link loadTweak}) and gets its own stores, so tests can run with
 *   `test.concurrent`. Everything a test opened is disposed when it ends.
 * - One component: the `mount` fixture (loaded by the test loader, with this
 *   test's own stores) or {@link renderTweak} (React Testing Library's
 *   `render` on the component and stores Vitest imported).
 * - Plain functions: ordinary imports in an ordinary Vitest test; there
 *   `import { tweak } from "tangitweak"` runs on its own in Node.
 *
 * A fixture test finds its tweak by itself: the folder of the nearest
 * `package.json` above the test file that lists `tangitweak` in its
 * `dependencies` (or has a `"tangitweak"` block). Importing this module also
 * installs a background `window` and `document` when the test file has no
 * DOM environment (see `./dom`).
 *
 * The low-level {@link loadTweak} and its types are re-exported from here.
 *
 * @example
 * ```ts
 * // my-tweak/__tests__/palette.test.ts
 * import { expect } from "vitest";
 * import { test } from "tangitweak/test";
 *
 * test("a shortcut opens the palette", async ({ page }) => {
 *     await page.goto("https://app.example.com/home");
 *     await page.press("Alt+Shift+P");
 *     await page.ui.findByRole("listbox");
 *     expect(page.document.querySelector("[role=listbox]")).toBeNull();
 * });
 * ```
 *
 * @see docs/testing.md (Testing tweaks)
 * @module
 */

import "./dom";
import * as nodePath from "node:path";
import { onTestFinished, test as base, type TestAPI } from "vitest";
import { buildQueries, createEvent, queries } from "@testing-library/dom";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { listDirFiles, loadTweak, LOADER, type BrowserName, type LoadedTweak, type LoaderAccess, type OpenPageOptions, type SimulatedResponse, type SimulateRequestInit, type TestPage, type TestToast, type TweakLogEntry } from "./index";
import type { ToastEvent } from "../shared/toast";
import { bundleDirOf, resetStores, setStore, stackFiles, storeRegistry } from "./standalone";
import type { DocumentWhen } from "../shared/route";
import type { RuleSpec } from "../shared/dnrRules";

export { loadTweak } from "./index";
export type * from "./index";

/**
 * React Testing Library or `null` when it isn't installed. It is an optional
 * peer dependency: only {@link renderTweak} needs it and it throws without it.
 */
const rtl: typeof import("@testing-library/react") | null = await import("@testing-library/react").catch(() => null);

/**
 * A store and the value it starts a test with, as `[store, value]`.
 *
 * `store` is the object a tweak module exports from `tweak.globalStore`,
 * `tabStore`, `pageStore` or `siteStore`; it only names which store is meant.
 * A `structuredClone` of `value` replaces the contents of the test's copy of
 * that store (keys it lacks are removed) before the component renders. Used
 * by {@link MountOptions.stores} and {@link RenderTweakOptions.stores}.
 *
 * @example
 * ```ts
 * // palette: a store exported by the tweak's features/palette/state.ts
 * const seed: StoreSeed = [palette, { open: true, filter: "" }];
 * ```
 */
export type StoreSeed = readonly [store: object, value: object];

/**
 * How {@link createTweakTest}'s fixtures load the tweak.
 *
 * Every copy of the tweak a test loads (the `page`/`browser`/`net`/`tweak`
 * one and each `mount`) uses these options.
 *
 * @example
 * ```ts
 * const prodTest = createTweakTest({ params: { env: "prod" }, browser: "firefox" });
 * ```
 */
export interface TweakTestOptions {
    /**
     * Param values to use instead of the defaults: `{ key: value }` or
     * `{ [scriptName]: { key: value } }` for one script. `tweak.setParams` in
     * a test adds to them.
     */
    params?: Record<string, any>;
    /**
     * An entry file to run instead of the one in `package.json`, relative to
     * the tweak's folder (`"./only-misc.ts"`). `mount` replaces it with its own.
     */
    entry?: string;
    /**
     * Whose limits the tweak follows: `"chrome"` (MV3), `"chromium-mv2"` or
     * `"firefox"`. It decides which handlers are turned off, the layers a
     * request goes through and where `onSite` runs under a page's CSP.
     *
     * @defaultValue `"chrome"`
     */
    browser?: BrowserName;
    /**
     * With `false`, every matching handler runs in one chain, whatever its
     * strategy and the browser; use it only to test a handler's logic on its
     * own. With `true`, `net.request` walks the strategies as layers with the
     * browser's real limits.
     *
     * @defaultValue `true`
     */
    realLimits?: boolean;
    /**
     * Imports to replace, by specifier: `{ "some-package": exports, "./lib": exports }`.
     * `vi.mock` doesn't reach the tweak's code here, since TangiTweak's
     * compiler loads it, not Vitest. {@link MountOptions.mocks} adds to them.
     */
    mocks?: Record<string, any>;
    /**
     * Starting `tweak.storage` values: `{ key: value }` for every script or
     * `{ [scriptName]: { key: value } }` when every key names a script. Each
     * loaded copy gets its own clone.
     */
    storage?: Record<string, any>;
}

/** The Testing Library query suffixes {@link UiQueries} offers (`getByRole`, `findByText` and so on). */
type QueryKind = "Role" | "LabelText" | "PlaceholderText" | "Text" | "DisplayValue" | "AltText" | "Title" | "TestId";
/** A Testing Library query with its `container` parameter already filled in. */
type Bound<F> = F extends (container: HTMLElement, ...rest: infer A) => infer R ? (...rest: A) => R : never;
/**
 * Testing Library's queries (`getBy…`, `queryBy…`, `findBy…` and their `All`
 * forms, for each {@link QueryKind}) over the tweak's own UI.
 *
 * They search every root of the tweak's UI on a page at once: each
 * `ctx.mount` container (inside closed shadow roots too, which the website
 * and `page.document` can't see into) and each overlay's `<body>`. An
 * element found in several roots counts once. `findBy…` retries as Testing
 * Library's does. A failing query's error names the tweak's UI and how many
 * mounts and overlays it searched.
 *
 * @example
 * ```ts
 * await page.press("Alt+Shift+P");
 * const list = await page.ui.findByRole("listbox");
 * expect(page.ui.queryByText(/Compact: ON/)).toBeNull();
 * ```
 */
export type UiQueries = {
    [K in keyof typeof queries as K extends `${string}By${QueryKind}` ? K : never]: Bound<(typeof queries)[K]>;
};

/**
 * How {@link TweakPage.goto} (and {@link TweakBrowser.newPage}) opens the
 * website's page.
 *
 * @example
 * ```ts
 * await page.goto("https://app.example.com/home", {
 *     html: `<main id="app"></main>`,
 *     phase: "document_idle",
 *     setup: (window) => {
 *         (window as any).APP_CONFIG = { beta: true };
 *     },
 * });
 * ```
 */
export interface GotoOptions {
    /** The website's own `<body>` HTML, before any handler runs. */
    html?: string;
    /**
     * The page's Content-Security-Policy. On `"firefox"` and `"chromium-mv2"`,
     * where `onSite` code is injected with eval, a policy whose `script-src`
     * (or `default-src`) lacks `'unsafe-eval'` sends `onSite` to the isolated
     * world and {@link TweakHandle.problems} says so. `"chrome"` (MV3)
     * ignores it here.
     */
    csp?: string;
    /**
     * How far the page has loaded when `goto` returns: `"document_start"`,
     * `"document_end"` or `"document_idle"`. Handlers for later phases don't
     * run until the page gets there.
     *
     * @defaultValue `"document_end"`
     */
    phase?: DocumentWhen;
    /**
     * Runs before any handler, with the website's own `window` (its MAIN
     * world): set up the globals the site itself would have. `onSite` code
     * sees them; `onPage` code (the isolated world) doesn't, as in Chrome.
     */
    setup?: (window: Window & typeof globalThis) => void;
}

/**
 * A browser tab with the tweak running in it: the `page` fixture or a tab
 * from {@link TweakBrowser.newPage}.
 *
 * The tab is empty until {@link TweakPage.goto} opens a URL; until then
 * `document`, `window`, `press` and `reload` throw (`open a URL first`).
 * Each page has its own document and `window`, so no DOM environment is
 * needed. The page's own `fetch` goes through the tweak's handlers, like
 * {@link TweakNet.request}. Events are dispatched without React Testing
 * Library's `act()`, so concurrent tests don't overlap in it.
 *
 * @example
 * ```ts
 * test("the compact choice survives a reload", async ({ page }) => {
 *     await page.goto("https://app.example.com/home");
 *     await page.press("Alt+Shift+P");
 *     await page.click(await page.ui.findByText(/Compact: OFF/));
 *
 *     await page.reload();
 *
 *     await page.ui.findByText(/Compact: ON/);
 * });
 * ```
 */
export interface TweakPage {
    /**
     * Opens `url` in this tab in place of the document it had, then waits
     * for the handlers to settle. The tab's `tabStore`s stay; its `pageStore`s
     * start over.
     *
     * @throws When the tweak failed to load (`page.goto("…"): the tweak has errors`, with the errors).
     */
    goto(url: string, opts?: GotoOptions): Promise<void>;
    /**
     * Opens the page's current URL again, as a new document with the same
     * {@link GotoOptions} as the last `goto`. It is a page reload, not a
     * save of the tweak.
     */
    reload(): Promise<void>;
    /**
     * Presses a key combination (`"Mod+Shift+M"`, `"Alt+P"`) as a `keydown`
     * on the focused element (else the `<body>`), then waits like
     * {@link TweakPage.flush}. This is how a test triggers `ctx.shortcut`.
     */
    press(combo: string): Promise<void>;
    /** Dispatches a `click` event on `el`, then waits like {@link TweakPage.flush}. */
    click(el: Element): Promise<void>;
    /**
     * Types `text` into an input, one character at a time: it focuses `el`,
     * then for each character fires `keydown`, then an `input` event with
     * the character appended to the current value, then `keyup`. It waits
     * like {@link TweakPage.flush} after each one. No `change` event is fired.
     */
    type(el: Element, text: string): Promise<void>;
    /**
     * Waits until microtasks, store syncs between the worlds, calls between
     * handlers and React renders have settled. Resolves right away when no
     * URL is open.
     */
    flush(): Promise<void>;
    /**
     * Testing Library's queries over the tweak's own UI in this tab: its
     * mounts (inside closed shadow roots too) and its overlay. See
     * {@link UiQueries}.
     */
    readonly ui: UiQueries;
    /** The URL of the open document or the last one asked for (`"about:blank"` before the first `goto`). */
    readonly url: string;
    /** The website's document (the DOM both worlds share). */
    readonly document: Document;
    /** The website's own `window` (its MAIN world), where `goto`'s `setup` put its globals. */
    readonly window: Window & typeof globalThis;
}

/**
 * Opens more tabs: the `browser` fixture.
 *
 * @example
 * ```ts
 * test("tabs share choices but not the open palette", async ({ page, browser }) => {
 *     await page.goto("https://app.example.com/home");
 *     const other = await browser.newPage("https://app.example.com/other");
 *     expect(other.ui.queryByRole("listbox")).toBeNull();
 * });
 * ```
 */
export interface TweakBrowser {
    /**
     * Opens `url` in another tab of the same copy of the tweak (a new tab
     * ID) and returns it once loaded, like {@link TweakPage.goto}. Tabs share
     * the `globalStore`s, not the `tabStore`s.
     */
    newPage(url: string, opts?: GotoOptions): Promise<TweakPage>;
}

/**
 * The tweak's network handlers without a browser: the `net` fixture.
 *
 * The fixture throws when the tweak failed to load (`net: the tweak has
 * errors`). No browser, helper process or network is involved: `upstream`
 * in the request's options (else an empty `200`) stands in for the server.
 *
 * @example
 * ```ts
 * test("blocks telemetry with a browser rule", async ({ net }) => {
 *     expect(net.rules).toContainEqual(expect.objectContaining({ action: { type: "block" } }));
 *     expect((await net.request("https://telemetry.example.com/ping")).blocked).toBe(true);
 * });
 * ```
 */
export interface TweakNet {
    /**
     * Sends a request through the handlers and returns the response. With
     * {@link TweakTestOptions.realLimits} on (the default) it walks the
     * strategies as layers in the browser's order, each with its real limits
     * in {@link TweakTestOptions.browser}. The result then lists what was
     * `skipped` and what `decidedBy` it. It is a fetch/XHR unless
     * `init.resourceType` says otherwise.
     */
    request(url: string | URL, init?: SimulateRequestInit): Promise<SimulatedResponse>;
    /**
     * The declarativeNetRequest rules the tweak's `rules` handlers generate,
     * after Chrome's checks. They are probed again on every
     * {@link TweakNet.request}, from the current params and stores.
     */
    readonly rules: RuleSpec[];
}

/**
 * The tweak as a whole in this test: the `tweak` fixture.
 *
 * It covers every copy the test loaded (the one `page`, `browser` and `net`
 * share and each `mount`). Using the fixture loads the tweak but doesn't
 * fail on its errors, so a test can check {@link TweakHandle.problems}.
 *
 * @example
 * ```ts
 * // site: a store imported from the tweak's features/palette/state.ts
 * test("records the last visited URL", async ({ page, tweak }) => {
 *     await page.goto("https://app.example.com/home");
 *     expect(tweak.store(site, page).lastUrl).toBe("https://app.example.com/home");
 *     expect(tweak.problems).toEqual([]);
 * });
 * ```
 */
export interface TweakHandle {
    /**
     * Changes param values (`{ key: value }`) for the rest of the test: each
     * loaded copy compiles again and updates its open pages in place. Later
     * loads (a new `mount`) start with them.
     */
    setParams(values: Record<string, any>): Promise<void>;
    /**
     * The log lines of the tweak's scripts (their `console.*` calls and the
     * extension's own messages about them), copy by copy in load order.
     */
    readonly logs: TweakLogEntry[];
    /**
     * What the Problems view would show: each copy's errors, then its
     * warnings, without duplicates. It includes handlers turned off in this
     * browser (with {@link TweakTestOptions.realLimits} on) and a page CSP
     * sending `onSite` to the isolated world.
     */
    readonly problems: string[];
    /** Every copy's `tweak.toast` calls, copy by copy in load order (see {@link LoadedTweak.toasts}). */
    readonly toasts: TestToast[];
    /**
     * Runs a `tweak.every` handler of the main copy now (see {@link LoadedTweak.trigger}).
     *
     * @throws When there is no such schedule or the handler fails.
     */
    trigger(what: "every", index?: number, scriptName?: string): Promise<void>;
    /**
     * Sends a toast event to the main copy's `tweak.onToastAction` handlers.
     *
     * @throws When a handler fails.
     */
    trigger(what: "toastAction", event: ToastEvent, scriptName?: string): Promise<void>;
    /**
     * This test's copy of an imported store. The imported object only names
     * which store is meant.
     *
     * With `page`: that tab's copy. Without: the copy in the last page or
     * mount opened, else the background's (a `siteStore` then needs `page`).
     *
     * @throws When `store` isn't a store from `tweak.globalStore`, `tabStore`, `pageStore` or `siteStore`; when `page` hasn't opened a URL or is closed; or when nothing is loaded yet.
     */
    store<T extends object>(store: T, page?: TweakPage | MountedUi): T;
}

/**
 * How {@link Mount} renders a component.
 *
 * @example
 * ```ts
 * const ui = await mount("features/palette/Palette", {
 *     stores: [[palette, { open: true, filter: "" }]],
 *     props: { title: "Palette" },
 *     mocks: { "./api": { fetchItems: async () => [] } },
 * });
 * ```
 */
export interface MountOptions {
    /** Starting values for this mount's stores: `[[store, value], …]` (see {@link StoreSeed}). */
    stores?: readonly StoreSeed[];
    /** Imports to replace (`{ "./api": exports }`), on top of {@link TweakTestOptions.mocks}. */
    mocks?: Record<string, any>;
    /** The component's props, passed as they are (no copy or serialization). Defaults to none. */
    props?: Record<string, unknown>;
}

/**
 * A component rendered by {@link Mount}: Testing Library's queries over it
 * ({@link UiQueries}), plus the same actions as a {@link TweakPage}.
 */
export type MountedUi = UiQueries & {
    /**
     * The element the component renders into (in a closed shadow root, as on a page).
     *
     * @throws When the component didn't render.
     */
    readonly container: HTMLElement;
    /** Dispatches a `click` event on `el`, then waits like {@link TweakPage.flush}. */
    click(el: Element): Promise<void>;
    /** Types `text` into an input one character at a time, like {@link TweakPage.type}. */
    type(el: Element, text: string): Promise<void>;
    /** Presses a key combination on the focused element, like {@link TweakPage.press}. */
    press(combo: string): Promise<void>;
    /** Waits until handlers, store syncs and renders have settled, like {@link TweakPage.flush}. */
    flush(): Promise<void>;
};

/**
 * Renders one component of the tweak through TangiTweak's compiler, as a
 * page does: the `mount` fixture.
 *
 * - `path` is relative to the tweak's folder, with or without `./` and the
 *   extension (`.tsx`, `.ts`, `.jsx`, `.js`, `.mts`, `.mjs` or a folder's
 *   `index`).
 * - It renders the file's default export, else the export named like the
 *   file, else its only exported function.
 * - Each call loads its own copy of the tweak in a new tab, so its stores
 *   are separate from `page`'s and other mounts'. The component renders in
 *   a closed shadow root at `document_start`, after the {@link MountOptions.stores}
 *   are set; `mount` returns once the page reached `document_idle`.
 *
 * @throws When no such file exists (the error lists the tweak's files) or when this copy of the tweak has errors.
 *
 * @example
 * ```ts
 * test.concurrent("toggles compact", async ({ mount, tweak }) => {
 *     const ui = await mount("features/palette/Palette", {
 *         stores: [[palette, { open: true, filter: "" }]],
 *     });
 *     await ui.click(ui.getByText(/Compact: OFF/));
 *     await ui.findByText(/Compact: ON/);
 *     expect(tweak.store(choices).compact).toBe(true);
 * });
 * ```
 */
export type Mount = (path: string, opts?: MountOptions) => Promise<MountedUi>;

/**
 * The fixtures {@link test} and {@link createTweakTest} give each test. Each
 * is set up only when the test asks for it and everything it loaded is
 * disposed when the test ends.
 *
 * @example
 * ```ts
 * test("…", async ({ page, browser, net, tweak, mount }) => {
 *     // …
 * });
 * ```
 */
export interface TweakFixtures {
    /** A fresh tab (tab ID `1`), empty until {@link TweakPage.goto}. */
    page: TweakPage;
    /** Opens more tabs with the same copy of the tweak. */
    browser: TweakBrowser;
    /** Sends requests through the network handlers and lists the browser rules. */
    net: TweakNet;
    /** Params, logs, problems and store copies for the whole test. */
    tweak: TweakHandle;
    /** Renders one component with its own copy of the tweak. */
    mount: Mount;
}

const KINDS: QueryKind[] = ["Role", "LabelText", "PlaceholderText", "Text", "DisplayValue", "AltText", "Title", "TestId"];

function describeArgs(args: unknown[]): string {
    return args.map((a) => (a instanceof RegExp ? String(a) : JSON.stringify(a))).join(", ");
}

/**
 * Builds {@link UiQueries} over several roots (shadow roots, overlay bodies),
 * since Testing Library's queries take one container.
 *
 * `roots` is read on every query, so mounts and overlays added later are
 * found. `fallback` is the container passed to Testing Library when there is
 * no root yet (it may throw, as a page's does before `goto`).
 */
function uiQueries(roots: () => HTMLElement[], fallback: () => HTMLElement): UiQueries {
    const out: Record<string, unknown> = {};
    for (const kind of KINDS) {
        const one = (queries as any)[`queryAllBy${kind}`] as (c: HTMLElement, ...a: unknown[]) => HTMLElement[];
        const queryAll = (_c: HTMLElement, ...args: unknown[]) => [...new Set(roots().flatMap((r) => one(r, ...args)))];
        const [queryBy, getAllBy, getBy, findAllBy, findBy] = buildQueries(
            queryAll as any,
            (_c, ...args) => `Found several elements of the tweak's UI by ${kind}: ${describeArgs(args)}`,
            (_c, ...args) => `Unable to find the tweak's UI by ${kind}: ${describeArgs(args)} (${roots().length} mount(s) and overlay(s) searched)`
        );
        const container = () => roots()[0] ?? fallback();
        const bind =
            (fn: (...a: any[]) => unknown) =>
            (...args: unknown[]) =>
                fn(container(), ...args);
        out[`queryAllBy${kind}`] = (...args: unknown[]) => queryAll(container(), ...args);
        out[`queryBy${kind}`] = bind(queryBy);
        out[`getAllBy${kind}`] = bind(getAllBy);
        out[`getBy${kind}`] = bind(getBy);
        out[`findAllBy${kind}`] = bind(findAllBy);
        out[`findBy${kind}`] = bind(findBy);
    }
    return out as UiQueries;
}

/** Returns the tweak's UI roots on a page: its mount containers (closed shadow roots included), then its overlay's `<body>`. */
function uiRoots(p: TestPage | null): HTMLElement[] {
    if (!p) return [];
    const roots = p.mounts.map((m) => m.container);
    if (p.overlay) roots.push(p.overlay);
    return roots;
}

/** Dispatches a Testing Library event without React Testing Library's `act()`, which concurrent tests would overlap in. */
function fire(el: Element, kind: keyof typeof createEvent, init?: object): void {
    el.dispatchEvent(createEvent[kind](el, init));
}

async function typeInto(el: Element, text: string, flush: () => Promise<void>): Promise<void> {
    const input = el as HTMLInputElement;
    (input as HTMLElement).focus?.();
    for (const ch of text) {
        fire(input, "keyDown", { key: ch });
        fire(input, "input", { target: { value: (input.value ?? "") + ch } });
        fire(input, "keyUp", { key: ch });
        await flush();
    }
}

async function clickOn(el: Element, flush: () => Promise<void>): Promise<void> {
    fire(el, "click");
    await flush();
}

function identityOf(store: object) {
    const rec = storeRegistry().stores.get(store);
    if (!rec) {
        throw new Error(
            `tangitweak/test: that isn't a store from tweak.globalStore/tabStore/pageStore/siteStore — import it from the tweak's own module (e.g. import { palette } from "../features/x/state")`
        );
    }
    return rec;
}

const PAGE = Symbol("tangitweak.page");
const MOUNT_PROPS = "tangitweak-test:mount-props";
const MOUNT_URL = "https://mount.test/";

function bundleOf(testFile: string | undefined): string {
    const candidates = testFile ? [testFile] : [];
    candidates.push(...stackFiles());
    for (const file of candidates) {
        const dir = bundleDirOf(nodePath.dirname(file));
        if (dir) return dir;
    }
    throw new Error(
        `tangitweak/test: no package.json listing "tangitweak" in its dependencies above ${testFile ?? "this test file"} — a test file lives inside its tweak's folder (e.g. <tweak>/__tests__/x.test.ts)`
    );
}

/**
 * Finds the file `path` names in the tweak's folder (`"features/x/Palette"`,
 * `"./features/x/Palette.tsx"`), trying the known extensions and then a
 * folder's `index`.
 *
 * @throws When no file matches; the error lists the folder's script files.
 */
async function bundleFile(root: string, path: string): Promise<string> {
    const files = await listDirFiles(root);
    const want = path.replace(/^\.\//, "").replace(/\\/g, "/");
    const exts = ["", ".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];
    for (const p of [want, `${want}/index`]) {
        for (const ext of exts) if (files.includes(p + ext)) return p + ext;
    }
    throw new Error(`mount("${path}"): no such file in ${root}. Its files: ${files.filter((f) => /\.[jt]sx?$/.test(f)).join(", ")}`);
}

function mountEntry(file: string): string {
    const base = nodePath.basename(file).replace(/\.[^.]+$/, "");
    return `import { tweak } from "tangitweak";
import * as M from "./${file.replace(/\.[^./]+$/, "")}";
import { props } from ${JSON.stringify(MOUNT_PROPS)};
const fns = Object.entries(M).filter(([, v]) => typeof v === "function");
const C: any = (M as any).default ?? (M as any)[${JSON.stringify(base)}] ?? (fns.length === 1 ? fns[0][1] : undefined);
if (typeof C !== "function") throw new Error(${JSON.stringify(`mount: ${file} has no default export, no export named "${base}", and not exactly one exported function`)});
tweak.onPage(${JSON.stringify(`*://mount.test/*`)}, (ctx) => {
    ctx.mount(<C {...props} />);
});
`;
}

/**
 * One test's copies of the tweak: the main copy its tabs and `net` share,
 * one copy per `mount` and the pages they opened. The fixtures are views of
 * it; it is disposed when the test ends.
 */
class Session {
    /** The tweak's folder: where the nearest tweak `package.json` above the test file is. */
    readonly root: string;
    private main: LoadedTweak | null = null;
    private loaders: LoadedTweak[] = [];
    private pages: TestPage[] = [];
    private latest: { page: TestPage; loader: LoadedTweak } | null = null;
    private params: Record<string, any>;
    private nextTab = 2;

    /**
     * Finds the tweak for the test file. Nothing is loaded until a fixture
     * needs it.
     *
     * @param testFile The test file's path. When it is unknown or outside a tweak, the files on the call stack are tried.
     * @throws When no folder above has a `package.json` listing `tangitweak` in its `dependencies` (or with a `"tangitweak"` block).
     */
    constructor(
        testFile: string | undefined,
        private opts: TweakTestOptions
    ) {
        this.root = bundleOf(testFile);
        this.params = { ...(opts.params ?? {}) };
    }

    private loadOptions(extra: { entry?: string; files?: Record<string, string>; mocks?: Record<string, any> } = {}) {
        return {
            params: this.params,
            storage: this.opts.storage,
            browser: this.opts.browser,
            realLimits: this.opts.realLimits,
            allowCompileErrors: true,
            entry: extra.entry ?? this.opts.entry,
            files: extra.files,
            mocks: { ...(this.opts.mocks ?? {}), ...(extra.mocks ?? {}) },
        };
    }

    /** Loads the main copy on first use (compile errors are kept, not thrown) and returns it. */
    async loadMain(): Promise<LoadedTweak> {
        if (!this.main) {
            this.main = await loadTweak(this.root, this.loadOptions());
            this.loaders.push(this.main);
        }
        return this.main;
    }

    /**
     * Returns the main copy, loading it if needed.
     *
     * @param what Names the caller in the error (`page.goto("…")`, `net`).
     * @throws When the tweak has errors (they are listed).
     */
    async ready(what: string): Promise<LoadedTweak> {
        const t = await this.loadMain();
        if (t.errors.length) throw new Error(`${what}: the tweak has errors:\n${t.errors.join("\n")}`);
        return t;
    }

    /** Hands out a new tab ID: `2`, `3` and so on (the `page` fixture is tab `1`). */
    takeTab(): number {
        return this.nextTab++;
    }

    /** Records an opened page as the latest one, which {@link Session.store} reads without a page. */
    track(page: TestPage, loader: LoadedTweak) {
        this.pages.push(page);
        this.latest = { page, loader };
    }

    /** Adds `values` to the params of later loads and applies them to every loaded copy. */
    async setParams(values: Record<string, any>) {
        Object.assign(this.params, values);
        for (const t of this.loaders) await t.setParams(values);
    }

    /** Every copy's log lines, copy by copy in load order. */
    get logs(): TweakLogEntry[] {
        return this.loaders.flatMap((t) => t.logs);
    }

    /** Every copy's toasts, copy by copy in load order. */
    get toasts(): TestToast[] {
        return this.loaders.flatMap((t) => t.toasts);
    }

    /** Every copy's errors and warnings, without duplicates. */
    get problems(): string[] {
        const all = this.loaders.flatMap((t) => [...t.errors, ...t.warnings]);
        return [...new Set(all)];
    }

    /** Implements {@link TweakHandle.store}. */
    store(store: object, target?: TweakPage | MountedUi): object {
        const { identity, initial } = identityOf(store);
        if (target) {
            const ref = (target as any)[PAGE] as { page: TestPage | null; loader: LoadedTweak } | undefined;
            if (!ref?.page) throw new Error("tweak.store(store, page): that page hasn't opened a URL yet");
            return ((ref.loader as any)[LOADER] as LoaderAccess).store(identity, initial, ref.page);
        }
        if (this.latest && this.pages.includes(this.latest.page)) {
            return ((this.latest.loader as any)[LOADER] as LoaderAccess).store(identity, initial, this.latest.page);
        }
        if (!this.main) throw new Error("tweak.store(store): nothing is loaded yet — open a page or mount first");
        return ((this.main as any)[LOADER] as LoaderAccess).store(identity, initial);
    }

    /** Drops a closed page, so {@link Session.store} no longer reads it. */
    forget(page: TestPage) {
        this.pages = this.pages.filter((p) => p !== page);
    }

    /** Implements {@link Mount}: a new copy of the tweak whose entry renders the component. */
    async mount(path: string, mo: MountOptions = {}): Promise<MountedUi> {
        const file = await bundleFile(this.root, path);
        const entry = "__tt_mount__.tsx";
        const t = await loadTweak(
            this.root,
            this.loadOptions({ entry, files: { [entry]: mountEntry(file) }, mocks: { ...(mo.mocks ?? {}), [MOUNT_PROPS]: { props: mo.props ?? {} } } })
        );
        this.loaders.push(t);
        if (t.errors.length) throw new Error(`mount("${path}"): the tweak has errors:\n${t.errors.join("\n")}`);
        const p = await t.openPage(MOUNT_URL, { phase: "document_start", tabId: this.takeTab() });
        for (const [store, value] of mo.stores ?? []) {
            const { identity, initial } = identityOf(store);
            setStore(((t as any)[LOADER] as LoaderAccess).store(identity, initial, p), structuredClone(value));
        }
        await p.flush();
        await p.advanceTo("document_idle");
        this.track(p, t);
        const flush = () => p.flush();
        const roots = () => uiRoots(p);
        const ui = uiQueries(roots, () => p.document.body);
        return Object.assign(ui, {
            [PAGE]: { page: p, loader: t },
            get container() {
                const c = roots()[0];
                if (!c) throw new Error(`mount("${path}"): the component didn't render`);
                return c;
            },
            click: (el: Element) => clickOn(el, flush),
            type: (el: Element, text: string) => typeInto(el, text, flush),
            press: async (combo: string) => void (await p.pressKey(combo)),
            flush,
        }) as MountedUi;
    }

    /** Creates an empty {@link TweakPage} for tab `tabId`, on the main copy. */
    newPage(tabId: number): TweakPage {
        const session = this;
        let current: TestPage | null = null;
        let main: LoadedTweak | null = null;
        let last: { url: string; opts: GotoOptions } = { url: "about:blank", opts: {} };
        const ref = { page: null as TestPage | null, loader: null as LoadedTweak | null };
        const need = () => {
            if (!current) throw new Error("open a URL first: await page.goto(url)");
            return current;
        };
        const flush = () => (current ? current.flush() : Promise.resolve());
        const open = async (url: string, opts: GotoOptions) => {
            main = await session.ready(`page.goto("${url}")`);
            if (current) {
                session.forget(current);
                await current.close();
            }
            const pageOpts: OpenPageOptions = { tabId, html: opts.html, csp: opts.csp, phase: opts.phase, setup: opts.setup };
            current = await main.openPage(url, pageOpts);
            await current.flush();
            last = { url, opts };
            ref.page = current;
            ref.loader = main;
            session.track(current, main);
        };
        return {
            [PAGE]: ref,
            goto: (url: string, opts: GotoOptions = {}) => open(url, opts),
            reload: () => open(need().url, last.opts),
            press: async (combo: string) => void (await need().pressKey(combo)),
            click: (el: Element) => clickOn(el, flush),
            type: (el: Element, text: string) => typeInto(el, text, flush),
            flush,
            ui: uiQueries(
                () => uiRoots(current),
                () => need().document.body
            ),
            get url() {
                return current?.url ?? last.url;
            },
            get document() {
                return need().document;
            },
            get window() {
                return need().window;
            },
        } as TweakPage;
    }

    /** Disposes every loaded copy, closing its pages. */
    async dispose() {
        for (const t of this.loaders) await t.dispose();
        this.loaders = [];
        this.pages = [];
    }
}

/**
 * Makes a Vitest `test` whose fixtures ({@link TweakFixtures}) load the tweak
 * with these options: other params, another entry file, another browser.
 *
 * It is Vitest's own `test.extend`, so `test.concurrent`, `test.each`,
 * `describe` and the rest work as usual. Each test that uses a fixture finds
 * the tweak above its test file, loads its own copy and disposes it (with
 * every page and mount it opened) when the test ends, even if it failed.
 *
 * @param options How the fixtures load the tweak; {@link test} uses none.
 * @returns A Vitest `test` with `page`, `browser`, `net`, `tweak` and `mount`.
 *
 * @example
 * ```ts
 * import { describe, expect } from "vitest";
 * import { createTweakTest } from "tangitweak/test";
 *
 * const prodTest = createTweakTest({ params: { env: "prod" } });
 *
 * prodTest("uses the production API", async ({ net }) => {
 *     const res = await net.request("https://app.example.com/api/flags");
 *     expect(res.decidedBy?.script).toBe("my-tweak");
 * });
 *
 * describe.each(["chrome", "firefox"] as const)("%s", (browser) => {
 *     const t = createTweakTest({ browser });
 *     t("loads without problems", async ({ tweak }) => {
 *         expect(tweak.problems).toEqual([]);
 *     });
 * });
 * ```
 */
export function createTweakTest(options: TweakTestOptions = {}): TestAPI<TweakFixtures> {
    return base.extend<TweakFixtures & { _tangitweak: Session }>({
        _tangitweak: async ({ task }, use) => {
            const session = new Session(task.file?.filepath, options);
            try {
                await use(session);
            } finally {
                await session.dispose();
            }
        },
        page: async ({ _tangitweak }, use) => {
            await use(_tangitweak.newPage(1));
        },
        browser: async ({ _tangitweak }, use) => {
            await use({
                async newPage(url: string, opts?: GotoOptions) {
                    const p = _tangitweak.newPage(_tangitweak.takeTab());
                    await p.goto(url, opts);
                    return p;
                },
            });
        },
        net: async ({ _tangitweak }, use) => {
            const t = await _tangitweak.ready("net");
            await use({
                request: (url: string | URL, init?: SimulateRequestInit) => t.simulate(url, init),
                get rules() {
                    return t.rules;
                },
            });
        },
        tweak: async ({ _tangitweak }, use) => {
            await _tangitweak.loadMain();
            await use({
                setParams: (values: Record<string, any>) => _tangitweak.setParams(values),
                get logs() {
                    return _tangitweak.logs;
                },
                get problems() {
                    return _tangitweak.problems;
                },
                get toasts() {
                    return _tangitweak.toasts;
                },
                trigger: async (what: any, arg?: any, scriptName?: string) => (await _tangitweak.ready("tweak.trigger")).trigger(what, arg, scriptName),
                store: <T extends object>(store: T, page?: TweakPage | MountedUi) => _tangitweak.store(store, page) as T,
            });
        },
        mount: async ({ _tangitweak }, use) => {
            await use((path: string, opts?: MountOptions) => _tangitweak.mount(path, opts));
        },
    });
}

/**
 * Vitest's `test`, with the `page`, `browser`, `net`, `tweak` and `mount`
 * fixtures ({@link TweakFixtures}) for the tweak this test file is in, loaded
 * with its defaults. It is `createTweakTest()`; use {@link createTweakTest}
 * for other options.
 *
 * @example
 * ```ts
 * import { expect } from "vitest";
 * import { test } from "tangitweak/test";
 *
 * test("a shortcut opens the palette", async ({ page }) => {
 *     await page.goto("https://app.example.com/home");
 *     expect(page.ui.queryByRole("listbox")).toBeNull();
 *
 *     await page.press("Alt+Shift+P");
 *
 *     await page.ui.findByRole("listbox");
 * });
 * ```
 */
export const test: TestAPI<TweakFixtures> = createTweakTest();

/**
 * React Testing Library's `render` options, plus starting store values, for
 * {@link renderTweak}.
 *
 * @example
 * ```tsx
 * renderTweak(<Palette />, { stores: [[palette, { open: true, filter: "" }]] });
 * ```
 */
export interface RenderTweakOptions extends RenderOptions {
    /**
     * Starting values: `[[store, value], …]` (see {@link StoreSeed}), set
     * before the component renders. All stores start over after the test.
     */
    stores?: readonly StoreSeed[];
}

/**
 * React Testing Library's `render` for a component Vitest imported, with
 * starting store values.
 *
 * - The component and its stores are ordinary imports, so TypeScript checks
 *   them and `vi.mock`, `vi.spyOn` and breakpoints work as usual.
 *   `"tangitweak"` runs on its own in Node: stores are plain Valtio objects
 *   and params return their defaults.
 * - It needs a DOM environment (`// @vitest-environment happy-dom`) and the
 *   optional peer dependency `@testing-library/react`.
 * - When the test ends, it unmounts the component and resets every store to
 *   its initial value. Stores are the test file's own, so tests in one file
 *   run one after another, not with `test.concurrent`.
 *
 * @param ui The element to render (`<Palette />`).
 * @param options `render`'s options, plus {@link RenderTweakOptions.stores}.
 * @returns `render`'s result, plus `store(store)`, which returns the store
 * itself (Vitest's import is the test file's only copy).
 * @throws When `@testing-library/react` isn't installed or a seeded store isn't a tweak store.
 *
 * @example
 * ```tsx
 * // @vitest-environment happy-dom
 * import { fireEvent, screen } from "@testing-library/react";
 * import { expect, test } from "vitest";
 * import { renderTweak } from "tangitweak/test";
 * // Palette and the stores choices and palette: imported from the tweak's
 * // features/palette/Palette.tsx and features/palette/state.ts
 *
 * test("toggles compact", async () => {
 *     const { store } = renderTweak(<Palette />, {
 *         stores: [[palette, { open: true, filter: "" }]],
 *     });
 *
 *     fireEvent.click(screen.getByText(/Compact: OFF/));
 *
 *     await screen.findByText(/Compact: ON/);
 *     expect(store(choices).compact).toBe(true);
 * });
 * ```
 */
export function renderTweak(
    ui: ReactElement,
    options: RenderTweakOptions = {}
): RenderResult & {
    /**
     * Returns `store` itself, after checking it is a tweak store.
     *
     * @param store A store the test file imported.
     * @returns The same object.
     * @throws When `store` is not a tweak store.
     */
    store<T extends object>(store: T): T;
} {
    if (!rtl) throw new Error("renderTweak needs React Testing Library: npm install --save-dev @testing-library/react");
    const { stores, ...renderOptions } = options;
    let result: RenderResult | null = null;
    onTestFinished(() => {
        result?.unmount();
        resetStores();
    });
    for (const [store, value] of stores ?? []) {
        identityOf(store);
        setStore(store, structuredClone(value));
    }
    result = rtl.render(ui, renderOptions);
    return Object.assign(result, {
        store<T extends object>(store: T): T {
            identityOf(store);
            return store;
        },
    });
}
