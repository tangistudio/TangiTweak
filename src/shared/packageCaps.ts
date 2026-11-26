/**
 * What an installed tweak package can do, read off its entries' compiled
 * routes and its package.json.
 *
 * The background computes {@link Capabilities} with {@link capabilitiesOf}
 * when it analyzes a package (install, import or update check) and stores
 * them with the installed package. The install page lists them for people
 * with {@link describeCapabilities}, riskiest first. When an update arrives,
 * {@link addedCapabilities} compares it with the installed version: an update
 * that can do more waits for approval instead of applying itself.
 * `tangitweak/test` exposes the same object as a loaded tweak's
 * `capabilities`.
 *
 * @module
 */

import { builtinSpec } from "./builtinSpecs";
import type { ResMeta } from "./metaParser";
import { isSiteRoute, routePatterns } from "./route";

/**
 * What a package can do, as plain data: stored with the installed package,
 * compared across updates and shown on the install page.
 *
 * Every list is deduplicated and sorted by {@link capabilitiesOf}.
 */
export interface Capabilities {
    /** URL match patterns its handlers run on (`"*://example.com/*"`, `"<all_urls>"`), from every route's `url`. */
    urls: string[];
    /** Network strategies its network handlers intercept with (`"helper"`, `"debugger"`, …); page and overlay handlers add none. */
    strategies: string[];
    /** Whether it registers `tweak.onSite` code, which runs in the site's own JavaScript world (an `onDocument` route whose world isn't `"isolated"`). */
    pageJs: boolean;
    /** Whether it registers a `tweak.onOverlay` handler, which draws an overlay over pages. */
    overlay: boolean;
    /** Whether it registers a `tweak.site` handler, which replaces matching pages with a custom app and bridges origin storage. */
    site?: boolean;
    /** Hosts its `tweak.fetch` calls reach, as package.json's `tangitweak.connect` declares them. */
    connect: string[];
    /**
     * npm packages it depends on, downloaded from unpkg: its package.json
     * `dependencies` names, without TangiTweak's built-in modules
     * (`tangitweak`, React and valtio).
     */
    packages: string[];
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * Reads what a package can do off its compiled routes and package.json.
 *
 * Runs in the background when a package is analyzed for install, import or
 * an update and in `tangitweak/test`.
 *
 * @param routes The compiled routes of the package's entry scripts.
 * @param connect The hosts its package.json's `tangitweak.connect` lists.
 * @param dependencies Its package.json `dependencies` (name → range); names of TangiTweak's built-in modules are left out of {@link Capabilities.packages}.
 * @returns The capabilities, each list deduplicated and sorted.
 */
export function capabilitiesOf(routes: ResMeta["routes"], connect: string[], dependencies: Record<string, string> = {}): Capabilities {
    const packages = Object.keys(dependencies).filter((n) => !builtinSpec(n));
    const site = routes.some((r) => isSiteRoute(r));
    return {
        urls: sorted(routes.flatMap((r) => routePatterns(r.url))),
        strategies: sorted(routes.flatMap((r) => (r.strategy ? [r.strategy] : []))),
        pageJs: routes.some((r) => r.kind === "onDocument" && r.world !== "isolated"),
        overlay: routes.some((r) => r.kind === "onOverlay" && !isSiteRoute(r)),
        ...(site ? { site: true } : {}),
        connect: sorted(connect),
        packages: sorted(packages),
    };
}

const ALL_URLS = /^(<all_urls>|\*:\/\/\*\/\*|\*:\/\/\*(:\*)?\/\*|https?\*?:\/\/\*\/\*|\*)$/;
const cleanUrls = (urls: unknown): string[] => (Array.isArray(urls) ? urls.flatMap(routePatterns) : routePatterns(urls));

/**
 * Whether a URL match pattern matches every site: `<all_urls>`, `*`,
 * `*://*\/*` (optionally with `:*` after the host), `http://*\/*` or
 * `https://*\/*`.
 */
export const isAllUrls = (pattern: string): boolean => typeof pattern === "string" && ALL_URLS.test(pattern.trim());

/** How risky a capability is, as {@link describeCapabilities} rates it for the install page. */
export type Risk = "high" | "medium" | "low";

/**
 * Describes capabilities as lines for people, riskiest first: what the
 * install page lists under what the tweak can do.
 *
 * - `high`: running on every site ({@link isAllUrls}), the `debugger` strategy.
 * - `medium`: `tweak.onSite` code, the `helper` strategy.
 * - `low`: the other sites it runs on, the other strategies, overlays,
 *   `connect` hosts and npm packages.
 *
 * With none of these it returns one line saying it registers no handlers.
 *
 * @param c The capabilities, as {@link capabilitiesOf} returns them.
 * @returns One entry per line, sorted by risk.
 */
export function describeCapabilities(c: Capabilities): {
    /** The line to show: a capitalized sentence without a final period, e.g. `"Runs on every site"`. */
    text: string;
    /** How risky this capability is. */
    risk: Risk;
}[] {
    const out: { text: string; risk: Risk }[] = [];
    const urls = cleanUrls(c.urls);
    if (urls.some(isAllUrls)) out.push({ text: "Runs on every site", risk: "high" });
    if (c.strategies.includes("debugger")) out.push({ text: 'Intercepts with the browser debugger (strategy "debugger": a banner shows on the tab)', risk: "high" });
    if (c.pageJs) out.push({ text: "Runs code in the site's own JavaScript world", risk: "medium" });
    if (c.site) out.push({ text: "Replaces the website with a custom app and reads its storage", risk: "medium" });
    if (c.strategies.includes("helper")) out.push({ text: 'Intercepts through the local helper process (strategy "helper")', risk: "medium" });
    const sites = urls.filter((u) => !isAllUrls(u));
    if (sites.length) out.push({ text: `Runs on ${sites.join(", ")}`, risk: "low" });
    const nets = c.strategies.filter((s) => s !== "debugger" && s !== "helper");
    if (nets.length) out.push({ text: `Intercepts requests (${nets.join(", ")})`, risk: "low" });
    if (c.overlay) out.push({ text: "Draws an overlay over pages", risk: "low" });
    if (c.connect.length) out.push({ text: `Connects to ${c.connect.join(", ")}`, risk: "low" });
    if (c.packages.length) out.push({ text: `Imports ${c.packages.join(", ")} from npm`, risk: "low" });
    if (!out.length) out.push({ text: "Registers no handlers with its current settings", risk: "low" });
    const rank: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.risk] - rank[b.risk]);
}

