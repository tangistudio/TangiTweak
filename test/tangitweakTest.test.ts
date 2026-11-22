/**
 * "tangitweak/test" pieces that aren't about one bundle: the browser gaps it
 * closes (§6.7 of the plan), bundle discovery and the plain-test `tweak`.
 * The fixture styles themselves are tested in test/fixtures/palette-tweak.
 */
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { tweak } from "tangitweak";
import { loadTweak, test as tweakTest } from "tangitweak/test";
import { checkRules, MAX_REGEX_RULES, MAX_SESSION_RULES, type RuleGroup } from "../src/testing/ruleChecks";
import { bundleDirOf, storeRegistry } from "../src/testing/standalone";

const src = (code: string) => `import { tweak } from "tangitweak";\n${code}`;

describe("Node globals are gone, as in the browser", () => {
    it("the tweak sees no Buffer, process, global or setImmediate", async () => {
        const t = await loadTweak({
            name: "n",
            code: src(`export const kinds = [typeof Buffer, typeof process, typeof global, typeof setImmediate, typeof fetch];`),
        });
        expect(t.exports.kinds).toEqual(["undefined", "undefined", "undefined", "undefined", "function"]);
        await t.dispose();
    });

    it("a Node built-in fails unless the tweak depends on a polyfill", async () => {
        const t = await loadTweak({ name: "n", code: src(`import { EventEmitter } from "events";\nexport const E = EventEmitter;`) }, { allowCompileErrors: true });
        expect(t.errors.join("\n")).toMatch(/events/);
        await t.dispose();
    });
});

describe("rules: what Chrome checks when adding them", () => {
    it("RE2 rejects a lookahead", async () => {
        const t = await loadTweak(
            { name: "r", code: src(`tweak.onRequest({ url: "https://a.test/:id((?!x)\\\\w+)", strategy: "rules" }, () => ({ block: true }));`) },
            { allowCompileErrors: true }
        );
        expect(t.errors.join("\n")).toMatch(/regex engine \(RE2\) rejects .*no lookahead/);
        expect(t.rules).toEqual([]);
        await t.dispose();
    });

    const group = (n: number, regex: boolean): RuleGroup => ({
        scriptName: "s",
        route: { kind: "onRequest", url: "*://a.test/*", strategy: "rules" } as any,
        specs: Array.from({ length: n }, (_, i) => ({
            pattern: `*://a${i}.test/*`,
            action: { type: "block" },
            condition: regex ? { regexFilter: `^https://a${i}\\.test/` } : { urlFilter: `||a${i}.test/` },
        })) as any,
    });

    it("the rule counts are Chrome's", () => {
        expect(checkRules([group(MAX_SESSION_RULES, false)]).errors).toEqual([]);
        expect(checkRules([group(MAX_SESSION_RULES + 1, false)]).errors.join()).toMatch(`Chrome allows ${MAX_SESSION_RULES}`);
        expect(checkRules([group(MAX_REGEX_RULES + 1, true)]).errors.join()).toMatch(`Chrome allows ${MAX_REGEX_RULES} for all tweaks together`);
    });
});

describe("worlds: one DOM, separate JavaScript globals", () => {
    it("onSite and onPage don't share window globals; the website's are onSite's", async () => {
        const t = await loadTweak({
            name: "w",
            code: src(`
tweak.onSite("*://a.test/*", () => { (window as any).fromSite = 1; document.body.dataset.siteSees = String((window as any).appConfig); });
tweak.onPage("*://a.test/*", () => { document.body.dataset.pageSees = [typeof (window as any).fromSite, typeof (window as any).appConfig].join(); });`),
        });
        const page = await t.openPage("https://a.test/", { setup: (w) => ((w as any).appConfig = "cfg") });
        await page.flush();
        expect(page.document.body.dataset.siteSees).toBe("cfg");
        expect(page.document.body.dataset.pageSees).toBe("undefined,undefined");
        expect((page.window as any).fromSite).toBe(1);
        await t.dispose();
    });
});

