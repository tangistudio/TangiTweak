/** Per-handler routes: normalization, matching, required strategy, and the page-side shim. */
import { describe, expect, it } from "vitest";
import { RouteIndex, autoLayerLabel, effectiveStrategy, handlerLayer, inferLayer, isShadowOverlay, sortByLayer, hookCanSee, normalizeRoute, routeGroups, routeLabel, routeMatches, routeMayMatch, sampleUrl, scriptUrls, type RouteMeta } from "../src/shared/route";
import { domHandlersFor, makePageShim } from "../src/shared/pageShim";
import { compileScript } from "../src/shared/compile";

describe("routeMayMatch", () => {
    it("a route following navigation may match any URL on its origins; others need a full match", () => {
        const nav = normalizeRoute("onDocument", { url: "https://a.com/cart/*", navigation: "match" }, 0);
        expect(routeMayMatch(nav, "https://a.com/home")).toBe(true);
        expect(routeMayMatch(nav, "https://b.com/cart/1")).toBe(false);
        expect(routeMayMatch(nav, "http://a.com/cart/1")).toBe(false);
        const load = normalizeRoute("onDocument", "https://a.com/cart/*", 0);
        expect(routeMayMatch(load, "https://a.com/home")).toBe(false);
        expect(routeMayMatch(load, "https://a.com/cart/1")).toBe(true);
    });
});

describe("isShadowOverlay", () => {
    it("debuggerSafe onOverlays always; every other onOverlay with the setting on; never tweak.site or onPage", () => {
        const plain = { kind: "onOverlay", debuggerSafe: undefined } as const;
        const safe = { kind: "onOverlay", debuggerSafe: true } as const;
        const site = { kind: "onOverlay", api: "site", debuggerSafe: true } as const;
        const page = { kind: "onDocument", debuggerSafe: undefined } as const;
        expect([plain, safe, site, page].map((r) => isShadowOverlay(r, false))).toEqual([false, true, false, false]);
        expect([plain, safe, site, page].map((r) => isShadowOverlay(r, true))).toEqual([true, true, false, false]);
    });
});

