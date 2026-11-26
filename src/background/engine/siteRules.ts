/**
 * `tweak.site` page silencing and per-tab Original/Custom mode management.
 *
 * Matching `main_frame` documents receive a `Content-Security-Policy` header
 * via declarativeNetRequest session rules (Chrome MV3/MV2) or blocking
 * webRequest (Firefox) so the original website's scripts, styles and media do
 * not execute while TangiTweak mounts the replacement app in place.
 *
 * Session rule ID layout:
 * - `1..799_999`: `rulesStrategy.ts` (`priority >= 4`)
 * - `800_000..899_999`: `siteRules.ts` (`priority = 1` for CSP `modifyHeaders`,
 *   `priority = 2` for `exclude` `allow` rules so exclusions only cancel site
 *   silencing and never user `rules`-strategy handlers)
 * - `900_000+`: `bypass.ts` (`tweak.fetch` bypass)
 */
import { patternToRegex } from "../../shared/dnrRules";
import { isSiteRoute, routeMatches, routePatterns, type RouteMeta, type SiteDefaultMode } from "../../shared/route";
import { dlogLevel } from "../../shared/debugLog";
import type { Script } from "./scriptStore";
import { BYPASS_RULE_BASE } from "./bypass";
import { IS_FIREFOX } from "./strategies/helperState";

/** First DNR session rule id reserved for `tweak.site`. */
export const SITE_RULE_BASE = 800_000;
const SITE_RULE_MAX = BYPASS_RULE_BASE - 1;
const NONCE_STORAGE_KEY = "ttSiteCspNonce";
const OVERRIDES_STORAGE_KEY = "ttSiteTabOverrides";

/** Strict CSP that blocks the original document's scripts, styles, media and objects. */
export const STRICT_SITE_CSP = "script-src 'none'; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'";

/** CSP for opt-in `debuggerSafe` mode: blocks host scripts while allowing our nonce-tagged `srcdoc` bootstrap. */
export function debuggerSafeSiteCsp(nonce: string): string {
    return `script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; object-src 'none'`;
}

export interface SiteMatch {
    scriptId: string;
    scriptName: string;
    route: RouteMeta;
    defaultMode: SiteDefaultMode;
    debuggerSafe: boolean;
}

export interface SiteTabState {
    /** Whether any enabled `tweak.site` route matches this tab's URL. */
    matched: boolean;
    scriptId?: string;
    scriptName?: string;
    /** Active mode for this tab: `"custom"` (replaced) or `"original"` (untouched). */
    mode?: SiteDefaultMode;
    defaultMode?: SiteDefaultMode;
    debuggerSafe?: boolean;
}

function dnrApi(): any {
    const g = globalThis as any;
    return g.browser?.declarativeNetRequest ?? g.chrome?.declarativeNetRequest;
}

function dnrCall<T = any>(fn: string, ...args: any[]): Promise<T> {
    const g = globalThis as any;
    if (g.browser?.declarativeNetRequest?.[fn]) return g.browser.declarativeNetRequest[fn](...args);
    return new Promise((resolve, reject) => {
        g.chrome.declarativeNetRequest[fn](...args, (r: T) => {
            const e = g.chrome.runtime.lastError;
            if (e) reject(new Error(e.message));
            else resolve(r);
        });
    });
}

function randomNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pure helper that builds DNR session rules for all enabled `tweak.site`
 * scripts given the current per-tab overrides and session CSP nonce.
 */