describe("single-page apps: a route's navigation", () => {
    it('"match" starts and stops onPage and onSite with the URL; "every" runs again per URL; ctx.onNavigate follows', async () => {
        const t = await loadTweak({
            name: "spa",
            code: src(`
const bump = (k: string) => (document.body.dataset[k] = String(Number(document.body.dataset[k] || 0) + 1));
tweak.onPage({ url: "*://a.test/cart*", navigation: "match" }, (ctx) => {
    bump("page");
    ctx.style("body { color: red }");
    ctx.onNavigate((u) => (document.body.dataset.seen = u));
    ctx.signal.addEventListener("abort", () => bump("pageEnd"));
});
tweak.onSite({ url: "*://a.test/cart*", navigation: "every" }, (ctx) => { bump("site"); document.body.dataset.siteUrl = ctx.url; });
tweak.onPage({ url: "*://a.test/cart*", navigation: "match", when: "document_idle" }, () => { bump("idle"); });
tweak.onPage("*://a.test/cart*", () => { bump("load"); });`),
        });
        const page = await t.openPage("https://a.test/home");
        const d = () => ({ ...page.document.body.dataset });
        await page.flush();
        expect(d()).toEqual({});
        await page.navigate("/cart");
        expect(d()).toMatchObject({ page: "1", site: "1", siteUrl: "https://a.test/cart" });
        expect(d().idle).toBeUndefined(); // waits for its when
        expect(page.window.getComputedStyle(page.document.body).color).toBe("red");
        await page.navigate("/cart/2");
        expect(d()).toMatchObject({ page: "1", site: "2", siteUrl: "https://a.test/cart/2", seen: "https://a.test/cart/2" });
        await page.advanceTo("document_idle");
        expect(d().idle).toBe("1");
        await page.navigate("/home");
        expect(d()).toMatchObject({ page: "1", pageEnd: "1", site: "2" });
        expect(page.window.getComputedStyle(page.document.body).color).not.toBe("red");
        await page.navigate("/cart");
        expect(d()).toMatchObject({ page: "2", site: "3", idle: "2" }); // idle has passed: right away
        expect(d().load).toBeUndefined(); // "load" routes match only the URL the page loaded with
        await t.dispose();
    });
});

describe("browsers", () => {
    const onSite = { name: "c", code: src(`tweak.onSite("*://a.test/*", () => { document.body.dataset.ran = "1"; });`) };
    const CSP_LINE = "page CSP blocks eval in the page world";

    it("a CSP without 'unsafe-eval' moves onSite to the isolated world on Firefox", async () => {
        const t = await loadTweak(onSite, { browser: "firefox" });
        const page = await t.openPage("https://a.test/", { csp: "script-src 'self'" });
        await page.flush();
        expect(page.document.body.dataset.ran).toBe("1");
        expect(t.warnings.join("\n")).toContain(CSP_LINE);
        await t.dispose();
    });

    it("Chrome injects onSite without eval: the CSP doesn't matter", async () => {
        const t = await loadTweak(onSite);
        await t.openPage("https://a.test/", { csp: "script-src 'self'" });
        expect(t.warnings.join("\n")).not.toContain(CSP_LINE);
        await t.dispose();
    });

    it("the debugger may miss a new tab's first document", async () => {
        const t = await loadTweak({ name: "d", code: src(`tweak.onRequest({ url: "*://a.test/*", strategy: "debugger" }, () => ({ headers: { set: { "x-d": "1" } } }));`) });
        const first = await t.simulate("https://a.test/", { resourceType: "main_frame", tabId: 7 });
        expect(first.skipped).toContainEqual(expect.objectContaining({ why: expect.stringContaining("may miss it") }));
        const second = await t.simulate("https://a.test/next", { resourceType: "main_frame", tabId: 7 });
        expect(second.skipped).toEqual([]);
        await t.dispose();
    });

    it("Chrome MV2's blocking webRequest can't await", async () => {
        const t = await loadTweak(
            { name: "m", code: src(`tweak.onRequest({ url: "*://a.test/*", strategy: "extension" }, async () => ({ block: true }));`) },
            { browser: "chromium-mv2" }
        );
        const res = await t.simulate("https://a.test/x");
        expect(res.blocked).toBe(false);
        expect(t.logs.map((l) => l.message).join("\n")).toContain("Chrome's blocking webRequest cannot await");
        await t.dispose();
    });
});

describe("bundle discovery", () => {
    it("finds the nearest package.json with a tangitweak block", () => {
        const bundle = nodePath.resolve(__dirname, "fixtures/palette-tweak");
        expect(bundleDirOf(nodePath.join(bundle, "__tests__"))).toBe(bundle);
        expect(bundleDirOf(nodePath.join(bundle, "features/palette"))).toBe(bundle);
        expect(bundleDirOf(__dirname)).toBeNull();
    });

    tweakTest.fails("a fixture outside a bundle has no tweak to load", async ({ page }) => {
        await page.goto("https://a.test/");
    });
});

describe("plain tests: the tweak from Node", () => {
    it("records handlers without running them; onSite's functions reject", async () => {
        const before = storeRegistry().handlers.length;
        const site = tweak.onSite("*://a.test/*", () => ({ hello: () => 1 }));
        expect(storeRegistry().handlers.slice(before)).toEqual([expect.objectContaining({ api: "onSite", route: "*://a.test/*" })]);
        await expect(site.hello()).rejects.toThrow(/handlers don't run in plain tests/);
    });

    it("a global store ID is used once", () => {
        tweak.globalStore("plain-once", { a: 1 });
        expect(() => tweak.globalStore("plain-once", { a: 2 })).toThrow(/used once per tweak/);
    });

    it("params are their defaults", () => {
        expect(tweak.params({ n: { type: "number", default: 3 } }).n).toBe(3);
    });
});
