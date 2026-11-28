/**
 * The `rules` strategy: handlers become declarativeNetRequest SESSION rules
 * that the browser applies itself (no banner, no helper, nothing runs per
 * request).
 *
 * On every reload each rules handler runs once with a tripwire ctx (MV3:
 * in the sandbox; MV2: right here — src/shared/rulesProbe.ts) and is
 * translated to rule specs (src/shared/dnrRules.ts). Then this extension's
 * session rules are replaced wholesale. A handler that can't become a rule
 * is skipped — its script gets a red ⚠ and a rules error in the Problems
 * view — while the script's other handlers keep running.
 *
 * Requests matched by an active rule are marked Modified in the Network
 * view (our own matcher on observed requests; no feedback permission).
 *
 * Order: handlers run by layer (base, site, override), then list order, and
 * the last one wins, so that order becomes rule priority (`rulePriority`).
 */
import { handlerLayer, indexRoutes, routeLabel, routeMatches, sortByLayer, type Layer, type NetKind, type RouteMeta } from "../../../shared/route";
import { reportSkipped } from "../skipped";
import { regexProblemText, rulePriority, ruleErrorLine, substitute, type RuleSpec } from "../../../shared/dnrRules";
import type { ScriptRules } from "../../../shared/rulesProbe";
import { strategyUnsupported } from "../../../shared/strategyInfo";
import { dlogLevel } from "../../../shared/debugLog";
import { probeRules } from "../../compileHost";
import { log, setScriptRuleErrors } from "../logs";
import { dataFilesSig } from "../dataFiles";
import { packagesSig } from "../packageImports";
import type { Script } from "../scriptStore";
import { ownsAny } from "./strategyScripts";
import { IS_FIREFOX } from "./helperState";
import { wsNotApplied } from "../../../shared/websocketLimits";
import { SITE_RULE_BASE } from "../siteRules";
import { storeOwner } from "../stores";

type ParamValues = { [scriptId: string]: Record<string, any> };

interface ActiveRule {
    id: number;
    scriptId: string;
    name: string;
    route: RouteMeta;
    spec: RuleSpec;
    /** the handler's position in run order (layer, then list order), 1-based: a later handler outranks an earlier one */
    rank: number;
    layer: Layer;
}

const CACHE_KEY = "ttRulesState";
/** a store change re-probes after this quiet time */
const REPROBE_MS = 50;

function dnrApi(): any {
    const g = globalThis as any;
    return g.browser?.declarativeNetRequest ?? g.chrome?.declarativeNetRequest;
}

/** call a declarativeNetRequest function: promise (Firefox `browser`, MV3) or callback (MV2 Chromium) */
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

async function regexSupported(regex: string, requireCapturing: boolean): Promise<any> {
    return dnrCall("isRegexSupported", { regex, isCaseSensitive: true, requireCapturing });
}

/** why a url pattern's regex can't be a rule (isRegexSupported), or null */
async function regexProblem(regex: string, pattern: string, requireCapturing: boolean): Promise<string | null> {
    if (typeof dnrApi()?.isRegexSupported !== "function") return null;
    try {
        const r: any = await regexSupported(regex, requireCapturing);
        if (!r || r.isSupported) return null;
        const capturesOnly = r.reason === "memoryLimitExceeded" && requireCapturing && !!(await regexSupported(regex, false).catch(() => null))?.isSupported;
        return regexProblemText(regex, pattern, r.reason || "syntaxError", requireCapturing, capturesOnly);
    } catch {
        return null;
    }
}

function toRule(r: ActiveRule, priority: number): any {
    return { id: r.id, priority, action: r.spec.action, condition: r.spec.condition };
}

export class RulesStrategy {
    private chain: Promise<void> = Promise.resolve();
    private active: { rule: ActiveRule; re: RegExp }[] = [];
    private observing = false;
    private seen = new Set<string>();
    private readonly onEvent = (d: any): void => this.observe(d);
    private last: { scripts: Script[]; paramValues: ParamValues } | null = null;
    /** scripts that own rules: their stores feed the probe */
    private owners = new Set<string>();
    private probing = false;
    private quietUntil = 0;
    private reprobeTimer: ReturnType<typeof setTimeout> | null = null;

