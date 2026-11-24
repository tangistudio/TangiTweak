/**
 * Handler routes: the first argument of every tweak.onXxx registration.
 *
 *   tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, fn)
 *   tweak.onResponseBody({ url: [...], exclude, methods, resourceTypes, strategy, binary }, fn)
 *   tweak.onSite / tweak.onPage ("*://example.com/*" or { url, exclude, when }, fn): kind
 *   "onDocument" (world "page" / "isolated"); tweak.onOverlay: kind "onOverlay"
 *
 * Each network route is owned by exactly one strategy: its own, required,
 * `strategy` (there is no default).
 *
 * Compiling a script turns each registration's argument into a
 * {@link RouteMeta} ({@link normalizeRoute}, which throws a script error on
 * anything unusable). The background, the strategies, the page hook and the
 * `tangitweak/test` harness then match requests and documents against it
 * ({@link routeMatches}, {@link routeMayMatch}, {@link RouteIndex}) and name
 * it in log lines ({@link routeLabel}). URL patterns are URLPattern strings
 * (`shared/matcher.ts`).
 *
 * @module
 */

import { hostKeyOf, matchAny, matchGroups, matchPatternError, originMatchAny } from "./matcher";

/**
 * The mechanism that runs a network handler, named by its route's required
 * `strategy`.
 *
 * @see docs/strategies.md
 */
export type Strategy = "page" | "extension" | "debugger" | "helper" | "rules";
/** Every {@link Strategy}, in the order error messages list them; {@link normalizeRoute} accepts only these. */
export const STRATEGIES: Strategy[] = ["helper", "page", "extension", "debugger", "rules"];

/** Kind of a network handler: the tweak API that registered it. A strategy runs it. */
export type NetKind = "onRequest" | "onResponseHeaders" | "onResponseBody";
/** Kind of a page handler (`"onDocument"`: tweak.onSite, tweak.onPage) or an overlay handler (`"onOverlay"`: tweak.onOverlay). */
export type DocKind = "onDocument" | "onOverlay";
/** Kind of any handler a route belongs to: network ({@link NetKind}) or page/overlay ({@link DocKind}). */
export type RouteKind = NetKind | DocKind;
/** Every {@link NetKind}. */
export const NET_KINDS: NetKind[] = ["onRequest", "onResponseHeaders", "onResponseBody"];

/** Whether `kind` is a network handler's kind (one that a strategy runs), not a page/overlay one. */
export const isNetKind = (kind: RouteKind): kind is NetKind => kind !== "onDocument" && kind !== "onOverlay";

/** Where a page handler's JavaScript runs: a private (isolated) world (tweak.onPage) or the site's own JS world (tweak.onSite). */
export type PageWorld = "isolated" | "page";

/** The API for each of the three places a script's code runs in a tab: the site's JS world, the isolated world, the overlay frame. */
export type PlaceApi = "onSite" | "onPage" | "onOverlay";
/** Every {@link PlaceApi}. */
export const PLACE_APIS: PlaceApi[] = ["onSite", "onPage", "onOverlay"];
/** The route kind an API registers: `"onOverlay"` for tweak.onOverlay, else `"onDocument"`. */
export const placeKind = (api: PlaceApi): DocKind => (api === "onOverlay" ? "onOverlay" : "onDocument");
/** The world an API's code runs in: `"page"` for onSite, `"isolated"` for onPage, undefined for onOverlay (its own frame). */
export const placeWorld = (api: PlaceApi): PageWorld | undefined => (api === "onSite" ? "page" : api === "onPage" ? "isolated" : undefined);
/** The API a page/overlay route was registered with (a route without `world` counts as onSite). */
export const placeOf = (route: Pick<RouteMeta, "kind" | "world">): PlaceApi => (route.kind === "onOverlay" ? "onOverlay" : route.world === "isolated" ? "onPage" : "onSite");

