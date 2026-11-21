/**
 * `"tangitweak/test"`: test a tweak the way it runs in the browser.
 *
 * - Fixtures (`test`, `createTweakTest`): `page`, `browser`, `net`, `tweak`
 *   and `mount`. Each test loads its own copy of the tweak through the
 *   test loader (`loadTweak`), so tests can run concurrently.
 * - One component: `mount` (a fixture, its own stores) or `renderTweak`
 *   (React Testing Library's `render` on the stores Vitest imported).
 * - Plain functions: ordinary imports; `"tangitweak"` runs on its own.
 *
 * The tweak is the folder of the nearest `package.json` with a
 * `"tangitweak"` block above the test file.
 */
import "./dom";
import * as nodePath from "node:path";
import { onTestFinished, test as base } from "vitest";
import { buildQueries, createEvent, queries } from "@testing-library/dom";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { listDirFiles, loadTweak, LOADER, type BrowserName, type LoadedTweak, type LoaderAccess, type OpenPageOptions, type SimulatedResponse, type SimulateRequestInit, type TestPage, type TweakLogEntry } from "./index";
import { bundleDirOf, resetStores, setStore, stackFiles, storeRegistry } from "./standalone";
import type { DocumentWhen } from "../shared/route";
import type { RuleSpec } from "../shared/dnrRules";

export { loadTweak } from "./index";
export type * from "./index";

/** an optional peer dependency: only `renderTweak` needs it */
const rtl: typeof import("@testing-library/react") | null = await import("@testing-library/react").catch(() => null);

/** a store and the value it starts this test with */
export type StoreSeed = readonly [store: object, value: object];

export interface TweakTestOptions {
    /** Param values instead of the defaults (`{ key: value }`). */
    params?: Record<string, any>;
    /** Run this entry file instead of the package.json's (`"./only-misc.ts"`). */
    entry?: string;
    /** Whose limits requests follow: `"chrome"` (MV3, default), `"chromium-mv2"` or `"firefox"`. */
    browser?: BrowserName;
    /** `false`: every matching handler runs in one chain, whatever its strategy (default `true`). */
    realLimits?: boolean;
    /** Replace imports: `{ "some-package": exports, "./lib": exports }`. `vi.mock` doesn't reach the tweak's code here. */
    mocks?: Record<string, any>;
    /** Starting `tweak.storage` values. */
    storage?: Record<string, any>;
}

type QueryKind = "Role" | "LabelText" | "PlaceholderText" | "Text" | "DisplayValue" | "AltText" | "Title" | "TestId";
type Bound<F> = F extends (container: HTMLElement, ...rest: infer A) => infer R ? (...rest: A) => R : never;
/** Testing Library's queries, over the tweak's own UI */
export type UiQueries = {
    [K in keyof typeof queries as K extends `${string}By${QueryKind}` ? K : never]: Bound<(typeof queries)[K]>;
};

export interface GotoOptions {
    /** The website's own `<body>` HTML. */
    html?: string;
    /** The page's Content-Security-Policy: where it forbids eval (Firefox, Chromium MV2), `onSite` runs in the isolated world, with a problem. */
    csp?: string;
    /** How far the page has loaded (default `"document_end"`). */
    phase?: DocumentWhen;
    /** Runs first, with the website's `window` (its MAIN world): its own globals. */
    setup?: (window: Window & typeof globalThis) => void;
}

export interface TweakPage {
    /** Open `url` in this tab: the tab's stores stay, the page's start over. */
    goto(url: string, opts?: GotoOptions): Promise<void>;
    /** Open the same URL again. */
    reload(): Promise<void>;
    /** Press a key combination (`"Mod+Shift+M"`) on the page. */
    press(combo: string): Promise<void>;
    click(el: Element): Promise<void>;
    /** Type `text` into an input, one character at a time. */
    type(el: Element, text: string): Promise<void>;
    /** Let handlers, store syncs and renders settle. */
    flush(): Promise<void>;
    /** The tweak's own UI: its mounts (inside closed shadow roots too) and its overlay. */
    readonly ui: UiQueries;
    readonly url: string;
    /** The website's page. */
    readonly document: Document;
    readonly window: Window & typeof globalThis;
}

export interface TweakBrowser {
    /** Another tab in the same tweak. */
    newPage(url: string, opts?: GotoOptions): Promise<TweakPage>;
}

export interface TweakNet {
    /** Send a request through the handlers, layer by layer (a fetch/XHR unless `resourceType` says otherwise). */
    request(url: string | URL, init?: SimulateRequestInit): Promise<SimulatedResponse>;
    /** The browser rules the tweak generates. */
    readonly rules: RuleSpec[];
}

export interface TweakHandle {
    setParams(values: Record<string, any>): Promise<void>;
    readonly logs: TweakLogEntry[];
    /** What the Problems view would show: errors, then warnings. */
    readonly problems: string[];
    /**
     * This test's copy of an imported store. With a page: that tab's copy;
     * without, the last page or mount opened, else the background's.
     */
    store<T extends object>(store: T, page?: TweakPage | MountedUi): T;
}

