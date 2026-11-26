import { describe, it, expect, beforeEach } from "vitest";
import {
    buildSiteDnrRules,
    debuggerSafeSiteCsp,
    matchSiteForUrl,
    SITE_RULE_BASE,
    SiteRulesManager,
    STRICT_SITE_CSP,
} from "../src/background/engine/siteRules";
import type { Script } from "../src/background/engine/scriptStore";
import { normalizeRoute } from "../src/shared/route";

function siteScript(
    id: string,
    name: string,
    route: Record<string, any>,
    enabled = true
): Script {
    return {
        id,
        enabled,
        code: "",
        createdAt: 1,
        updatedAt: 1,
        error: null,
        meta: {
            name,
            match: [],
            active: true,
            routes: [normalizeRoute("onOverlay", route, 0, "site")],
        },
    };
}

describe("buildSiteDnrRules", () => {
    it("emits priority-1 CSP rule and priority-2 exclude allow rules starting at SITE_RULE_BASE", () => {
        const s = siteScript("s1", "Costco", {
            url: "*://www.costco.ca/*",
            exclude: ["*://www.costco.ca/checkout*", "*://www.costco.ca/Logon*"],
        });
        const rules = buildSiteDnrRules([s], new Map(), "nonce123");
        expect(rules.map((r) => r.id)).toEqual([SITE_RULE_BASE, SITE_RULE_BASE + 1, SITE_RULE_BASE + 2]);
        expect(rules[0].priority).toBe(1);
        expect(rules[0].action.type).toBe("modifyHeaders");
        expect(rules[0].action.responseHeaders?.[0]).toMatchObject({
            header: "Content-Security-Policy",
            operation: "set",
            value: STRICT_SITE_CSP,
        });
        expect(rules[0].condition.resourceTypes).toEqual(["main_frame"]);
        expect(rules[1].priority).toBe(2);
        expect(rules[1].action.type).toBe("allow");
        expect(rules[2].priority).toBe(2);
        expect(rules[2].action.type).toBe("allow");
    });

    it("uses debuggerSafe CSP with nonce when debuggerSafe: true", () => {
        const s = siteScript("s1", "Safe", { url: "*://example.com/*", debuggerSafe: true });
        const rules = buildSiteDnrRules([s], new Map(), "abc999");
        expect(rules).toHaveLength(1);
        expect(rules[0].action.responseHeaders?.[0]?.value).toBe(debuggerSafeSiteCsp("abc999"));
        expect(rules[0].action.responseHeaders?.[0]?.value).toContain("'nonce-abc999'");
    });

    it("excludes tabs overridden to original mode, and scopes defaultMode: original to custom tabs only", () => {
        const customByDefault = siteScript("s1", "DefaultCustom", { url: "*://a.test/*" });
        const origByDefault = siteScript("s2", "DefaultOrig", { url: "*://b.test/*", defaultMode: "original" });

        const noTabs = buildSiteDnrRules([customByDefault, origByDefault], new Map(), "n");
        expect(noTabs).toHaveLength(1);
        expect(noTabs[0].condition.excludedTabIds).toBeUndefined();

        const overrides = new Map<number, "custom" | "original">([
            [11, "original"],
            [22, "custom"],
        ]);
        const withTabs = buildSiteDnrRules([customByDefault, origByDefault], overrides, "n");
        expect(withTabs).toHaveLength(2);
        expect(withTabs[0].condition.excludedTabIds).toEqual([11]);
        expect(withTabs[1].condition.tabIds).toEqual([22]);
    });

    it("ignores disabled scripts", () => {
        const s = siteScript("s1", "Off", { url: "*://example.com/*" }, false);
        expect(buildSiteDnrRules([s], new Map(), "n")).toEqual([]);
    });
});

describe("matchSiteForUrl", () => {
    it("matches enabled tweak.site routes and respects exclude", () => {
        const s = siteScript("s1", "Costco", {
            url: "*://www.costco.ca/*",
            exclude: ["*://www.costco.ca/checkout*"],
            defaultMode: "custom",
            debuggerSafe: true,
        });
        expect(matchSiteForUrl([s], "https://www.costco.ca/deals")).toMatchObject({
            scriptId: "s1",
            scriptName: "Costco",
            defaultMode: "custom",
            debuggerSafe: true,
        });
        expect(matchSiteForUrl([s], "https://www.costco.ca/checkout/step1")).toBeNull();
        expect(matchSiteForUrl([s], "https://other.example.com/")).toBeNull();
    });
});

