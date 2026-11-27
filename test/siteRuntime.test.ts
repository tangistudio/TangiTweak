// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import "../src/shared/transpile";
import { endpointPair, type Endpoint, type OverlayInit } from "../src/shared/wire";
import { StoreOwner, type StoreOwnerDeps } from "../src/background/engine/storeOwner";
import { startOverlay, type OverlayRuntime } from "../src/overlay/overlayRuntime";
import { makePageShim } from "../src/shared/pageShim";
import { compileScript } from "../src/shared/compile";
import { scriptFunction } from "../src/shared/scriptFn";
import { makeLibRequire } from "../src/shared/scriptImports";

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function memDeps(): StoreOwnerDeps {
    const storage = new Map<string, Record<string, any>>();
    return {
        storageAll: async (s) => structuredClone(storage.get(s) ?? {}),
        storageSet: async (s, k, v) => {
            const o = storage.get(s) ?? {};
            o[k] = structuredClone(v);
            storage.set(s, o);
        },
        sessionGet: async () => undefined,
        sessionSet: async () => {},
        persistDelayMs: 1,
        sessionDelayMs: 1,
    };
}

let running: OverlayRuntime[] = [];
afterEach(() => {
    for (const r of running) r.stop();
    running = [];
    document.body.innerHTML = "";
    document.head.innerHTML = "";
});

async function startSite(code: string, url = "https://www.costco.ca/deals?sort=price#top", extra: Partial<OverlayInit> = {}) {
    const [frame, bridge] = endpointPair();
    const owner = new StoreOwner(memDeps());
    owner.attach(bridge, { all: false });
    const events: {
        titles: string[];
        favicons: string[];
        navigates: { to: string; replace?: boolean }[];
        gos: number[];
        showOriginals: number;
        errors: string[];
        rects: number;
        storageCalls: any[];
    } = { titles: [], favicons: [], navigates: [], gos: [], showOriginals: 0, errors: [], rects: 0, storageCalls: [] };

    bridge.on("site.title", (a) => events.titles.push(a.title));
    bridge.on("site.favicon", (a) => events.favicons.push(a.href));
    bridge.on("site.navigate", (a) => events.navigates.push({ to: a.to, replace: a.replace }));
    bridge.on("site.go", (a) => events.gos.push(a.delta));
    bridge.on("site.showOriginal", () => void events.showOriginals++);
    bridge.on("site.error", (a) => events.errors.push(a.message));
    bridge.on("rects", () => void events.rects++);
    bridge.handle("origin.storage", async (req) => {
        events.storageCalls.push(req);
        if (req.op === "get") return { value: "stored-val" };
        if (req.op === "keys") return { keys: ["cart"] };
        return {};
    });
    bridge.handle("origin.cookie", async (req) => {
        if (req.op === "all") return { all: { session: "ok" } };
        if (req.op === "get") return { value: "ok" };
        return {};
    });
    bridge.handle("origin.idb", async () => ({ databases: [{ name: "shop", version: 1 }] }));
    bridge.handle("origin.blob", async () => ({ mime: "text/plain", base64: btoa("abc") }));

    const init: OverlayInit = {
        s: "s1",
        name: "CostcoSite",
        code,
        codeHash: "h1",
        routes: [],
        url,
        phase: "document_start",
        params: {},
        libs: [],
        stores: {},
        page: "p1",
        react: false,
        fullPage: true,
        ...extra,
    };
    const rt = await startOverlay(frame, init, { win: window as any, doc: document, watchRects: false, trustedKey: () => true });
    running.push(rt);
    await settle();
    return { rt, bridge, events };
}