/**
 * Names a script's onSite / onPage / onOverlay handlers (RouteMeta.key) by
 * registration order, per API, in one run of the script's top level:
 * `onPage:1` is the 2nd `tweak.onPage` its code registered. Every world runs
 * the same code in the same order, so the names agree (nothing is
 * rewritten in the source). A call in a library's code (its exported
 * function, called by the script) is counted separately and named after it
 * (`onPage:0@utils/x`).
 *
 * @returns A function to call once per registration, in order, with the
 *   API and the library the call is in (undefined for the script's own code).
 */
export function placeKeyer(): (
    api: PlaceApi,
    lib?: string
) => {
    /** The handler's name, e.g. `"onPage:1"` or `"onPage:0@utils/x"` ({@link RouteMeta.key}). */
    key: string;
    /** Which of the calls to this API (in this library, if any) it is, 0-based. */
    n: number;
} {
    const counts = new Map<string, number>();
    return (api, lib) => {
        const at = `${api}@${lib ?? ""}`;
        const n = counts.get(at) ?? 0;
        counts.set(at, n + 1);
        return { key: `${api}:${n}${lib === undefined ? "" : `@${lib}`}`, n };
    };
}

/**
 * When a page/overlay handler runs in the document's load, as in a content
 * script's `run_at`.
 *
 * {@link normalizeRoute} defaults it to `"document_start"` for onSite (ahead of
 * the site's own code) and `"document_end"` for onPage and onOverlay.
 */
export type DocumentWhen = "document_start" | "document_end" | "document_idle";
const DOCUMENT_WHENS: DocumentWhen[] = ["document_start", "document_end", "document_idle"];

/**
 * What in-place URL changes (pushState, back/forward, #hash) do to an
 * onSite / onPage / onOverlay handler.
 *
 * - `"load"` (default): nothing. The route is matched once, against the URL
 *   the page loaded with.
 * - `"match"`: the run starts when the URL starts matching and ends when it
 *   stops.
 * - `"every"`: also restarts on each change while it matches.
 */
export type Navigation = "load" | "match" | "every";
const NAVIGATIONS: Navigation[] = ["load", "match", "every"];

/** webRequest resource type names: the values a route's `resourceTypes` accepts (also ctx.resourceType). */
export const RESOURCE_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
] as const;

/**
 * A handler's route, validated and normalized ({@link normalizeRoute}): which
 * requests or documents the handler applies to and how it runs.
 *
 * Saved with the script's metadata (`meta.routes`), so code reading a stored
 * one goes through {@link routePatterns} for its lists.
 */
export interface RouteMeta {
    /** Kind of handler the route belongs to. */
    kind: RouteKind;
    /** Registration order within kind (0-based); onSite and onPage share the `"onDocument"` count. */
    index: number;
    /** The source line of the tweak.* call that registered it (Problems view). */
    line?: number;
    /** URLPatterns; [] matches nothing. */
    url: string[];
    /** URLPatterns that exclude a URL the `url` patterns match; [] excludes nothing. */
    exclude: string[];
    /** Uppercase HTTP methods; undefined = any. Network routes only. */
    methods?: string[];
    /** webRequest resource types ({@link RESOURCE_TYPES}); undefined = any. Network routes only. */
    resourceTypes?: string[];
    /** The strategy that runs the handler; required on network routes, absent on onDocument and onOverlay. */
    strategy?: Strategy;
    /** onDocument / onOverlay only: when in the document's load it runs. */
    when?: DocumentWhen;
    /** onDocument / onOverlay: follow in-place URL changes; absent = "load". */
    navigation?: Exclude<Navigation, "load">;
    /** onDocument: the JavaScript world, "isolated" (tweak.onPage) or "page" (tweak.onSite). */
    world?: PageWorld;
    /** The API name it was registered with, when it differs from `kind` (tweak.onSite / tweak.onPage → kind "onDocument"). */
    api?: "onSite" | "onPage";
    /** tweak.onSite / tweak.onPage: which of the script's calls to that API it is (0-based), when it differs from `index`. */
    n?: number;
    /** Set for a call in this library's code (a function it exports, called by the script): `n` counts that library's calls. */
    lib?: string;
    /** Set for a call in one of the tweak's modules (its script name), run with the entry's `tweak`. */
    file?: string;
    /**
     * onSite / onPage / onOverlay: the handler's stable name, `"onPage:2"`
     * (its API and which of the source's calls to it it is): its handle's
     * id and what its run's owned things are keyed by. See {@link placeKeyer}.
     */
    key?: string;
    /** onResponseBody only: which bodies the handler gets (see {@link takesBinary} / {@link takesText}). */
    binary?: BinaryOption;
    /** The route's `layer` option; absent = not declared (see {@link handlerLayer}). */
    layer?: Layer;
}