    reload(scripts: Script[], paramValues?: ParamValues): Promise<void> {
        this.last = { scripts, paramValues: paramValues || {} };
        this.chain = this.chain
            .then(() => this.apply(scripts, paramValues || {}))
            .catch((e: any) => dlogLevel("rules", "error", `rules reload failed: ${e?.message || e}`));
        return this.chain;
    }

    /**
     * A global or tab store changed: if any script owns rules, re-probe
     * (debounced) — a rules handler (or a library it imports) may read it.
     * Writes made by the probe itself don't trigger another one.
     */
    storeChanged(_scriptId: string): void {
        if (!this.owners.size || this.probing || Date.now() < this.quietUntil || this.reprobeTimer) return;
        this.reprobeTimer = setTimeout(() => {
            this.reprobeTimer = null;
            if (this.last) void this.reload(this.last.scripts, this.last.paramValues);
        }, REPROBE_MS);
    }

    /** global + tab store snapshots and revs of `ids` (part of the probe signature; `pageStore` copies don't feed rules) */
    private async storeState(ids: string[]): Promise<{ snaps: Record<string, Record<string, { rev: number; data: any }>>; revs: Record<string, Record<string, number>>; tabIds: number[] }> {
        const [snaps, tabIds] = await Promise.all([storeOwner.init(ids, { page: null, tabs: true }), storeOwner.tabsOf(ids)]);
        const revs: Record<string, Record<string, number>> = {};
        for (const [s, stores] of Object.entries(snaps)) revs[s] = Object.fromEntries(Object.entries(stores).map(([n, v]) => [n, v.rev]));
        return { snaps, revs, tabIds };
    }

    private async apply(scripts: Script[], paramValues: ParamValues): Promise<void> {
        if (strategyUnsupported("rules", { firefox: IS_FIREFOX })) return; // routeProblem warns
        const owners = scripts.filter((s) => s.enabled && s.meta.active && ownsAny(s, "rules"));
        this.owners = new Set(owners.map((s) => s.id));
        const names = new Map(scripts.map((s) => [s.id, s.meta.name]));
        if (!owners.length) {
            await this.replace([]);
            await setScriptRuleErrors(new Map(), names);
            await this.saveCache(null);
            this.setActive([]);
            return;
        }
        const enabled = scripts.filter((s) => s.enabled);
        const state = await this.storeState(enabled.map((s) => s.id));
        const sig = JSON.stringify([enabled.map((s) => [s.id, s.updatedAt, s.meta.name, s.layers ?? {}]), paramValues, dataFilesSig(), packagesSig(), state.revs, state.tabIds]);
        if (await this.restoreCache(sig)) return;

        let probed: Map<string, ScriptRules>;
        this.probing = true;
        try {
            probed = await this.probe(scripts, owners, paramValues, state.tabIds, state.snaps);
        } finally {
            this.probing = false;
            this.quietUntil = Date.now() + REPROBE_MS;
        }
        const errors = new Map<string, string[]>();
        const addError = (id: string, line: string) => errors.set(id, [...(errors.get(id) || []), line]);
        // group rule specs per handler, in run order: layer, then script order
        const listed: { scriptId: string; name: string; route: RouteMeta; specs: RuleSpec[]; layer: Layer }[] = [];
        for (const s of scripts) {
            const r = probed.get(s.id);
            if (!r) continue;
            for (const e of r.errors) addError(s.id, e);
            for (const h of r.rules) listed.push({ scriptId: s.id, name: s.meta.name, route: h.route, specs: h.specs, layer: handlerLayer(h.route, s.layers).layer });
        }
        const groups = sortByLayer(listed, (g) => g.layer);
        // RE2 pre-check: attribute an unsupported regex to its handler
        const regexOk = new Map<string, string | null>();
        const accepted: typeof groups = [];
        for (const g of groups) {
            let problem: string | null = null;
            for (const spec of g.specs) {
                const re = spec.condition.regexFilter as string;
                const capturing = typeof spec.action.redirect?.regexSubstitution === "string";
                const key = `${capturing ? 1 : 0}${re}`;
                if (!regexOk.has(key)) regexOk.set(key, await regexProblem(re, spec.pattern, capturing));
                problem = regexOk.get(key)!;
                if (problem) break;
            }
            if (problem) addError(g.scriptId, ruleErrorLine(g.route, problem));
            else accepted.push(g);
        }
        let nextId = 1;
        const handlerRules = accepted.map((g, i) => g.specs.map((spec) => ({ id: nextId++, scriptId: g.scriptId, name: g.name, route: g.route, spec, rank: i + 1, layer: g.layer })));
        const all = handlerRules.flat();
        const priorities = this.priorities(all);
        const asRules = (list: ActiveRule[]) => list.map((r) => toRule(r, priorities.get(r.id)!));
        let applied: ActiveRule[] = all;
        try {
            await this.replace(asRules(all));
        } catch (e: any) {
            // one handler at a time, so the browser's error names the right handler
            dlogLevel("rules", "warn", `session rules rejected as a batch (${e?.message || e}) — adding them per handler`);
            await this.replace([]);
            applied = [];
            for (const list of handlerRules) {
                try {
                    await dnrCall("updateSessionRules", { addRules: asRules(list) });
                    applied.push(...list);
                } catch (err: any) {
                    addError(list[0].scriptId, ruleErrorLine(list[0].route, `the browser rejected the rule: ${err?.message || err}`));
                }
            }
        }
        await setScriptRuleErrors(errors, names);
        this.setActive(applied);
        dlogLevel("rules", "info", `${applied.length} session rule(s) active for ${[...new Set(applied.map((r) => `"${r.name}"`))].join(", ") || "no script"}`);
        await this.saveCache({ sig, active: applied, errors: Object.fromEntries(errors), names: Object.fromEntries(names) });
    }

