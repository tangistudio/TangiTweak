import { describe, it, expect } from "vitest";
import { compileScript, toRunnableJs } from "../src/shared/compile";
import { makePageShim, domHandlersFor, type PageShim } from "../src/shared/pageShim";
import { scriptFunction } from "../src/shared/scriptFn";
import { isNetKind, normalizeRoute, pageWorld, routeLabel } from "../src/shared/route";
import { inertRemote, SITE_NO_STORES, SiteCannotCallError } from "../src/shared/remote";

const shim = (world?: "page" | "isolated") => makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world });

describe("tweak.onPage", () => {
    it("registers kind onDocument, labelled onPage", () => {
        const c = compileScript(`import { tweak } from "tangitweak"; tweak.onPage("*://a.com/*", () => {});\ntweak.onPage("*://b.com/*", () => {});`);
        expect(c.error).toBeNull();
        const [a, b] = c.handlers.onDocument.map((h) => h.route);
        expect(a.kind).toBe("onDocument");
        expect(a.api).toBe("onPage");
        expect([a.index, b.index]).toEqual([0, 1]);
        expect([routeLabel(a), routeLabel(b)]).toEqual(["onPage #1", "onPage #2"]);
    });

    it("tweak.onSite runs in the site's world, tweak.onPage in the isolated world", () => {
        const c = compileScript(`import { tweak } from "tangitweak"; tweak.onPage("*", () => {});\ntweak.onSite("*", () => {});\ntweak.onPage({ url: "*", when: "document_idle" }, () => {});`);
        expect(c.error).toBeNull();
        const [iso, site, idle] = c.handlers.onDocument.map((h) => h.route);
        expect([iso, site, idle].map(pageWorld)).toEqual(["isolated", "page", "isolated"]);
        expect([iso, site, idle].map((r) => r.api)).toEqual(["onPage", "onSite", "onPage"]);
        expect([iso, site, idle].map((r) => r.key)).toEqual(["onPage:0", "onSite:0", "onPage:1"]);
        expect([iso, site, idle].map(routeLabel)).toEqual(["onPage #1", "onSite #1", "onPage #2"]);
        expect([iso, site, idle].map((r) => r.when)).toEqual(["document_end", "document_start", "document_idle"]);
    });

    it("returns a handle whose calls reject in the background", async () => {
        const c = compileScript(`import { tweak } from "tangitweak"; module.exports.h = tweak.onPage("*", () => ({ f: () => 1 }));`);
        expect(c.error).toBeNull();
        const h = c.exports.h;
        expect(h.then).toBeUndefined();
        await expect(h.f()).rejects.toThrow();
    });
});

describe("tweak.onOverlay", () => {
    const code = [`import { tweak } from "tangitweak"; tweak.onSite("*", () => {});`, `tweak.onOverlay("*", () => {});`, `tweak.onOverlay({ url: "*", when: "document_idle" }, () => {});`, `tweak.onPage("*", () => {});`].join("\n");

    it("registers overlay handlers, keyed and labelled apart from page handlers", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const [frame, idle] = c.handlers.onOverlay.map((h) => h.route);
        expect([frame.index, idle.index]).toEqual([0, 1]);
        expect([frame.key, idle.key]).toEqual(["onOverlay:0", "onOverlay:1"]);
        expect([frame.when, idle.when]).toEqual(["document_end", "document_idle"]);
        expect(isNetKind(frame.kind)).toBe(false);
        expect(isNetKind("onDocument")).toBe(false);
        expect(isNetKind("onRequest")).toBe(true);
        expect(c.meta.routes.map((r) => `${routeLabel(r)}@${r.line}`)).toEqual(["onSite #1@1", "onPage #1@4", "onOverlay #1@2", "onOverlay #2@3"]);
    });
});