/**
 * Where a handler sits in the stack of one stage: `base` runs first,
 * `override` last, and the last word wins.
 */
export type Layer = "base" | "site" | "override";

/** Every {@link Layer}, in run order. */
export const LAYER_ORDER: readonly Layer[] = ["base", "site", "override"];

/** Whether `v` is a {@link Layer} name. */
export function isLayer(v: unknown): v is Layer {
    return typeof v === "string" && (LAYER_ORDER as readonly string[]).includes(v);
}

/** A layer's position in {@link LAYER_ORDER}; an unknown or missing one counts as `site`. */
export function layerRank(l: Layer | undefined): number {
    const i = l ? LAYER_ORDER.indexOf(l) : -1;
    return i < 0 ? 1 : i;
}

/** The layer a route gets from its hosts alone: `base` if any url pattern can match any host, else `site`. */
export function inferLayer(route: Pick<RouteMeta, "url">): Layer {
    const ps = routePatterns(route.url);
    return ps.some((p) => hostKeyOf(p) === null) ? "base" : "site";
}

/** A script's explicit layers, from outside its routes. */
export interface ScriptLayers {
    /** Set by the user in the tweak's settings (popup, Editor, `.tweak/settings.json`). */
    user?: Layer;
    /** The tweak's package.json `tangitweak.layer`. */
    pkg?: Layer;
}

/** Where a handler's layer came from. */
export type LayerSource = "user" | "route" | "package" | "inferred";

/** A handler's layer and where it came from. */
export interface HandlerLayer {
    /** The layer the handler runs in. */
    layer: Layer;
    /** Where that layer came from. */
    source: LayerSource;
}

/**
 * A handler's layer and where it came from. The user's setting wins, then
 * the route's `layer` option, then package.json, then {@link inferLayer}.
 */
export function handlerLayer(route: Pick<RouteMeta, "url" | "layer">, scriptLayers?: ScriptLayers): HandlerLayer {
    if (isLayer(scriptLayers?.user)) return { layer: scriptLayers!.user!, source: "user" };
    if (isLayer(route.layer)) return { layer: route.layer, source: "route" };
    if (isLayer(scriptLayers?.pkg)) return { layer: scriptLayers!.pkg!, source: "package" };
    return { layer: inferLayer(route), source: "inferred" };
}

/**
 * Stable-sorts items by their handler's layer (base first), keeping the
 * given order (script list, then registration) within a layer.
 */