export interface MountOptions {
    /** Starting values: `[[store, value], …]`. */
    stores?: readonly StoreSeed[];
    /** Replace imports (`{ "./api": exports }`). */
    mocks?: Record<string, any>;
    props?: Record<string, unknown>;
}

export type MountedUi = UiQueries & {
    /** The element the component renders into (in a closed shadow root, as on a page). */
    readonly container: HTMLElement;
    click(el: Element): Promise<void>;
    type(el: Element, text: string): Promise<void>;
    press(combo: string): Promise<void>;
    flush(): Promise<void>;
};

export type Mount = (path: string, opts?: MountOptions) => Promise<MountedUi>;

export interface TweakFixtures {
    page: TweakPage;
    browser: TweakBrowser;
    net: TweakNet;
    tweak: TweakHandle;
    mount: Mount;
}

const KINDS: QueryKind[] = ["Role", "LabelText", "PlaceholderText", "Text", "DisplayValue", "AltText", "Title", "TestId"];

function describeArgs(args: unknown[]): string {
    return args.map((a) => (a instanceof RegExp ? String(a) : JSON.stringify(a))).join(", ");
}

/** queries over several roots (shadow roots, the overlay's document): Testing Library takes one container */
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

/** the tweak's UI on a page: mount containers (closed shadow roots included) and overlay bodies */
function uiRoots(p: TestPage | null): HTMLElement[] {
    if (!p) return [];
    const roots = p.mounts.map((m) => m.container);
    if (p.overlay) roots.push(p.overlay);
    return roots;
}

/** an event, without React Testing Library's `act()` (concurrent tests would overlap in it) */
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
        `tangitweak/test: no package.json with a "tangitweak" block above ${testFile ?? "this test file"} — a test file lives inside its tweak's folder (e.g. <tweak>/__tests__/x.test.ts)`
    );
}

/** the file `path` names in the bundle (`"features/x/Palette"`, `"./features/x/Palette.tsx"`) */
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

/** one test's copies of the tweak: the tab pages, the mounts, and what they load */
class Session {
    readonly root: string;
    private main: LoadedTweak | null = null;
    private loaders: LoadedTweak[] = [];
    private pages: TestPage[] = [];
    private latest: { page: TestPage; loader: LoadedTweak } | null = null;
    private params: Record<string, any>;
    private nextTab = 2;

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

    async loadMain(): Promise<LoadedTweak> {
        if (!this.main) {
            this.main = await loadTweak(this.root, this.loadOptions());
            this.loaders.push(this.main);
        }
        return this.main;
    }

    /** the main copy, which must have loaded without errors */
    async ready(what: string): Promise<LoadedTweak> {
        const t = await this.loadMain();
        if (t.errors.length) throw new Error(`${what}: the tweak has errors:\n${t.errors.join("\n")}`);
        return t;
    }

    takeTab(): number {
        return this.nextTab++;
    }

    track(page: TestPage, loader: LoadedTweak) {
        this.pages.push(page);
        this.latest = { page, loader };
    }

    async setParams(values: Record<string, any>) {
        Object.assign(this.params, values);
        for (const t of this.loaders) await t.setParams(values);
    }

    get logs(): TweakLogEntry[] {
        return this.loaders.flatMap((t) => t.logs);
    }

    get problems(): string[] {
        const all = this.loaders.flatMap((t) => [...t.errors, ...t.warnings]);
        return [...new Set(all)];
    }

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

    forget(page: TestPage) {
        this.pages = this.pages.filter((p) => p !== page);
    }

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

    async dispose() {
        for (const t of this.loaders) await t.dispose();
        this.loaders = [];
        this.pages = [];
    }
}

/**
 * A Vitest `test` whose fixtures load the tweak with these options: other
 * params, another entry file, another browser.
 */
export function createTweakTest(options: TweakTestOptions = {}) {
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
                store: <T extends object>(store: T, page?: TweakPage | MountedUi) => _tangitweak.store(store, page) as T,
            });
        },
        mount: async ({ _tangitweak }, use) => {
            await use((path: string, opts?: MountOptions) => _tangitweak.mount(path, opts));
        },
    });
}

/** Vitest's `test`, with `page`, `browser`, `net`, `tweak` and `mount` for the tweak this test file is in */
export const test = createTweakTest();

export interface RenderTweakOptions extends RenderOptions {
    /** Starting values: `[[store, value], …]`. All stores start over after the test. */
    stores?: readonly StoreSeed[];
}

/**
 * React Testing Library's `render` for a component Vitest imported, with
 * starting store values. Needs a DOM environment
 * (`// @vitest-environment happy-dom`). Stores are the test file's own, so
 * tests in one file run one after another.
 */
export function renderTweak(ui: ReactElement, options: RenderTweakOptions = {}): RenderResult & { store<T extends object>(store: T): T } {
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
