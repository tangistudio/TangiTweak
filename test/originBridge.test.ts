// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleOriginBlob, handleOriginCookie, handleOriginStorage } from "../src/shared/originBridge";

describe("originBridge", () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        // clear existing cookies in happy-dom
        for (const pair of document.cookie.split(";")) {
            const name = pair.split("=")[0]?.trim();
            if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
        }
    });

    it("reads, writes, lists, removes and clears localStorage and sessionStorage", () => {
        handleOriginStorage({ area: "local", op: "set", key: "cart", value: "3" });
        handleOriginStorage({ area: "session", op: "set", key: "tab", value: "home" });

        expect(handleOriginStorage({ area: "local", op: "get", key: "cart" })).toEqual({ value: "3" });
        expect(handleOriginStorage({ area: "local", op: "keys" })).toEqual({ keys: ["cart"] });
        expect(handleOriginStorage({ area: "session", op: "get", key: "tab" })).toEqual({ value: "home" });

        handleOriginStorage({ area: "local", op: "remove", key: "cart" });
        expect(handleOriginStorage({ area: "local", op: "get", key: "cart" })).toEqual({ value: null });

        handleOriginStorage({ area: "session", op: "clear" });
        expect(handleOriginStorage({ area: "session", op: "keys" })).toEqual({ keys: [] });
    });

    it("reads, writes, enumerates and removes non-HttpOnly cookies", () => {
        handleOriginCookie({ op: "set", key: "postal", value: "M5V 2T6" });
        handleOriginCookie({ op: "set", key: "lang", value: "en" });

        expect(handleOriginCookie({ op: "get", key: "postal" })).toEqual({ value: "M5V 2T6" });
        expect(handleOriginCookie({ op: "all" })).toEqual({ all: { postal: "M5V 2T6", lang: "en" } });

        handleOriginCookie({ op: "remove", key: "postal" });
        expect(handleOriginCookie({ op: "get", key: "postal" })).toEqual({ value: null });
    });

    it("fetches origin blobs and returns mime + base64", async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => new Response("hello world", { headers: { "content-type": "text/plain" } })) as any;
        try {
            const res = await handleOriginBlob({ url: "/asset.txt" });
            expect(res.mime).toContain("text/plain");
            expect(atob(res.base64)).toBe("hello world");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
