import { describe, it, expect } from "vitest";
import { HeaderStack, handlerStack, mergeHeaderEdits, overlapHints, overruledLine, skippedBy, skippedLine, winnerOf, type RouteRef, type Winner } from "../src/shared/precedence";
import type { NetKind, RouteMeta, Strategy } from "../src/shared/route";

const URL = "https://api.test/v1/data";
function ref(scriptId: string, order: number, kind: NetKind, strategy: Strategy, index = 0, url = ["*://api.test/*"]): RouteRef {
    const route: RouteMeta = { kind, index, url, exclude: [], strategy };
    return { scriptId, scriptName: scriptId.toUpperCase(), order, route, strategy } as RouteRef;
}
const win = (scriptId: string, kind: NetKind, strategy: Strategy, outcome: Winner["outcome"], index = 0, target?: string): Winner => ({ scriptId, scriptName: scriptId.toUpperCase(), kind, index, strategy, outcome, target });
const names = (rs: RouteRef[]) => rs.map((r) => `${r.scriptId}:${r.route.kind}#${r.route.index}@${r.strategy}`).sort();

describe("skippedBy — same layer", () => {
    const routes = [
        ref("a", 0, "onRequest", "debugger"),
        ref("b", 1, "onRequest", "debugger"),
        ref("b", 1, "onRequest", "debugger", 1),
        ref("b", 1, "onResponseHeaders", "debugger"),
        ref("b", 1, "onResponseBody", "debugger"),
    ];
    it("an onRequest block skips every response handler, never another onRequest (they all run)", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("a", "onRequest", "debugger", "block")))).toEqual(["b:onResponseBody#0@debugger", "b:onResponseHeaders#0@debugger"]);
    });
    it("a mock skips nothing in its layer: it flows through the response handlers", () => {
        expect(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("a", "onRequest", "debugger", "replace"))).toEqual([]);
    });
    it("a mock served by redirect skips its layer's response handlers", () => {
        const w = win("a", "onRequest", "debugger", "replace");
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, w, { mockFlows: false }))).toEqual(["b:onResponseBody#0@debugger", "b:onResponseHeaders#0@debugger"]);
        expect(skippedLine(routes[4], w, URL, { mockFlows: false })).toContain(`strategy "debugger" serves a mock by redirect here, so response handlers can't run on it`);
    });
    it("handlers whose route doesn't match aren't skipped", () => {
        const rs = [ref("a", 0, "onRequest", "helper"), ref("b", 1, "onResponseBody", "helper", 0, ["*://other.test/*"])];
        expect(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "block"))).toEqual([]);
    });
});

describe("overruledLine", () => {
    it("names the overruled decision, the one with the last word and why", () => {
        const a = { scriptId: "a", scriptName: "A", kind: "onRequest" as const, index: 0, outcome: "block" as const };
        const b = { scriptId: "b", scriptName: "B", kind: "onRequest" as const, index: 1, outcome: "allow" as const };
        expect(overruledLine(a, b, URL)).toBe(`[A] onRequest #1 → block was overruled: [B] onRequest #2 → allow has the last word (same layer, it comes later in the list) ${URL}`);
        expect(overruledLine(a, b, URL, "B is an override")).toContain("(B is an override)");
    });
});

describe("skippedBy — across strategies", () => {
    const routes = [
        ref("p", 0, "onResponseBody", "page"),
        ref("r", 1, "onRequest", "rules"),
        ref("x", 2, "onResponseHeaders", "extension"),
        ref("d", 3, "onRequest", "debugger"),
        ref("h", 4, "onResponseBody", "helper"),
    ];
    it("a rules block skips everything behind it and the page's response handlers", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("r", "onRequest", "rules", "block")))).toEqual([
            "d:onRequest#0@debugger",
            "h:onResponseBody#0@helper",
            "p:onResponseBody#0@page",
            "x:onResponseHeaders#0@extension",
        ]);
    });
    it("a debugger replacement skips the helper only — layers in front see it as a response", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("d", "onRequest", "debugger", "replace")))).toEqual(["h:onResponseBody#0@helper"]);
    });
    it("page handlers only count for fetch/XHR", () => {
        expect(names(skippedBy(routes, { url: URL, type: "script" }, win("r", "onRequest", "rules", "block")))).not.toContain("p:onResponseBody#0@page");
    });
    it("a redirect doesn't count handlers that also match the target", () => {
        const rs = [ref("a", 0, "onRequest", "helper"), ref("b", 1, "onResponseBody", "helper")];
        expect(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "redirect", 0, "https://api.test/v2"))).toEqual([]);
        expect(names(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "redirect", 0, "https://elsewhere.test/")))).toEqual(["b:onResponseBody#0@helper"]);
    });
});