    /** each rule's priority from its handler's run order ({@link rulePriority}) */
    private priorities(all: ActiveRule[]): Map<number, number> {
        return new Map(all.map((r) => [r.id, rulePriority(r.spec, r.rank)]));
    }

    private async probe(scripts: Script[], owners: Script[], paramValues: ParamValues, tabIds: number[], storeSnaps: Record<string, any>): Promise<Map<string, ScriptRules>> {
        const out = new Map<string, ScriptRules>();
        // the same script set the other strategies send: keeps the sandbox's compile cache warm
        const plain = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
        const results = await probeRules(plain, paramValues, tabIds, storeSnaps);
        if (!results) {
            dlogLevel("rules", "warn", "the sandbox didn't answer — keeping the current session rules");
            throw new Error("rules probe failed");
        }
        for (const [id, r] of Object.entries(results)) out.set(id, r);
        return out;
    }

    /** remove every rules-strategy session rule (leaving `tweak.site` and `tweak.fetch` bypass rules alone), then add `rules` */
    private async replace(rules: any[]): Promise<void> {
        const existing: any[] = ((await dnrCall("getSessionRules")) || []).filter((r: any) => r.id < SITE_RULE_BASE);
        if (!existing.length && !rules.length) return;
        await dnrCall("updateSessionRules", { removeRuleIds: existing.map((r) => r.id), addRules: rules });
    }

    // ---- skip re-probing on background wake ----

    private async restoreCache(sig: string): Promise<boolean> {
        try {
            const d = await chrome.storage.session.get(CACHE_KEY);
            const c = d?.[CACHE_KEY];
            if (!c || c.sig !== sig) return false;
            const live: any[] = ((await dnrCall("getSessionRules")) || []).filter((r: any) => r.id < SITE_RULE_BASE);
            const ids = new Set(live.map((r) => r.id));
            if (live.length !== c.active.length || !c.active.every((r: ActiveRule) => ids.has(r.id))) return false;
            await setScriptRuleErrors(new Map(Object.entries(c.errors || {})), new Map(Object.entries(c.names || {})));
            this.setActive(c.active);
            return true;
        } catch {
            return false;
        }
    }