describe("SiteRulesManager", () => {
    let installed: chrome.declarativeNetRequest.Rule[] = [];
    let sessionBag: Record<string, any> = {};

    beforeEach(() => {
        installed = [];
        sessionBag = {};
        (globalThis as any).chrome = {
            runtime: {},
            declarativeNetRequest: {
                getSessionRules: (cb?: (rules: any[]) => void) => {
                    const out = [...installed];
                    if (cb) return void cb(out);
                    return Promise.resolve(out);
                },
                updateSessionRules: ({ removeRuleIds = [], addRules = [] }: any, cb?: () => void) => {
                    const drop = new Set(removeRuleIds);
                    installed = installed.filter((r) => !drop.has(r.id)).concat(addRules);
                    if (cb) return void cb();
                    return Promise.resolve();
                },
            },
            storage: {
                session: {
                    get: async (k: string | string[]) => {
                        if (Array.isArray(k)) return Object.fromEntries(k.map((key) => [key, sessionBag[key]]));
                        return { [k]: sessionBag[k] };
                    },
                    set: async (o: Record<string, any>) => Object.assign(sessionBag, o),
                },
            },
        };
    });

    it("tracks per-tab Original/Custom mode, updates session rules without touching non-site rules, and cleans up closed tabs", async () => {
        // Seed a rules-strategy rule (id < SITE_RULE_BASE) and a bypass rule (id >= 900_000)
        installed.push({ id: 42, priority: 4, action: { type: "block" } as any, condition: { urlFilter: "ads" } });
        installed.push({ id: 900_001, priority: 1000, action: { type: "allow" } as any, condition: { urlFilter: "bypass" } });

        const mgr = new SiteRulesManager();
        const s = siteScript("s1", "Example", { url: "*://example.com/*" });
        await mgr.reload([s]);

        expect(installed.some((r) => r.id === 42)).toBe(true);
        expect(installed.some((r) => r.id === 900_001)).toBe(true);
        expect(installed.some((r) => r.id === SITE_RULE_BASE)).toBe(true);

        expect(await mgr.tabState(7, "https://example.com/")).toMatchObject({ matched: true, mode: "custom", defaultMode: "custom" });
        expect(mgr.activeForTab("https://example.com/", 7)).toMatchObject({ scriptId: "s1" });

        await mgr.setTabMode(7, "original");
        expect(await mgr.tabState(7, "https://example.com/")).toMatchObject({ matched: true, mode: "original" });
        expect(mgr.activeForTab("https://example.com/", 7)).toBeNull();
        expect(installed.find((r) => r.id === SITE_RULE_BASE)?.condition.excludedTabIds).toEqual([7]);

        // Fallback headerChangesFor applies when DNR session rules aren't available
        (globalThis as any).chrome.declarativeNetRequest = undefined;
        expect(mgr.headerChangesFor({ tabId: 7, url: "https://example.com/", type: "main_frame" })).toBeNull();
        await mgr.setTabMode(7, "custom");
        expect(mgr.headerChangesFor({ tabId: 7, url: "https://example.com/", type: "main_frame" })).toEqual({
            set: { "Content-Security-Policy": STRICT_SITE_CSP },
        });

        // Restore DNR and verify forgetTab removes excludedTabIds
        (globalThis as any).chrome.declarativeNetRequest = {
            getSessionRules: (cb?: (rules: any[]) => void) => (cb ? void cb([...installed]) : Promise.resolve([...installed])),
            updateSessionRules: ({ removeRuleIds = [], addRules = [] }: any, cb?: () => void) => {
                const drop = new Set(removeRuleIds);
                installed = installed.filter((r) => !drop.has(r.id)).concat(addRules);
                return cb ? void cb() : Promise.resolve();
            },
        };
        await mgr.setTabMode(7, "original");
        expect(installed.find((r) => r.id === SITE_RULE_BASE)?.condition.excludedTabIds).toEqual([7]);
        mgr.forgetTab(7);
        await mgr.reload([s]);
        expect(installed.find((r) => r.id === SITE_RULE_BASE)?.condition.excludedTabIds).toBeUndefined();
    });
});
