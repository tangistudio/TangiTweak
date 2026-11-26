import { RouteIndex, isNetKind, type RouteMeta } from "../shared/route";
import type { Script } from "./engine/scriptStore";

type NetRoute = { id: string; route: RouteMeta };
const netIndexes = new WeakMap<readonly Script[], RouteIndex<NetRoute>>();

/** the network routes of the enabled scripts (onPage code counts once it ran on the tab, not when its URL matches) */
function netRoutes(scripts: readonly Script[]): RouteIndex<NetRoute> {
    let index = netIndexes.get(scripts);
    if (!index) {
        const routes = scripts.flatMap((s) => (s.enabled && s.meta.active ? (s.meta.routes || []).filter((r) => isNetKind(r.kind)).map((route) => ({ id: s.id, route })) : []));
        netIndexes.set(scripts, (index = new RouteIndex(routes, (r) => r.route)));
    }
    return index;
}

/** Badge colors: scripts active and fine / some with warnings / some with errors. */
export const BADGE_OK = "#4ec9b0";
export const BADGE_WARN = "#cca700";
export const BADGE_ERROR = "#f14c4c";

export type ScriptProblem = "error" | "warning";

/** The badge's color and tooltip for a tab's active scripts and their problems. */
export function badgeLook(names: string[], problems: (ScriptProblem | undefined)[]): { color: string; title: string } {
    const errors = problems.filter((p) => p === "error").length;
    const warnings = problems.filter((p) => p === "warning").length;
    const color = errors ? BADGE_ERROR : warnings ? BADGE_WARN : BADGE_OK;
    if (!names.length) return { color, title: "TangiTweak" };
    const lines = names.map((n, i) => `${problems[i] === "error" ? "✖" : problems[i] === "warning" ? "⚠" : "•"} ${n}`);
    const head = `TangiTweak — ${names.length} active script${names.length === 1 ? "" : "s"}`;
    const tail = errors || warnings ? [`${[errors && `${errors} with errors`, warnings && `${warnings} with warnings`].filter(Boolean).join(", ")} — see Problems in the Editor`] : [];
    return { color, title: [head, ...lines, ...tail].join("\n") };
}

/**
 * The badge while toasts wait in other tabs (`waiting`: their accent colors,
 * oldest first): a dot after the count, in the newest toast's color, and a
 * line in the tooltip. The tab itself is left out: its toasts show in it.
 */
export function withToastDot(badge: { text: string; color: string; title: string }, waiting: string[]): { text: string; color: string; title: string } {
    if (!waiting.length) return badge;
    const n = waiting.length;
    return { text: `${badge.text}•`, color: waiting[n - 1], title: `${badge.title}\nA toast is waiting in ${n === 1 ? "another tab" : `${n} other tabs`}.` };
}

/**
 * Per-tab set of the scripts active on a tab since its last page load:
 * enabled scripts with a network route matching one of its requests, or
 * whose onPage code actually ran there (an onPage script saved while the
 * page is open isn't counted until it runs on it). Scripts disabled (or
 * left without routes) since stop counting.
 */
export function createBadgeCounter(scripts: () => readonly Script[]) {
    const tabs = new Map<number, Set<string>>();
    const live = () => new Set(scripts().filter((s) => s.enabled && s.meta.active).map((s) => s.id));
    const setOf = (tabId: number) => {
        let set = tabs.get(tabId);
        if (!set) tabs.set(tabId, (set = new Set()));
        return set;
    };
    return {
        /** Record the scripts with a network route matching the tab's request `url`; `newPage` starts the tab over. Returns the active count. */
        note(tabId: number, url: string | undefined, newPage = false): number {
            if (newPage) tabs.delete(tabId);
            if (!url || !/^https?:/i.test(url)) return newPage ? 0 : this.count(tabId);
            const set = setOf(tabId);
            for (const { id } of netRoutes(scripts()).match(url)) set.add(id);
            return this.count(tabId);
        },
        /** The script's page code ran (or tried to) on the tab. Returns the active count. */
        ran(tabId: number, scriptId: string): number {
            if (live().has(scriptId)) setOf(tabId).add(scriptId);
            return this.count(tabId);
        },
        /** Active count without recording anything. */
        count(tabId: number): number {
            return this.ids(tabId).length;
        },
        /** Ids of the scripts the count is made of (the popup marks them). */
        ids(tabId: number): string[] {
            const set = tabs.get(tabId);
            if (!set) return [];
            const on = live();
            for (const id of set) if (!on.has(id)) set.delete(id);
            return [...set];
        },
        forget(tabId: number): void {
            tabs.delete(tabId);
        },
        /** For storage across MV3 service-worker restarts. */
        save(): Record<string, string[]> {
            return Object.fromEntries([...tabs].map(([t, set]) => [String(t), [...set]]));
        },
        /** Merges into what was recorded since the restart. */
        restore(data: unknown): void {
            if (!data || typeof data !== "object") return;
            for (const [t, ids] of Object.entries(data as Record<string, unknown>)) {
                if (!Array.isArray(ids)) continue;
                const set = setOf(Number(t));
                for (const id of ids) if (typeof id === "string") set.add(id);
            }
        },
    };
}