/**
 * Lists what `next` can do that `prev` couldn't: new sites, strategies,
 * `tweak.onSite` code, an overlay, `connect` hosts or npm packages.
 *
 * The background uses it on update: a non-empty result makes the update wait
 * for review and its lines are joined into the reason. New sites don't count
 * when `prev` already ran on every site.
 *
 * @param prev The installed version's capabilities.
 * @param next The update's capabilities.
 * @returns Lowercase phrases such as `"runs on *://a.com/*"`; empty when `next` can do the same or less.
 */
export function addedCapabilities(prev: Capabilities, next: Capabilities): string[] {
    const out: string[] = [];
    const prevUrls = cleanUrls(prev.urls);
    const nextUrls = cleanUrls(next.urls);
    const prevAll = prevUrls.some(isAllUrls);
    const urls = prevAll ? [] : nextUrls.filter((u) => !prevUrls.includes(u));
    if (urls.length) out.push(`runs on ${urls.join(", ")}`);
    const strategies = next.strategies.filter((s) => !prev.strategies.includes(s));
    if (strategies.length) out.push(`intercepts with ${strategies.join(", ")}`);
    if (next.pageJs && !prev.pageJs) out.push("runs code in the site's own JavaScript world");
    if (next.site && !prev.site) out.push("replaces the website with a custom app");
    if (next.overlay && !prev.overlay) out.push("draws an overlay");
    const connect = next.connect.filter((h) => !prev.connect.includes(h));
    if (connect.length) out.push(`connects to ${connect.join(", ")}`);
    const packages = next.packages.filter((p) => !prev.packages.includes(p));
    if (packages.length) out.push(`imports ${packages.join(", ")}`);
    return out;
}