describe("skippedLine", () => {
    it("names both handlers, the reason and ends with the URL", () => {
        const r = ref("b", 1, "onResponseBody", "helper");
        const line = skippedLine(r, win("a", "onRequest", "rules", "block"), URL);
        expect(line).toBe(`[B] onResponseBody #1 → skipped: [A] onRequest #1 → block took priority (strategy "rules" comes before "helper", so the request never got there) ${URL}`);
    });
});

describe("winnerOf", () => {
    const who = { scriptId: "a", scriptName: "A", kind: "onRequest" as const, index: 0 };
    it("maps runOp results", () => {
        expect(winnerOf({ kind: "cancel", who }, "helper")?.outcome).toBe("block");
        expect(winnerOf({ kind: "redirect", url: "https://t/", who }, "helper")).toMatchObject({ outcome: "redirect", target: "https://t/" });
        expect(winnerOf({ kind: "respond", who }, "page")?.outcome).toBe("replace");
        expect(winnerOf({ kind: "headers", changes: {} }, "page")).toBeNull();
        expect(winnerOf(null, "page")).toBeNull();
    });
});

describe("header edits: the later one wins per header", () => {
    const A = { scriptId: "a", scriptName: "A", kind: "onRequest" as const, index: 0 };
    const B = { scriptId: "b", scriptName: "B", kind: "onRequest" as const, index: 0 };
    it("a later remove deletes an earlier set (case-insensitive)", () => {
        expect(mergeHeaderEdits({ set: { "X-Token": "1" } }, { remove: ["x-token"] })).toEqual({ set: {}, remove: ["x-token"] });
    });
    it("a later set drops an earlier remove", () => {
        expect(mergeHeaderEdits({ remove: ["x-token"] }, { set: { "X-Token": "2" } })).toEqual({ set: { "X-Token": "2" }, remove: [] });
    });
    it("reports the override, not a repeat of the same value", () => {
        const s = new HeaderStack();
        expect(s.add({ set: { a: "1", b: "1" } }, A)).toEqual([]);
        expect(s.add({ set: { a: "2", b: "1" } }, B)).toEqual([{ header: "a", by: B, over: A }]);
        expect(s.result()).toEqual({ set: { a: "2", b: "1" }, remove: [] });
    });
});

describe("handlerStack", () => {
    it("lists matching handlers in run order: strategy, stage, layer, list, registration", () => {
        const site = { ...ref("shop", 0, "onRequest", "debugger"), layer: "site" as const, layerSource: "inferred" as const };
        const base = { ...ref("api", 1, "onRequest", "debugger"), layer: "base" as const, layerSource: "package" as const };
        const body = ref("api", 1, "onResponseBody", "debugger");
        const page = ref("pg", 2, "onRequest", "page");
        const other = ref("x", 3, "onRequest", "debugger", 0, ["*://other.test/*"]);
        const rows = handlerStack([site, base, body, page, other], { url: URL, type: "xmlhttprequest" });
        expect(rows.map((r) => `${r.scriptId}:${r.label}@${r.strategy}/${r.layer}`)).toEqual(["pg:onRequest #1@page/site", "api:onRequest #1@debugger/base", "shop:onRequest #1@debugger/site", "api:onResponseBody #1@debugger/site"]);
        expect(rows[1].layerSource).toBe("package");
        expect(handlerStack([page], { url: URL, type: "script" })).toEqual([]);
    });
});

describe("overlapHints", () => {
    it("hints the later of two tweaks' handlers that may match one request, in the same stage and strategy", () => {
        const base = { ...ref("api", 0, "onRequest", "debugger", 0, ["*://*/*"]), layer: "base" as const };
        const site = { ...ref("shop", 1, "onRequest", "debugger", 0, ["*://api.test/v1/*"]), layer: "site" as const };
        const hints = overlapHints([site, base]);
        expect([...hints.keys()]).toEqual(["shop"]);
        expect(hints.get("shop")).toEqual([`hint: onRequest #1 "*://api.test/v1/*" overlaps "API" onRequest #1 (layer "base"); "SHOP" runs after it (layer "site")`]);
    });
    it("stays quiet for other stages, other strategies, disjoint URLs or disjoint methods", () => {
        const a = ref("a", 0, "onRequest", "debugger");
        expect(overlapHints([a, ref("b", 1, "onResponseBody", "debugger")]).size).toBe(0);
        expect(overlapHints([a, ref("b", 1, "onRequest", "helper")]).size).toBe(0);
        expect(overlapHints([a, ref("b", 1, "onRequest", "debugger", 0, ["*://other.test/*"])]).size).toBe(0);
        const get = { ...a, route: { ...a.route, methods: ["GET"] } };
        const post = ref("b", 1, "onRequest", "debugger");
        expect(overlapHints([get, { ...post, route: { ...post.route, methods: ["POST"] } }]).size).toBe(0);
    });
    it("same layer: the one later in the list runs after", () => {
        expect(overlapHints([ref("a", 0, "onRequest", "debugger"), ref("b", 1, "onRequest", "debugger")]).get("b")?.[0]).toContain(`runs after it (same layer "site", later in the list)`);
    });
});
