import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ExtensionStrategy } from "../src/background/engine/strategies/extensionStrategy";
import { DebuggerStrategy } from "../src/background/engine/strategies/debuggerStrategy";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

// these suites exercise the extension strategy: make it the settings default

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: async () => ({}) },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        webRequest: {
            onBeforeRequest: { addListener: vi.fn() },
            onBeforeSendHeaders: { addListener: vi.fn() },
            onHeadersReceived: { addListener: vi.fn() },
            onCompleted: { addListener: vi.fn() },
            onErrorOccurred: { addListener: vi.fn() },
        },
        tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    };
    // not Firefox in unit tests
    delete (globalThis as any).browser;
    // clear the module-static per-request caches between tests
    new ExtensionStrategy().pruneRequest("r1");
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

const details = () => ({
    url: "https://api.example.com/v1/data",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
});

// ---------- stacking: multiple scripts, same hook ----------

describe("handler stacking", () => {
    it("onRequest: every script runs and the last redirect wins", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("first", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ redirect: "https://first.com" }));`),
            makeScript("second", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ redirect: "https://second.com" }));`),
        ]);
        const d = await s.handleBeforeRequest(details(), null) as any;
        expect(d).toEqual({ kind: "redirect", url: "https://second.com" });
    });

    it("onRequest: non-terminal results don't stop later scripts", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("logger", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => { tweak.log("just logging"); });`),
            makeScript("redirector", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ redirect: "https://second.com" }));`),
        ]);
        const d = await s.handleBeforeRequest(details(), null) as any;
        expect(d).toEqual({ kind: "redirect", url: "https://second.com" });
    });

    it("onRequest: header changes from MULTIPLE scripts merge (later set wins, removes accumulate)", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ headers: { set: { "x-a": "1", "x-b": "old" }, remove: ["x-r1"] } }));`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ headers: { set: { "x-b": "new", "x-c": "3" }, remove: ["x-r2"] } }));`),
        ]);
        await s.handleBeforeRequest(details(), null); // runs both, caches merged mods
        const c = await s.handleBeforeSendHeaders(details(), null) as any;
        expect(c.set).toEqual({ "x-a": "1", "x-b": "new", "x-c": "3" });
        expect(c.remove).toEqual(["x-r1", "x-r2"]);
    });

    it("onRequest: headers from an earlier non-terminal script APPLY even when a later script redirects", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ headers: { set: { "x-keep": "yes" } } }));`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ redirect: "https://win.com" }));`),
        ]);
        const d = await s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        const c = await s.handleBeforeSendHeaders(details(), null) as any;
        expect(c.set).toEqual({ "x-keep": "yes" });
    });

    it("onResponseHeaders: multiple scripts MERGE — set overwritten by later, removes accumulate", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseHeaders({ url: "*", strategy: "extension" }, () => ({ headers: { set: { "x-a": "1", "x-b": "old" }, remove: ["x-r1"] } }));`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onResponseHeaders({ url: "*", strategy: "extension" }, () => ({ headers: { set: { "x-b": "new", "x-c": "3" }, remove: ["x-r2"] } }));`),
        ]);
        const c = await s.handleHeadersReceived(details(), null) as any;
        expect(c.set).toEqual({ "x-a": "1", "x-b": "new", "x-c": "3" });
        expect(c.remove).toEqual(["x-r1", "x-r2"]);
    });

    it("onResponseBody: transforms COMPOSE in script order (chained)", async () => {
        const { compileScript } = await import("../src/shared/compile");
        const chain = [
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "extension" }, (ctx, body) => body + "-A");`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "extension" }, (ctx, body) => body + "-B");`),
        ];
        let out: string | Uint8Array = "base";
        for (const sc of chain) {
            const c = compileScript(sc.code);
            for (const { fn } of c.handlers.onResponseBody) {
                out = await fn({ url: "x" }, out);
            }
        }
        expect(out).toBe("base-A-B");
    });

    it("async onResponseBody: promises compose in script order", async () => {
        const { compileScript } = await import("../src/shared/compile");
        const chain = [
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "extension" }, async (ctx, body) => body + "-A");`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "extension" }, async (ctx, body) => body + "-B");`),
        ];
        let out: string | Uint8Array = "base";
        for (const sc of chain) {
            const c = compileScript(sc.code);
            for (const { fn } of c.handlers.onResponseBody) {
                out = await fn({ url: "x" }, out);
            }
        }
        expect(out).toBe("base-A-B");
    });
});

// ---------- async handlers ----------

describe("async handlers (CDP tier loading)", () => {
    it("routes on other strategies are not loaded", () => {
        const c = new DebuggerStrategy();
        c.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, async () => ({ replaceResponse: { body: "x" } }));`)]);
        expect(c.hasOwners()).toBe(false);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(false);
    });

    it("async onRequest replaceResponse script is loaded into DebuggerStrategy", () => {
        const c = new DebuggerStrategy();
        c.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "debugger" }, async () => ({ replaceResponse: { body: "x" } }));`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });

    it("SYNC onRequest replaceResponse script IS loaded", () => {
        const c = new DebuggerStrategy();
        c.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "debugger" }, () => ({ replaceResponse: { body: "x" } }));`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });

    it("async onRequest script is loaded (request-stage redirect/cancel)", () => {
        const c = new DebuggerStrategy();
        c.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "debugger" }, async () => ({ block: true }));`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });
});