export function buildSiteDnrRules(
    scripts: Pick<Script, "id" | "enabled" | "meta">[],
    tabOverrides: ReadonlyMap<number, SiteDefaultMode>,
    cspNonce: string
): any[] {
    const forcedOriginal: number[] = [];
    const forcedCustom: number[] = [];
    for (const [tabId, mode] of tabOverrides) {
        if (mode === "original") forcedOriginal.push(tabId);
        else forcedCustom.push(tabId);
    }
    const rules: any[] = [];
    let nextId = SITE_RULE_BASE;

    for (const s of scripts) {
        if (!s.enabled || !s.meta.active) continue;
        for (const r of s.meta.routes || []) {
            if (!isSiteRoute(r)) continue;
            const defaultMode: SiteDefaultMode = r.defaultMode || "custom";
            // `defaultMode: "original"` only silences tabs explicitly toggled to custom
            if (defaultMode === "original" && !forcedCustom.length) continue;

            const csp = r.debuggerSafe ? debuggerSafeSiteCsp(cspNonce) : STRICT_SITE_CSP;
            for (const pattern of routePatterns(r.url)) {
                if (nextId > SITE_RULE_MAX) break;
                let regex: string;
                try {
                    regex = patternToRegex(pattern).regex;
                } catch {
                    continue;
                }
                const condition: any = {
                    regexFilter: regex,
                    isUrlFilterCaseSensitive: true,
                    resourceTypes: ["main_frame"],
                };
                if (defaultMode === "custom" && forcedOriginal.length) condition.excludedTabIds = [...forcedOriginal];
                else if (defaultMode === "original") condition.tabIds = [...forcedCustom];
                rules.push({
                    id: nextId++,
                    priority: 1,
                    action: {
                        type: "modifyHeaders",
                        responseHeaders: [{ header: "Content-Security-Policy", operation: "set", value: csp }],
                    },
                    condition,
                });
            }
            for (const ex of routePatterns(r.exclude)) {
                if (nextId > SITE_RULE_MAX) break;
                let regex: string;
                try {
                    regex = patternToRegex(ex).regex;
                } catch {
                    continue;
                }
                rules.push({
                    id: nextId++,
                    priority: 2,
                    action: { type: "allow" },
                    condition: {
                        regexFilter: regex,
                        isUrlFilterCaseSensitive: true,
                        resourceTypes: ["main_frame"],
                    },
                });
            }
        }
    }
    return rules;
}

/** Finds the winning (last-matching) `tweak.site` registration for `url`. */
export function matchSiteForUrl(scripts: Pick<Script, "id" | "enabled" | "meta">[], url: string): SiteMatch | null {
    let winner: SiteMatch | null = null;
    for (const s of scripts) {
        if (!s.enabled || !s.meta.active) continue;
        for (const r of s.meta.routes || []) {
            if (!isSiteRoute(r)) continue;
            if (!routeMatches(r, url)) continue;
            winner = {
                scriptId: s.id,
                scriptName: s.meta.name,
                route: r,
                defaultMode: r.defaultMode || "custom",
                debuggerSafe: !!r.debuggerSafe,
            };
        }
    }
    return winner;
}

export class SiteRulesManager {
    private scripts: Script[] = [];
    private tabOverrides = new Map<number, SiteDefaultMode>();
    private cspNonce: string | null = null;
    private hydrated = false;
    private chain: Promise<void> = Promise.resolve();

    /** Hydrates the session CSP nonce and per-tab overrides from `chrome.storage.session` (MV3 wake-safe). */
    async ensureReady(): Promise<void> {
        if (this.hydrated) return;
        this.hydrated = true;
        try {
            const sess = (globalThis as any).chrome?.storage?.session;
            if (sess?.get) {
                const stored = await sess.get([NONCE_STORAGE_KEY, OVERRIDES_STORAGE_KEY]);
                if (typeof stored?.[NONCE_STORAGE_KEY] === "string" && stored[NONCE_STORAGE_KEY].length >= 16) {
                    this.cspNonce = stored[NONCE_STORAGE_KEY];
                }
                const saved = stored?.[OVERRIDES_STORAGE_KEY];
                if (saved && typeof saved === "object") {
                    for (const [k, v] of Object.entries(saved)) {
                        const id = Number(k);
                        if (Number.isInteger(id) && (v === "custom" || v === "original")) this.tabOverrides.set(id, v);
                    }
                }
            }
        } catch {}
        if (!this.cspNonce) {
            this.cspNonce = randomNonce();
            try {
                await (globalThis as any).chrome?.storage?.session?.set?.({ [NONCE_STORAGE_KEY]: this.cspNonce });
            } catch {}
        }
    }