describe("tweak.site runtime", () => {
    it("provides full-page SiteAppCtx with React Router navigator, location updates, title/favicon, showOriginal and origin bridge", async () => {
        const { bridge, events } = await startSite(`
            import { tweak } from "tangitweak";
            tweak.site("*://www.costco.ca/*", async (ctx) => {
                ctx.setTitle("Custom Costco");
                ctx.setFavicon("data:image/svg+xml,<svg/>");
                const out = ctx.once("loc", () => {
                    const d = document.createElement("div");
                    d.id = "loc";
                    document.body.appendChild(d);
                    return d;
                });
                const render = () => {
                    out.textContent = [ctx.location.hostname, ctx.location.pathname, ctx.location.search, ctx.location.hash].join("|");
                };
                render();
                ctx.onNavigate(render);

                const href = ctx.navigator.createHref({ pathname: "/cart", search: "?a=1", hash: "#items" });
                out.setAttribute("data-href", href);
                ctx.navigator.push("/orders");
                ctx.navigator.replace("/saved");
                ctx.navigator.go(-1);

                const val = await ctx.origin.localStorage.get("cart");
                const ck = await ctx.origin.cookies.get("session");
                const dbs = await ctx.origin.indexedDB.databases();
                const blob = await ctx.origin.readBlob("/a.txt");
                out.setAttribute("data-origin", JSON.stringify({ val, ck, db: dbs[0]?.name, text: await blob.text() }));

                ctx.showOriginal();
            });
        `);

        const el = document.getElementById("loc")!;
        expect(el.textContent).toBe("www.costco.ca|/deals|?sort=price|#top");
        expect(el.getAttribute("data-href")).toBe("/cart?a=1#items");
        expect(JSON.parse(el.getAttribute("data-origin")!)).toEqual({
            val: "stored-val",
            ck: "ok",
            db: "shop",
            text: "abc",
        });
        expect(events.titles).toEqual(["Custom Costco"]);
        expect(events.favicons).toEqual(["data:image/svg+xml,<svg/>"]);
        expect(events.navigates).toEqual([
            { to: "https://www.costco.ca/orders", replace: false },
            { to: "https://www.costco.ca/saved", replace: true },
        ]);
        expect(events.gos).toEqual([-1]);
        expect(events.showOriginals).toBe(1);
        // fullPage skips clip-path rect tracking
        expect(events.rects).toBe(0);

        // Bridge pushes a browser navigation -> ctx.location and ctx.onNavigate update
        bridge.push("nav", { url: "https://www.costco.ca/orders?page=2" });
        await settle();
        expect(el.textContent).toBe("www.costco.ca|/orders|?page=2|");
    });

    it("emits site.error when a tweak.site handler throws on startup", async () => {
        const { events } = await startSite(`
            import { tweak } from "tangitweak";
            tweak.site("*://www.costco.ca/*", () => {
                throw new Error("boom on boot");
            });
        `);
        expect(events.errors.length).toBeGreaterThan(0);
        expect(events.errors[0]).toContain("boom on boot");
    });

    it("routes onOverlay({ debuggerSafe: true }) into isolated shadowOverlays and skips it in normal iframe overlays", async () => {
        const src = `
            import { tweak } from "tangitweak";
            tweak.onOverlay({ url: "*://example.com/*", debuggerSafe: true }, () => {});
            tweak.onOverlay("*://example.com/*", () => {});
        `;
        const compiled = compileScript(src, { name: "safe-overlay.ts" });
        expect(compiled.error).toBeNull();
        expect(compiled.meta.routes).toHaveLength(2);
        expect(compiled.meta.routes[0].debuggerSafe).toBe(true);
        expect(compiled.meta.routes[1].debuggerSafe).toBeUndefined();

        const cjs = `
            const { tweak } = require("tangitweak");
            tweak.onOverlay({ url: "*://example.com/*", debuggerSafe: true }, () => {});
            tweak.onOverlay("*://example.com/*", () => {});
        `;
        const isoShim = makePageShim({
            world: "isolated",
            debuggerSafeOverlays: true,
            params: {},
            log: () => {},
            storage: { get: async () => undefined, set: async () => {} },
        });
        const req = makeLibRequire([], () => {})("safe-overlay.ts");
        const mod = { exports: {} };
        isoShim.top(() => scriptFunction(cjs, "safe-overlay.ts")(isoShim.host, console, req, mod, mod.exports));
        expect(isoShim.shadowOverlays).toHaveLength(1);
        expect(isoShim.shadowOverlays[0].route.debuggerSafe).toBe(true);

        // Normal iframe overlay runtime skips debuggerSafe: true routes so they never double-mount
        const ran: string[] = [];
        (globalThis as any).__ttTestRan = ran;
        const overlayCode = `
            const { tweak } = require("tangitweak");
            tweak.onOverlay({ url: "*://example.com/*", debuggerSafe: true }, () => { globalThis.__ttTestRan.push("safe"); });
            tweak.onOverlay("*://example.com/*", () => { globalThis.__ttTestRan.push("normal"); });
        `;
        await startSite(overlayCode, "https://example.com/", { fullPage: false, phase: "document_end" });
        expect(ran).toEqual(["normal"]);
        delete (globalThis as any).__ttTestRan;
    });

    it('"all" (the Debugger-friendly overlays setting) collects every onOverlay as debuggerSafe but leaves tweak.site alone', () => {
        const cjs = `
            const { tweak } = require("tangitweak");
            tweak.onOverlay("*://example.com/*", () => {});
            tweak.onOverlay({ url: "*://example.com/*", debuggerSafe: true }, () => {});
            tweak.site("*://example.com/*", () => {});
        `;
        const shim = (mode: boolean | "all") => {
            const s = makePageShim({ world: "isolated", debuggerSafeOverlays: mode, params: {}, log: () => {}, storage: { get: async () => undefined, set: async () => {} } });
            const mod = { exports: {} };
            s.top(() => scriptFunction(cjs, "all.ts")(s.host, console, makeLibRequire([], () => {})("all.ts"), mod, mod.exports));
            return s.shadowOverlays.map((o) => o.route.index);
        };
        expect(shim(true)).toEqual([1]);
        expect(shim("all")).toEqual([0, 1]);
    });
});