describe("normalizeRoute", () => {
    it("accepts { url, strategy } with a string or a list", () => {
        expect(normalizeRoute("onRequest", { url: "*://a.com/*", strategy: "helper" }, 0)).toEqual({ kind: "onRequest", index: 0, url: ["*://a.com/*"], exclude: [], strategy: "helper" });
        expect(normalizeRoute("onRequest", { url: ["*://a.com/*", "*://b.com/*"], strategy: "page" }, 1).url).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(normalizeRoute("onResponseBody", { url: "*", exclude: "*://a.com/*", methods: ["get", "Post"], resourceTypes: ["script"], strategy: "debugger" }, 2)).toEqual({
            kind: "onResponseBody",
            index: 2,
            url: ["*"],
            exclude: ["*://a.com/*"],
            methods: ["GET", "POST"],
            resourceTypes: ["script"],
            strategy: "debugger",
        });
    });

    it("when defaults per place (onSite: document_start; onPage, onOverlay: document_end); request-only options are rejected", () => {
        expect(normalizeRoute("onDocument", "*", 0).when).toBe("document_end");
        expect(normalizeRoute("onDocument", "*", 0, "onPage").when).toBe("document_end");
        expect(normalizeRoute("onDocument", "*", 0, "onSite").when).toBe("document_start");
        expect(normalizeRoute("onOverlay", "*", 0, "onOverlay").when).toBe("document_end");
        expect(normalizeRoute("onDocument", { url: "*", when: "document_end" }, 0, "onSite").when).toBe("document_end");
        expect(normalizeRoute("onDocument", { url: "*", when: "document_idle" }, 0).when).toBe("document_idle");
        expect(() => normalizeRoute("onDocument", { url: "*", when: "later" }, 0)).toThrow(/when must be one of/);
        expect(() => normalizeRoute("onDocument", { url: "*", when: "DOMContentLoaded" }, 0)).toThrow(/when must be one of document_start, document_end, document_idle$/);
        expect(() => normalizeRoute("onDocument", { url: "*", methods: ["GET"] }, 0)).toThrow(/doesn't apply to onDocument/);
        expect(() => normalizeRoute("onRequest", { url: "*", when: "document_idle" }, 0)).toThrow(/"when" applies to onSite, onPage, onOverlay and site only/);
        expect(normalizeRoute("onOverlay", { url: "*", navigation: "every" }, 0, "onOverlay").navigation).toBe("every");
        expect(normalizeRoute("onDocument", { url: "*", navigation: "load" }, 0)).not.toHaveProperty("navigation");
        expect(() => normalizeRoute("onDocument", { url: "*", navigation: "always" }, 0)).toThrow(/navigation must be one of "load", "match", "every"/);
        expect(() => normalizeRoute("onRequest", { url: "*", navigation: "match", strategy: "page" }, 0)).toThrow(/"navigation" applies to onSite, onPage, onOverlay and site only/);
    });

    it("tweak.replaceResponse was removed: calling it throws with the onRequest rewrite", () => {
        const r = compileScript(`import { tweak } from "tangitweak"; tweak.replaceResponse({ url: "*://a.com/*", strategy: "page" }, () => "x");`);
        expect(r.error).toContain("tweak.replaceResponse was removed: use tweak.onRequest(route, () => ({ replaceResponse: { body } }))");
        expect(makePageShim({ world: "isolated", params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined } } as any).host.module("index").tweak.replaceResponse).toThrow(/was removed: use tweak\.onRequest/);
    });

    it("network handlers require a strategy: bare patterns and strategy-less objects throw", () => {
        for (const kind of ["onRequest", "onResponseHeaders", "onResponseBody"] as const) {
            expect(() => normalizeRoute(kind, "*://a.com/*", 0)).toThrow(/bare URL pattern has no strategy — pass \{ url, strategy \}/);
            expect(() => normalizeRoute(kind, ["*://a.com/*"], 0)).toThrow(/bare URL pattern/);
            expect(() => normalizeRoute(kind, { url: "*://a.com/*" }, 0)).toThrow(/missing "strategy"/);
        }
        expect(normalizeRoute("onDocument", "*://a.com/*", 0).url).toEqual(["*://a.com/*"]);
        expect(normalizeRoute("onDocument", ["*://a.com/*"], 0).url).toEqual(["*://a.com/*"]);
    });

    it("rejects missing / malformed routes", () => {
        expect(() => normalizeRoute("onRequest", () => {}, 0)).toThrow(/first argument must be a route \{ url, strategy \}/);
        expect(() => normalizeRoute("onRequest", 42, 0)).toThrow(/first argument/);
        expect(() => normalizeRoute("onRequest", {}, 0)).toThrow(/missing "url"/);
        expect(() => normalizeRoute("onRequest", { url: [1], strategy: "helper" }, 0)).toThrow(/must be strings/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "auto" }, 0)).toThrow(/unknown strategy/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: ["page"] }, 0)).toThrow(/single value/);
    });
});

describe("routeMatches", () => {
    const r = (raw: unknown) => normalizeRoute("onRequest", typeof raw === "object" && !Array.isArray(raw) ? { strategy: "helper", ...raw } : { url: raw, strategy: "helper" }, 0);

    it("url ∧ ¬exclude", () => {
        const route = r({ url: "https://x.com/api/*", exclude: ["https://x.com/api/health", "https://x.com/api/metrics*"] });
        expect(routeMatches(route, "https://x.com/api/users")).toBe(true);
        expect(routeMatches(route, "https://x.com/api/health")).toBe(false);
        expect(routeMatches(route, "https://x.com/api/metrics/cpu")).toBe(false);
        expect(routeMatches(route, "https://y.com/api/users")).toBe(false);
    });

    it("methods (case-insensitive) and types; unknown method/type passes", () => {
        const route = r({ url: "*", methods: ["POST"], resourceTypes: ["xmlhttprequest"] });
        expect(routeMatches(route, "https://x.com/", "post", "xmlhttprequest")).toBe(true);
        expect(routeMatches(route, "https://x.com/", "GET", "xmlhttprequest")).toBe(false);
        expect(routeMatches(route, "https://x.com/", "POST", "script")).toBe(false);
        expect(routeMatches(route, "https://x.com/")).toBe(true);
    });

    it("empty lists match nothing", () => {
        expect(routeMatches(r([]), "https://x.com/")).toBe(false);
        expect(routeMatches(r({ url: "*", methods: [] }), "https://x.com/", "GET")).toBe(false);
        expect(routeMatches(r({ url: "*", resourceTypes: [] }), "https://x.com/", "GET", "script")).toBe(false);
    });

    it("* and <all_urls> match everything", () => {
        expect(routeMatches(r("*"), "https://x.com/a?b")).toBe(true);
        expect(routeMatches(r("<all_urls>"), "http://localhost:8080/")).toBe(true);
    });

    it("named groups", () => {
        expect(routeGroups(r("https://x.com/users/:id"), "https://x.com/users/42")).toMatchObject({ id: "42" });
        expect(routeGroups(r("*"), "https://x.com/")).not.toHaveProperty("id");
    });
});