    private async saveCache(v: unknown): Promise<void> {
        try {
            if (v) await chrome.storage.session.set({ [CACHE_KEY]: v });
            else await chrome.storage.session.remove(CACHE_KEY);
        } catch {}
    }

    // ---- Network view: mark requests an active rule matched ----

    private setActive(active: ActiveRule[]): void {
        this.active = active.map((rule) => ({ rule, re: new RegExp(rule.spec.condition.regexFilter) }));
        const wr = (globalThis as any).chrome?.webRequest;
        if (!wr) return;
        const filter = { urls: ["<all_urls>"] };
        if (active.length && !this.observing) {
            this.observing = true;
            // whichever fires first for a request: a blocked one may only
            // reach onErrorOccurred, a redirected one onBeforeRedirect
            wr.onBeforeRequest.addListener(this.onEvent, filter);
            wr.onBeforeRedirect.addListener(this.onEvent, filter);
            wr.onErrorOccurred.addListener(this.onEvent, filter);
        } else if (!active.length && this.observing) {
            this.observing = false;
            wr.onBeforeRequest.removeListener(this.onEvent);
            wr.onBeforeRedirect.removeListener(this.onEvent);
            wr.onErrorOccurred.removeListener(this.onEvent);
        }
    }

    private observe(d: any): void {
        if (!this.active.length || this.seen.has(d.requestId)) return;
        this.seen.add(d.requestId);
        if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
        const tabId = d.tabId ?? -1;
        const hits = indexRoutes(this.active, (a) => a.rule.route)
            .candidates(d.url)
            .filter((a) => {
                const c = a.rule.spec.condition;
                if (Array.isArray(c.tabIds) && !c.tabIds.includes(tabId)) return false;
                if (Array.isArray(c.excludedTabIds) && c.excludedTabIds.includes(tabId)) return false;
                return a.re.test(d.url) && routeMatches(a.rule.route, d.url, d.method, d.type);
            })
            .map((a) => a.rule);
        if (!hits.length) return;
        // the top decision; an allow only keeps the later handlers' header edits (they outrank it)
        const final = hits.filter((r) => r.spec.final).reduce<ActiveRule | undefined>((a, r) => (!a || r.rank >= a.rank ? r : a), undefined);
        const allowed = final?.spec.action.type === "allow";
        for (const r of !final ? hits : allowed ? hits.filter((h) => h === final || (!h.spec.final && h.rank > final.rank)) : [final]) {
            const what = r.spec.summary;
            const sub = r.spec.action.redirect?.regexSubstitution;
            const to = sub ? substitute(r.spec.condition.regexFilter, sub, d.url) : r.spec.action.redirect?.url;
            const label = `[rules] [${r.name}] ${routeLabel(r.route).replace(/ #\d+$/, "")}`;
            if (d.type === "websocket" && r.spec.action.type === "redirect" && !IS_FIREFOX) {
                log(d.tabId ?? -1, `${label} → ${wsNotApplied(what === "redirect" ? "redirect" : "replaceResponse", "rules", d.url, to)}`, "warn", r.scriptId, undefined, d.url);
                continue;
            }
            if (r.spec.action.type === "allow") {
                log(d.tabId ?? -1, `${label} → allow ${d.url}`, "info", r.scriptId, undefined, d.url);
                continue;
            }
            log(d.tabId ?? -1, to ? `${label} → redirect ${d.url} → ${to}` : `${label} → ${what} ${d.url}`, "info", r.scriptId, "modified", d.url);
            if (r === final) {
                const block = r.spec.action.type === "block";
                reportSkipped(d.tabId ?? -1, { url: d.url, method: d.method, type: d.type }, { scriptId: r.scriptId, scriptName: r.name, kind: r.route.kind as NetKind, index: r.route.index, strategy: "rules", outcome: block ? "block" : "redirect", target: block ? undefined : to });
            }
        }
    }
}