describe("page shim worlds", () => {
    /** the `tweak` file main.ts's code gets from a page shim */
    const tw = (s: PageShim): any => s.host.module("main.ts").tweak;
    const src = (t: any) => {
        t.onSite("*://a.com/*", () => "site");
        t.onPage("*://a.com/*", () => "iso");
        t.onOverlay("*://a.com/*", () => "overlay");
        t.onSite("*://a.com/*", () => "site 2");
    };

    it("the site's world collects only onSite handlers, keyed like the background", () => {
        const s = shim();
        src(tw(s));
        expect(s.dom.map((d) => d.fn({}))).toEqual(["site", "site 2"]);
        expect(s.dom.map((d) => [d.h, d.route.index])).toEqual([
            ["onSite:0", 0],
            ["onSite:1", 2],
        ]);
    });

    it("the isolated world collects only onPage handlers", () => {
        const s = shim("isolated");
        src(tw(s));
        expect(s.dom.map((d) => [d.h, d.fn({})])).toEqual([["onPage:0", "iso"]]);
        expect(domHandlersFor(s.dom, "https://b.com/").length).toBe(0);
    });

    it("keys are each API's registration order, the same as the background's for the same source", () => {
        const code = [`import { tweak } from "tangitweak";`, `tweak.onSite("*", () => 0);`, `for (const u of ["*://a/*", "*://b/*"]) tweak.onPage(u, () => 1);`, `tweak.onSite("*", () => 2);`].join("\n");
        const c = compileScript(code, { name: "main.ts" });
        expect(c.error).toBeNull();
        for (const world of ["page", "isolated"] as const) {
            const s = shim(world);
            const m = { exports: {} };
            s.top(() => scriptFunction(toRunnableJs(code), "main.ts")(s.host, console, () => ({}), m, m.exports));
            const bg = c.handlers.onDocument.map((h) => h.route.key).filter((k): k is string => !!k && k.startsWith(world === "page" ? "onSite" : "onPage"));
            expect(s.dom.map((d) => d.h)).toEqual(bg);
        }
        expect(c.handlers.onDocument.map((h) => h.route.key)).toEqual(["onSite:0", "onPage:0", "onPage:1", "onSite:1"]);
    });

    it("in the site's world handles throw SiteCannotCallError where they're called, and are reported", () => {
        const seen: Error[] = [];
        const s = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, onSiteCall: (e) => seen.push(e) });
        const h = tw(s).onOverlay("*", () => {});
        expect(() => h.ping()).toThrow(SiteCannotCallError);
        expect(() => tw(s).onSite("*", () => {}).ping()).toThrow(/onSite code can't call handles/);
        expect(seen.map((e) => e.name)).toEqual(["SiteCannotCallError", "SiteCannotCallError"]);
    });

    it("isolated handles go through `call`, with where their handler runs; without it they're inert", async () => {
        const asked: string[] = [];
        const routes: any[] = [];
        const iso = makePageShim({
            params: {},
            log: () => {},
            storage: { get: () => undefined, set: () => undefined },
            world: "isolated",
            call: (api, key, route) => ((asked.push(`${api}/${key}`), routes.push(route), { ping: async () => "pong" }) as any),
        });
        await expect(tw(iso).onOverlay("*", () => {}).ping()).resolves.toBe("pong");
        tw(iso).onSite("*://a.test/*", () => {});
        expect(asked).toEqual(["onOverlay/onOverlay:0", "onSite/onSite:0"]);
        expect(routes.map((r) => r.url)).toEqual([["*"], ["*://a.test/*"]]);
        await expect(tw(shim("isolated")).onOverlay("*", () => {}).ping()).rejects.toThrow();
    });

    it("store can be declared at top level but not used; fetch rejects", async () => {
        const s = tw(shim()).globalStore("x", { n: 1 });
        expect(s.then).toBeUndefined();
        expect(() => s.n).toThrow(/tweak\.globalStore/);
        await expect(tw(shim()).fetch("/")).rejects.toThrow(/tweak\.fetch/);
    });

    it("isolated code gets the stores it's given (unnamed ones named file#n); the site's world never does", () => {
        const made: string[] = [];
        const stores = {
            store: (name: string, initial: object, persist: boolean | string[]) => (made.push(`g:${name}:${JSON.stringify(persist)}`), { ...initial }),
            tabStore: (name: string, initial: object) => (made.push(`t:${name}`), { ...initial }),
            pageStore: (name: string, initial: object) => (made.push(`p:${name}`), { ...initial }),
        };
        const iso = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated", stores });
        expect(tw(iso).globalStore("a", { n: 1 }, { persist: ["n"] }).n).toBe(1);
        expect(tw(iso).pageStore({ m: 2 }).m).toBe(2);
        expect(tw(iso).tabStore({ k: 3 }).k).toBe(3);
        expect(made).toEqual(['g:a:["n"]', "p:main.ts#0", "t:main.ts#1"]);
        expect(() => tw(iso).globalStore("a", {})).toThrow(/a store ID is used once per tweak/);
        expect(() => tw(iso).globalStore("A", {})).toThrow(/a store's ID is lowercase/);
        expect(() => tw(iso).globalStore("c", [])).toThrow(/initial must be an object/);
        const site = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "page", stores });
        expect(() => tw(site).pageStore({ m: 2 }).m).toThrow(SITE_NO_STORES);
        expect(() => tw(site).tabStore({ k: 3 }).k).toThrow(SITE_NO_STORES);
        expect(made.length).toBe(3);
    });
});

describe("inertRemote", () => {
    it("isn't a thenable or JSON-able, and any method rejects", async () => {
        const r: any = inertRemote("nope");
        expect(r.then).toBeUndefined();
        expect(r.toJSON).toBeUndefined();
        await expect(r.anything(1)).rejects.toThrow("nope");
    });
});