describe("RouteIndex", () => {
    const patterns = [
        "*://api.example.com/*",
        "*://*.example.com/*",
        "https://Example.COM:8080/x/*",
        "*://bücher.de/*",
        "*://*/*",
        "<all_urls>",
        "*://exa*mple.com/*",
        "*://example.com*",
        "*://:sub.example.org/*",
        "not a pattern",
    ];
    const route = (url: string, index: number): RouteMeta => ({ kind: "onRequest", index, url: [url], exclude: [], strategy: "page" });
    const routes = patterns.map(route);
    const urls = [
        "https://api.example.com/v1",
        "https://a.b.example.com/",
        "https://example.com/",
        "https://example.com:8080/x/y",
        "https://xn--bcher-kva.de/",
        "https://example.com.evil.net/",
        "https://exaXmple.com/",
        "https://other.org/",
        "https://sub.example.org/",
        "not a url",
    ];

    it("matches exactly what testing every route does, in order", () => {
        const index = new RouteIndex(routes, (r) => r);
        for (const url of urls) expect(index.match(url)).toEqual(routes.filter((r) => routeMatches(r, url)));
    });

    it("tests only the routes whose host could match", () => {
        const many = Array.from({ length: 1000 }, (_, i) => route(`*://site${i}.example.org/*`, i));
        const index = new RouteIndex(many, (r) => r);
        expect(index.candidates("https://site7.example.org/a")).toEqual([many[7]]);
        expect(index.candidates("https://elsewhere.net/")).toEqual([]);
    });
});

describe("strategy", () => {
    it("effectiveStrategy is the route's own strategy", () => {
        expect(effectiveStrategy({ strategy: "debugger" })).toBe("debugger");
        expect(effectiveStrategy(normalizeRoute("onRequest", { url: "*", strategy: "page" }, 0))).toBe("page");
    });

    it("hookCanSee: only fetch/XHR", () => {
        expect(hookCanSee(normalizeRoute("onRequest", { url: "*", strategy: "page" }, 0))).toBe(true);
        expect(hookCanSee(normalizeRoute("onRequest", { url: "*", resourceTypes: ["script"], strategy: "page" }, 0))).toBe(false);
    });

    it("labels and url union", () => {
        const a = normalizeRoute("onResponseBody", { url: ["*://a.com/*", "*://b.com/*"], strategy: "helper" }, 1);
        const b = normalizeRoute("onDocument", "*://a.com/*", 0);
        expect(routeLabel(a)).toBe("onResponseBody #2");
        expect(scriptUrls([a, b])).toEqual(["*://a.com/*", "*://b.com/*"]);
    });
});

describe("page shim (onPage in the page)", () => {
    const shim = () => makePageShim({ world: "isolated", params: { host: "a.com", n: 3 }, log: () => {}, storage: { get: () => undefined, set: () => undefined } });

    it("collects several onPage handlers with routes; network handlers are inert", () => {
        const { host, dom } = shim();
        const tweak = host.module("main.ts").tweak;
        tweak.onRequest({ url: "*", strategy: "helper" }, () => {});
        tweak.onPage({ url: "*://a.com/*", when: "document_idle" }, () => 1);
        tweak.onPage("*://b.com/*", () => 2);
        expect(dom.map((d) => [d.when, d.route.index])).toEqual([
            ["document_idle", 0],
            ["document_end", 1],
        ]);
        expect(domHandlersFor(dom, "https://a.com/x").map((d) => d.fn({}))).toEqual([1]);
        expect(domHandlersFor(dom, "https://c.com/")).toEqual([]);
    });

    it("params resolve from the bundle", () => {
        const tweak = shim().host.module("main.ts").tweak;
        expect(tweak.params({ host: { type: "string" }, n: { type: "number" } })).toEqual({ host: "a.com", n: 3 });
        expect(() => tweak.onPage("*")).toThrow(/second argument/);
    });
});

