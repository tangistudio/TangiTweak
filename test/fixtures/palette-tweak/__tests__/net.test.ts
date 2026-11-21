import { describe, expect } from "vitest";
import { createTweakTest, test } from "tangitweak/test";

const FLAGS = "https://app.example.com/api/flags";

describe("net: requests walk the strategies as the browser's layers", () => {
    test("the page sees the helper's replacement", async ({ net }) => {
        const res = await net.request(FLAGS);

        expect(res.json()).toEqual({ newNav: true, seen: true });
        expect(res.decidedBy).toMatchObject({ strategy: "helper", handler: "onRequest #1" });
    });

    test("page handlers don't see the document", async ({ net }) => {
        const res = await net.request(FLAGS, { resourceType: "document" });

        expect(res.json()).toEqual({ newNav: true });
        expect(res.skipped).toContainEqual(
            expect.objectContaining({
                handler: "onResponseBody #1",
                why: expect.stringContaining(`the "page" strategy only sees the page's own fetch/XHR`),
            })
        );
    });

    test("adds the env header; params change it", async ({ net, tweak }) => {
        const res = await net.request("https://app.example.com/api/data", { upstream: { body: "ok" } });
        expect(res.requestHeaders["x-env"]).toBe("staging");
        expect(res.decidedBy).toBeNull();

        await tweak.setParams({ env: "prod" });
        expect((await net.request("https://app.example.com/api/data")).requestHeaders["x-env"]).toBe("prod");
    });

    test("blocks telemetry with a browser rule", async ({ net }) => {
        expect(net.rules).toContainEqual(expect.objectContaining({ action: { type: "block" } }));
        const res = await net.request("https://telemetry.example.com/ping");
        expect(res.blocked).toBe(true);
        expect(res.decidedBy).toMatchObject({ strategy: "rules" });
    });
});

const prodTest = createTweakTest({ params: { env: "prod" } });

prodTest("createTweakTest: other params", async ({ net }) => {
    expect((await net.request("https://app.example.com/api/data")).requestHeaders["x-env"]).toBe("prod");
});

const netOnly = createTweakTest({ entry: "./only-net.ts" });

netOnly("createTweakTest: one feature's entry", async ({ page, net }) => {
    await page.goto("https://app.example.com/home");
    expect(page.ui.queryByRole("listbox")).toBeNull();
    expect(page.document.documentElement.dataset.greet).toBeUndefined();
    expect((await net.request(FLAGS)).json()).toEqual({ newNav: true, seen: true });
});

const firefoxTest = createTweakTest({ browser: "firefox" });

firefoxTest("another browser: the helper strategy is Chromium only", async ({ net }) => {
    const res = await net.request(FLAGS, { upstream: { body: { newNav: false } } });
    expect(res.json()).toEqual({ newNav: false, seen: true });
    expect(res.skipped).toContainEqual(expect.objectContaining({ handler: "onRequest #1" }));
});