    private async persistOverrides(): Promise<void> {
        try {
            const obj: Record<string, SiteDefaultMode> = {};
            for (const [k, v] of this.tabOverrides) obj[String(k)] = v;
            await (globalThis as any).chrome?.storage?.session?.set?.({ [OVERRIDES_STORAGE_KEY]: obj });
        } catch {}
    }

    async getCspNonce(): Promise<string> {
        await this.ensureReady();
        return this.cspNonce!;
    }

    reload(scripts: Script[]): Promise<void> {
        this.scripts = scripts;
        this.chain = this.chain
            .then(() => this.syncDnr())
            .catch((e: any) => dlogLevel("rules", "error", `site rules sync failed: ${e?.message || e}`));
        return this.chain;
    }

    /** Returns the winning `tweak.site` match for `url`, ignoring per-tab mode. */
    match(url: string): SiteMatch | null {
        return matchSiteForUrl(this.scripts, url);
    }

    /** Returns the winning `tweak.site` match if it is active in `"custom"` mode on `tabId`, else `null`. */
    activeForTab(url: string, tabId: number): SiteMatch | null {
        const hit = this.match(url);
        if (!hit) return null;
        const mode = this.tabOverrides.get(tabId) ?? hit.defaultMode;
        return mode === "custom" ? hit : null;
    }

    /** Popup status for `tabId` at `url`. */
    async tabState(tabId: number, url: string): Promise<SiteTabState> {
        await this.ensureReady();
        const hit = this.match(url);
        if (!hit) return { matched: false };
        const mode = this.tabOverrides.get(tabId) ?? hit.defaultMode;
        return {
            matched: true,
            scriptId: hit.scriptId,
            scriptName: hit.scriptName,
            mode,
            defaultMode: hit.defaultMode,
            debuggerSafe: hit.debuggerSafe,
        };
    }

    /** Sets a tab's mode (`"custom"` or `"original"`), updates DNR rules, and returns the new mode. */
    async setTabMode(tabId: number, mode: SiteDefaultMode): Promise<SiteDefaultMode> {
        await this.ensureReady();
        this.tabOverrides.set(tabId, mode);
        await this.persistOverrides();
        await this.reload(this.scripts);
        return mode;
    }

    /** Cleans up override state when a tab closes. */
    forgetTab(tabId: number): void {
        if (!this.tabOverrides.delete(tabId)) return;
        void this.persistOverrides();
        void this.reload(this.scripts);
    }

    /**
     * Fallback for Firefox / environments without DNR session rules: returns
     * `Content-Security-Policy` header edits for `webRequest.onHeadersReceived`.
     */
    headerChangesFor(details: { url: string; tabId: number; type: string }): { set: Record<string, string> } | null {
        if (!IS_FIREFOX && typeof dnrApi()?.updateSessionRules === "function") return null;
        if (details.type !== "main_frame" || details.tabId < 0) return null;
        const hit = this.activeForTab(details.url, details.tabId);
        if (!hit) return null;
        const csp = hit.debuggerSafe && this.cspNonce ? debuggerSafeSiteCsp(this.cspNonce) : STRICT_SITE_CSP;
        return { set: { "Content-Security-Policy": csp } };
    }

    private async syncDnr(): Promise<void> {
        await this.ensureReady();
        if (IS_FIREFOX || typeof dnrApi()?.updateSessionRules !== "function") return;
        const rules = buildSiteDnrRules(this.scripts, this.tabOverrides, this.cspNonce!);
        const existing: any[] = ((await dnrCall("getSessionRules")) || []).filter(
            (r: any) => r.id >= SITE_RULE_BASE && r.id <= SITE_RULE_MAX
        );
        if (!existing.length && !rules.length) return;
        await dnrCall("updateSessionRules", {
            removeRuleIds: existing.map((r) => r.id),
            addRules: rules,
        });
        dlogLevel("rules", "info", `${rules.length} site CSP rule(s) active`);
    }
}