describe("sampleUrl (the Editor preview's default page URL)", () => {
    const r = (url: string[], exclude: string[] = []) => normalizeRoute("onOverlay", { url, exclude }, 0);
    it("makes the first pattern concrete, one its route matches", () => {
        expect(sampleUrl([r(["https://app.example.com/dash/*"])])).toBe("https://app.example.com/dash/");
        expect(sampleUrl([r(["*://*.example.com/*"])])).toBe("https://example.com/");
        expect(sampleUrl([r(["*://*/*"])])).toBe("https://example.com/");
        expect(sampleUrl([r(["https://a.example/x"]), r(["https://b.example/"])])).toBe("https://a.example/x");
    });
    it("skips what the route excludes or what doesn't parse, and falls back to example.com", () => {
        expect(sampleUrl([r(["https://a.example/*"], ["https://a.example/*"]), r(["https://b.example/y"])])).toBe("https://b.example/y");
        expect(sampleUrl([r(["https://a.example/*"], ["https://a.example/*"])])).toBe("https://a.example/");
        expect(sampleUrl([r(["*"])])).toBe("https://example.com/");
        expect(sampleUrl([])).toBe("https://example.com/");
    });
});

describe("handler layers", () => {
    it("infers base for any-host patterns and site otherwise", () => {
        expect(inferLayer({ url: ["*://*/*"] })).toBe("base");
        expect(inferLayer({ url: ["<all_urls>"] })).toBe("base");
        expect(inferLayer({ url: ["https://a.com/*"] })).toBe("site");
        expect(inferLayer({ url: ["*://*.a.com/*"] })).toBe("site");
        expect(inferLayer({ url: ["https://a.com/*", "*://*/api/*"] })).toBe("base");
    });

    it("the user setting beats the route option, which beats package.json, which beats inference", () => {
        const r = { url: ["*://*/*"], layer: "override" as const };
        expect(handlerLayer(r, { user: "site", pkg: "base" })).toEqual({ layer: "site", source: "user" });
        expect(handlerLayer(r, { pkg: "base" })).toEqual({ layer: "override", source: "route" });
        expect(handlerLayer({ url: ["https://a.com/*"] }, { pkg: "base" })).toEqual({ layer: "base", source: "package" });
        expect(handlerLayer({ url: ["https://a.com/*"] })).toEqual({ layer: "site", source: "inferred" });
    });

    it("normalizeRoute validates the layer option", () => {
        expect(normalizeRoute("onRequest", { url: "*://a.com/*", strategy: "helper", layer: "override" }, 0).layer).toBe("override");
        expect(() => normalizeRoute("onRequest", { url: "*://a.com/*", strategy: "helper", layer: "top" } as any, 0)).toThrow(/layer/);
        // onSite takes a layer (its ctx.patch chains); onPage doesn't
        expect(normalizeRoute("onDocument", { url: "*://a.com/*", layer: "base" }, 0, "onSite").layer).toBe("base");
        expect(() => normalizeRoute("onDocument", { url: "*://a.com/*", layer: "base" }, 0, "onPage")).toThrow(/doesn't apply/);
    });

    it("sorts stably by layer", () => {
        const items = [{ n: 1, l: "site" }, { n: 2, l: "override" }, { n: 3, l: "base" }, { n: 4, l: "site" }] as const;
        expect(sortByLayer([...items], (i) => i.l).map((i) => i.n)).toEqual([3, 1, 4, 2]);
    });

    it("labels the automatic choice", () => {
        const site = normalizeRoute("onRequest", { url: "https://a.com/*", strategy: "helper" }, 0);
        const any = normalizeRoute("onRequest", { url: "*://*/*", strategy: "helper" }, 1);
        expect(autoLayerLabel([site])).toBe("Automatic (site)");
        expect(autoLayerLabel([site, any])).toBe("Automatic (base and site)");
        expect(autoLayerLabel([site], "base")).toContain("base");
    });
});
