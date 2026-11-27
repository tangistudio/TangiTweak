import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExtensionStrategy } from "../src/background/engine/strategies/extensionStrategy";
import { PageStrategy } from "../src/background/engine/strategies/pageStrategy";
import type { Script } from "../src/background/engine/scriptStore";
import { compileScript } from "../src/shared/compile";
import { allLogs } from "../src/background/engine/logs";
import { setSkipRoutes } from "../src/background/engine/skipped";

// ---- chrome mock ----
const storageData: Record<string, any> = {};
const listeners: { [k: string]: Function[] } = {};

function mockChrome() {
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[] | string) => {
                    const out: Record<string, any> = {};
                    for (const k of Array.isArray(keys) ? keys : [keys]) {
                        if (k in storageData) out[k] = JSON.parse(JSON.stringify(storageData[k]));
                    }
                    return out;
                },
                set: async (obj: Record<string, any>) => {
                    for (const [k, v] of Object.entries(obj)) storageData[k] = v;
                },
            },
        },
        runtime: {
            getURL: (p: string) => `chrome-extension://testid/${p}`,
            sendMessage: vi.fn(async () => ({})),
            onMessage: { addListener: vi.fn() },
            onConnect: { addListener: vi.fn() },
        },
        tabs: {
            onUpdated: { addListener: vi.fn() },
            onRemoved: { addListener: vi.fn() },
        },
        webRequest: {
            onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
            onBeforeSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
            onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        debugger: undefined,
    };
}

beforeEach(() => {
    mockChrome();
});

function named(id: string, code: string): Script {
    const s = makeScript(id, code);
    s.meta = { ...s.meta, name: id };
    return s;
}

function makeScript(id: string, code: string, enabled = true): Script {
    return {
        id,
        code,
        enabled,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
        meta: compileScript(code).meta,
    };
}

const details = (over: Partial<any> = {}) => ({
    url: "https://api.example.com/v1/data",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [{ name: "accept", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    statusLine: "HTTP/1.1 200 OK",
    statusCode: 200,
    ...over,
});

describe("ExtensionStrategy", () => {
    it("onRequest redirect", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, (ctx) => ({ redirect: "https://mocked.example.com/data" }));`),
        ]);
        const d = await s.handleBeforeRequest(details(), "https://app.example.com/") as any;
        expect(d).toEqual({ kind: "redirect", url: "https://mocked.example.com/data" });
    });

    it("non-matching url → allow", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://other.com/*", strategy: "extension" }, () => ({ redirect: "https://x.com" }));`),
        ]);
        expect((await s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("disabled script does nothing", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => ({ block: true }));`, false),
        ]);
        expect((await s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("static onRequest replaceResponse is served in place: the request goes on", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/v1/data", strategy: "extension" }, () => ({ replaceResponse: { body: { mocked: true } } }));`),
        ]);
        expect((await s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
        s.pruneRequest("r1");
    });

    it("onResponseHeaders modifies headers", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ headers: { set: { "access-control-allow-origin": "*" }, remove: ["x-frame-options"] } }));`),
        ]);
        const changes = await s.handleHeadersReceived(details(), null) as any;
        expect(changes).not.toBeNull();
        expect(changes!.set).toEqual({ "access-control-allow-origin": "*" });
        expect(changes!.remove).toEqual(["x-frame-options"]);
    });

    it("request header modification via onRequest (run once, cached for header phase)", async () => {
        const s = new ExtensionStrategy();
        const code = `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ headers: { set: { authorization: "Bearer x" } } }));`;
        s.reload([makeScript("a", code)]);
        // header phase alone does nothing (cache empty — onRequest hasn't run)
        expect(await s.handleBeforeSendHeaders(details(), null)).toBeNull();
        // request phase runs onRequest and caches the header mods
        await s.handleBeforeRequest(details(), null);
        const changes = await s.handleBeforeSendHeaders(details(), null) as any;
        expect(changes!.set).toEqual({ authorization: "Bearer x" });
    });

    it("every onRequest runs: a later block overrules an earlier mock", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ replaceResponse: { body: "mocked" } }));`),
            makeScript("b", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ block: true }));`),
        ]);
        expect((await s.handleBeforeRequest(details(), null) as any).kind).toBe("cancel");
    });

    it("the later handler wins per header, and the override is a warning", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            named("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ headers: { set: { "X-Mode": "a" }, remove: ["cookie"] } }));`),
            named("b", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ headers: { remove: ["x-mode"], set: { Cookie: "b=1" } } }));`),
        ]);
        await s.handleBeforeRequest(details({ requestId: "hdr" }), null);
        const changes = await s.handleBeforeSendHeaders(details({ requestId: "hdr" }), null) as any;
        expect(changes).toEqual({ set: { Cookie: "b=1" }, remove: ["x-mode"] });
        const warns = allLogs().filter((e) => e.level === "warn" && e.message.includes("overrides request header"));
        expect(warns.map((e) => e.message.split(" from ")[0])).toEqual(expect.arrayContaining([`[b] onRequest #1 overrides request header "x-mode"`, `[b] onRequest #1 overrides request header "cookie"`]));
    });

    it("a final result warns for each handler it kept from running (every onRequest still runs)", async () => {
        const scripts = [
            named("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ block: true }));`),
            named("b", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "extension" }, () => ({ headers: { set: { x: "1" } } })); tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "extension" }, () => null);`),
        ];
        setSkipRoutes(scripts);
        const s = new ExtensionStrategy();
        s.reload(scripts);
        expect((await s.handleBeforeRequest(details({ url: "https://api.example.com/skip" }), null) as any).kind).toBe("cancel");
        const lines = allLogs().filter((e) => e.message.includes("→ skipped: ") && e.message.endsWith("https://api.example.com/skip")).map((e) => e.message);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[b\] onResponseHeaders #1 → skipped: \[a\] onRequest #1 → block took priority \(the request ended there\)/);
        setSkipRoutes([]);
    });

    it("script throwing does not break the pipeline", async () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*", strategy: "extension" }, () => { throw new Error("boom"); });`),
        ]);
        expect((await s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });
});

describe("PageStrategy (hook tier)", () => {
    it("owns only hook routes and never asks for the debugger itself", async () => {
        const s = new PageStrategy();
        s.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(true);
        expect((await s.handleBeforeRequest(details({ type: "script" }), null) as any).kind).toBe("allow");
        s.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "debugger" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(false);
    });

    it("claimed urls (tier A) are tracked", () => {
        const s = new PageStrategy();
        s.reload([makeScript("a", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        s.claimRequest("https://cdn.example.com/lib.js");
        expect(s.isClaimed("https://cdn.example.com/lib.js")).toBe(true);
        expect(s.isClaimed("https://cdn.example.com/other.js")).toBe(false);
    });
});