export function sortByLayer<T>(items: T[], layerOf: (item: T) => Layer): T[] {
    return items
        .map((item, i) => ({ item, i, r: layerRank(layerOf(item)) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.item);
}

/**
 * The onResponseBody `binary` option.
 *
 * - Unset or `false`: text only (`false` also silences the "body is binary"
 *   warning).
 * - `true`: binary only.
 * - `"both"`: text and binary bodies.
 */
export type BinaryOption = boolean | "both";

/** Whether an onResponseBody route gets binary bodies (`binary: true` or `"both"`). */
export const takesBinary = (r: {
    /** The route's `binary` option. */
    binary?: BinaryOption;
}): boolean => r.binary === true || r.binary === "both";
/** Whether an onResponseBody route gets text bodies (any `binary` but `true`). */
export const takesText = (r: {
    /** The route's `binary` option. */
    binary?: BinaryOption;
}): boolean => r.binary !== true;

/**
 * The strategy that owns a network route.
 *
 * onDocument/onOverlay routes have none: for them it returns undefined,
 * despite the return type.
 */
export function effectiveStrategy(route: Pick<RouteMeta, "strategy">): Strategy {
    return route.strategy!;
}

function list(v: unknown, what: string, where: string): string[] {
    if (v === undefined || v === null) return [];
    const arr = Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const x of arr) {
        if (typeof x !== "string") throw new Error(`${where}: ${what} entries must be strings, got ${typeof x}`);
        out.push(x);
    }
    return out;
}

/**
 * Reads a RouteMeta string list defensively: recovers if an older build
 * persisted an array Proxy as `{ "0": ... }`.
 *
 * @param v - An array, an object of strings, a single string or anything else.
 * @returns The strings in it; non-string entries are dropped, anything else gives [].
 */
export function routePatterns(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (v && typeof v === "object") return Object.values(v).filter((x): x is string => typeof x === "string");
    return typeof v === "string" ? [v] : [];
}

function checkPatterns(ps: string[], what: string, where: string): void {
    for (const p of ps) {
        const err = matchPatternError(p);
        if (err) throw new Error(`${where}: ${what} ${err.replace(/^match /, "")}`);
    }
}

/**
 * Validates and normalizes a registration's route argument.
 *
 * - onSite / onPage / onOverlay take a URL pattern, a list of them or
 *   `{ url, exclude, when, navigation }`; `when` defaults to
 *   `"document_start"` for onSite and `"document_end"` otherwise.
 * - Network handlers take `{ url, exclude, methods, resourceTypes, strategy, layer }`
 *   (plus `binary` for onResponseBody); `strategy` is required, methods are
 *   uppercased.
 *
 * Compiling a script calls it for each registration, in every context that
 * runs the script's top level.
 *
 * @param kind - The handler's kind.
 * @param raw - The first argument the script passed.
 * @param index - The registration's order within `kind` (becomes {@link RouteMeta.index}).
 * @param api - The API that registered it, for onSite / onPage / onOverlay.
 * @throws A script error on anything unusable (it surfaces like a syntax
 *   error), naming the `tweak.<api>` call and, where it helps, an example.
 */
export function normalizeRoute(kind: RouteKind, raw: unknown, index: number, api?: PlaceApi): RouteMeta {
    const name = api || kind;
    const where = `tweak.${name}`;
    const doc = !isNetKind(kind);
    const example = doc ? `tweak.${name}("*://example.com/*", handler)` : `tweak.${kind}({ url: "*://example.com/*", strategy: "helper" }, handler)`;
    const shape = doc ? "a URL pattern (string, string[] or { url })" : "a route { url, strategy }";
    if (typeof raw === "function" || raw === undefined || raw === null) throw new Error(`${where}: first argument must be ${shape} — e.g. ${example}`);
    let obj: any;
    if (typeof raw === "string" || Array.isArray(raw)) {
        if (!doc) throw new Error(`${where}: a bare URL pattern has no strategy — pass { url, strategy } instead, e.g. ${example}. Strategies: ${STRATEGIES.join(", ")}`);
        obj = { url: raw };
    } else if (typeof raw === "object") obj = raw;
    else throw new Error(`${where}: first argument must be ${shape}, got ${typeof raw}`);
    if (obj.url === undefined && obj.match !== undefined) throw new Error(`${where}: the route field is "url", not "match"`);
    if (obj.url === undefined) throw new Error(`${where}: route is missing "url"`);
    const url = list(obj.url, "url", where);
    const exclude = list(obj.exclude, "exclude", where);
    checkPatterns(url, "url", where);
    checkPatterns(exclude, "exclude", where);
    const route: RouteMeta = { kind, index, url, exclude };
    if (api === "onSite" || api === "onPage") route.api = api;
    if (doc) {
        const runs = kind === "onOverlay" ? "in the overlay" : api === "onSite" ? "in the site's world" : "in the page";
        for (const k of ["methods", "resourceTypes", "strategy", "binary", "layer"]) {
            if (obj[k] !== undefined) throw new Error(`${where}: "${k}" doesn't apply to ${name} (it runs ${runs}, not on requests)`);
        }
        if (obj.when !== undefined) {
            if (!DOCUMENT_WHENS.includes(obj.when)) throw new Error(`${where}: when must be one of ${DOCUMENT_WHENS.join(", ")}`);
            route.when = obj.when;
        } else route.when = api === "onSite" ? "document_start" : "document_end"; // onSite: ahead of the site's own code
        if (obj.navigation !== undefined) {
            if (!NAVIGATIONS.includes(obj.navigation)) throw new Error(`${where}: navigation must be one of ${NAVIGATIONS.map((n) => JSON.stringify(n)).join(", ")}, got ${JSON.stringify(obj.navigation)}`);
            if (obj.navigation !== "load") route.navigation = obj.navigation;
        }
        if (kind === "onDocument") route.world = api === "onSite" ? "page" : "isolated";
        return route;
    }
    if (obj.when !== undefined) throw new Error(`${where}: "when" applies to onSite, onPage and onOverlay only`);
    if (obj.navigation !== undefined) throw new Error(`${where}: "navigation" applies to onSite, onPage and onOverlay only`);
    if (obj.binary !== undefined) {
        if (kind !== "onResponseBody") throw new Error(`${where}: "binary" applies to onResponseBody only`);
        if (typeof obj.binary !== "boolean" && obj.binary !== "both") throw new Error(`${where}: binary must be true, false or "both", got ${JSON.stringify(obj.binary)}`);
        route.binary = obj.binary;
    }
    if (obj.methods !== undefined) {
        const m = list(obj.methods, "methods", where).map((x) => x.toUpperCase());
        route.methods = m;
    }
    if (obj.resourceTypes !== undefined) {
        const t = list(obj.resourceTypes, "resourceTypes", where);
        const bad = t.find((x) => !(RESOURCE_TYPES as readonly string[]).includes(x));
        if (bad) throw new Error(`${where}: unknown resource type "${bad}" — one of ${RESOURCE_TYPES.join(", ")}`);
        route.resourceTypes = t;
    }
    if (obj.strategy === undefined) throw new Error(`${where}: route is missing "strategy" — every handler names the strategy that runs it, e.g. ${example}. Strategies: ${STRATEGIES.join(", ")}`);
    if (Array.isArray(obj.strategy)) throw new Error(`${where}: strategy is a single value (one of ${STRATEGIES.join(", ")}), not a priority list`);
    if (!STRATEGIES.includes(obj.strategy)) throw new Error(`${where}: unknown strategy "${obj.strategy}" — one of ${STRATEGIES.join(", ")}`);
    route.strategy = obj.strategy;
    if (obj.layer !== undefined) {
        if (!isLayer(obj.layer)) throw new Error(`${where}: layer must be one of ${LAYER_ORDER.map((l) => JSON.stringify(l)).join(", ")}, got ${JSON.stringify(obj.layer)}`);
        route.layer = obj.layer;
    }
    return route;
}

/**
 * Whether the route matches a request: the exact (stage 2) check, url ∧
 * ¬exclude ∧ method ∧ type.
 *
 * @param method - HTTP method (any case); undefined skips the method check.
 * @param type - webRequest resource type; undefined skips the type check.
 */
export function routeMatches(route: RouteMeta, url: string, method?: string, type?: string): boolean {
    const urls = routePatterns(route.url);
    const exclude = routePatterns(route.exclude);
    if (!matchAny(urls, url)) return false;
    if (exclude.length && matchAny(exclude, url)) return false;
    if (route.methods && method && !route.methods.includes(method.toUpperCase())) return false;
    if (route.resourceTypes && type && !route.resourceTypes.includes(type)) return false;
    return true;
}

/** Whether the route re-checks its match on in-place URL changes (`navigation: "match" | "every"`). */
export const followsNav = (route: Pick<RouteMeta, "navigation">): boolean => !!route.navigation;

/**
 * Whether a document at url could run the route, now or after in-place
 * navigation: {@link routeMatches} for "load" routes; for routes that follow
 * navigation, only the origin has to match (pushState can't change it).
 */
export function routeMayMatch(route: RouteMeta, url: string): boolean {
    if (!followsNav(route)) return routeMatches(route, url);
    return originMatchAny(routePatterns(route.url), url);
}

/**
 * Routes bucketed by the hosts their `url` patterns can match, so a request
 * tests only the routes for its hostname (and its parent domains, for
 * `*.domain` hosts) plus the any-host ones, not every route. Results keep
 * the items' order.
 *
 * The index is built once, from the list as given: build a new one (or use
 * {@link indexRoutes}) when the list changes.
 *
 * @typeParam T - The indexed items, e.g. a strategy's handlers.
 */
export class RouteIndex<T> {
    private readonly exact = new Map<string, number[]>();
    private readonly suffix = new Map<string, number[]>();
    private readonly anyHost: number[] = [];

    /**
     * Buckets every item by the hosts of its route's `url` patterns.
     *
     * @param items - The items, in the order results keep.
     * @param routeOf - Gets an item's route.
     */
    constructor(
        /** The indexed items, as given. */
        readonly items: readonly T[],
        private readonly routeOf: (item: T) => RouteMeta
    ) {
        const add = (map: Map<string, number[]>, key: string, i: number) => {
            const at = map.get(key);
            if (!at) map.set(key, [i]);
            else if (at[at.length - 1] !== i) at.push(i);
        };
        items.forEach((item, i) => {
            const keys = routePatterns(routeOf(item).url).map(hostKeyOf);
            if (keys.some((k) => k === null)) this.anyHost.push(i);
            else
                for (const k of keys as ({ exact: string } | { suffix: string })[]) {
                    if ("exact" in k) add(this.exact, k.exact, i);
                    else add(this.suffix, k.suffix, i);
                }
        });
    }

    /**
     * The items whose routes could match url (a superset of the matches).
     *
     * A URL that doesn't parse gets every item.
     */
    candidates(url: string): T[] {
        let host: string;
        try {
            host = new URL(url).hostname;
        } catch {
            return [...this.items];
        }
        const at: number[][] = [this.anyHost, this.exact.get(host) ?? []];
        for (let i = host.indexOf("."); i >= 0; i = host.indexOf(".", i + 1)) at.push(this.suffix.get(host.slice(i + 1)) ?? []);
        const hits = at.filter((a) => a.length);
        if (hits.length === 1) return hits[0].map((i) => this.items[i]);
        return [...new Set(hits.flat())].sort((a, b) => a - b).map((i) => this.items[i]);
    }

    /** The items whose route matches ({@link routeMatches}), in order. */
    match(url: string, method?: string, type?: string): T[] {
        return this.candidates(url).filter((item) => routeMatches(this.routeOf(item), url, method, type));
    }

    /**
     * Whether some item's route matches ({@link routeMatches}) and passes `also`.
     *
     * @param also - An extra test for each candidate, checked before its route.
     */
    some(url: string, method?: string, type?: string, also: (item: T) => boolean = () => true): boolean {
        return this.candidates(url).some((item) => also(item) && routeMatches(this.routeOf(item), url, method, type));
    }
}

const indexes = new WeakMap<readonly unknown[], RouteIndex<any>>();

/**
 * The {@link RouteIndex} of a list, built once per list and cached while the
 * list lives.
 *
 * Don't mutate an indexed list (the index wouldn't see it): assign a new one.
 */
export function indexRoutes<T>(items: readonly T[], routeOf: (item: T) => RouteMeta): RouteIndex<T> {
    let index = indexes.get(items);
    if (!index) indexes.set(items, (index = new RouteIndex(items, routeOf)));
    return index;
}

/**
 * ctx.groups for a matched url: the named and numbered (`"0"`, `"1"`…
 * wildcard) groups of the first `url` pattern that matches, from every part
 * of the URL. Numbering restarts in each part, so a later part's group
 * replaces an earlier one of the same name.
 *
 * @returns The groups; `{}` when no pattern matches.
 */
export function routeGroups(route: RouteMeta, url: string): Record<string, string> {
    return matchGroups(routePatterns(route.url), url) || {};
}

/** Union of a script's route urls, without duplicates (badge / "active on this tab"; the script's `meta.match`). */
export function scriptUrls(routes: RouteMeta[] | undefined): string[] {
    const out = new Set<string>();
    for (const r of routes || []) for (const u of routePatterns(r.url)) out.add(u);
    return [...out];
}

/**
 * A URL the routes name (the default page URL of an overlay previewed in the
 * Editor): the first pattern made concrete (`*://` → `https://`, a `*.` host
 * prefix and other `*`s dropped, a `*` host → example.com) that its route
 * matches; else the first that parses; else https://example.com/.
 */
export function sampleUrl(routes: RouteMeta[]): string {
    const concrete = (p: string) =>
        p
            .replace(/^\*:\/\//, "https://")
            .replace(/:\/\/\*\./, "://")
            .replace(/:\/\/\*(?=[/:]|$)/, "://example.com")
            .replace(/\*/g, "");
    let parsed = "";
    for (const r of routes)
        for (const p of routePatterns(r.url)) {
            const u = concrete(p);
            try {
                new URL(u);
            } catch {
                continue;
            }
            if (routeMatches(r, u)) return u;
            parsed ||= u;
        }
    return parsed || "https://example.com/";
}

/**
 * Labels a route for logs, numbered from 1: `onResponseBody #2`.
 *
 * An onSite / onPage route is labeled with its API, numbered by its calls to
 * that API; one a library's code registered is numbered in that library:
 * `onPage #1 (utils/x)`.
 */
export function routeLabel(route: RouteMeta): string {
    return `${route.api || route.kind} #${(route.n ?? route.index) + 1}${route.lib === undefined ? "" : ` (${route.lib})`}`;
}

/** The world an onDocument route runs in; a route without `world` runs in `"page"`. */
export const pageWorld = (route: Pick<RouteMeta, "world">): PageWorld => route.world || "page";

/**
 * Whether this route can ever fire on the page hook, which sees only the
 * page's fetch/XHR: true unless its `resourceTypes` leave out
 * `"xmlhttprequest"`.
 */
export function hookCanSee(route: RouteMeta): boolean {
    return !route.resourceTypes || route.resourceTypes.includes("xmlhttprequest");
}

/**
 * The popup and Editor label of a tweak's "Automatic" layer choice: the
 * layers its network handlers get without a user setting, e.g.
 * `"Automatic (site)"`, `"Automatic (base, from package.json)"` or
 * `"Automatic (base and site)"`.
 *
 * @param routes - The script's routes; only network ones count.
 * @param pkg - The tweak's package.json `tangitweak.layer`.
 */
export function autoLayerLabel(routes: RouteMeta[], pkg?: Layer): string {
    const got = routes.filter((r) => isNetKind(r.kind)).map((r) => handlerLayer(r, { pkg }));
    if (!got.length) return "Automatic";
    const layers = LAYER_ORDER.filter((l) => got.some((g) => g.layer === l));
    const sources = new Set(got.map((g) => g.source));
    const from = sources.size === 1 && sources.has("package") ? ", from package.json" : sources.size === 1 && sources.has("route") ? ", from the routes" : "";
    return `Automatic (${layers.length > 1 ? `${layers.slice(0, -1).join(", ")} and ${layers[layers.length - 1]}` : layers[0]}${from})`;
}
