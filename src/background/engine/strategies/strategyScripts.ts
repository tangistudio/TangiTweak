/**
 * Shared per-strategy plumbing: which handler routes a strategy owns (the
 * scripts compile in the sandbox, see compileHost).
 */
import { effectiveStrategy, isNetKind, type RouteMeta, type ScriptLayers, type Strategy } from "../../../shared/route";
import type { ResMeta } from "../../../shared/metaParser";

export interface ScriptLike {
    id: string;
    code: string;
    enabled: boolean;
    meta: ResMeta;
    /** explicit layers (user setting, package.json), attached on reload */
    layers?: ScriptLayers;
}

export interface OwnedRoute {
    id: string;
    name: string;
    route: RouteMeta;
}

/** enabled scripts' request routes (onPage/onOverlay excluded) whose effective strategy is `tier` */
export function ownedRoutes(scripts: ScriptLike[], tier: Strategy): OwnedRoute[] {
    const out: OwnedRoute[] = [];
    for (const s of scripts) {
        if (!s.enabled || !s.meta.active) continue;
        for (const r of s.meta.routes || []) {
            if (isNetKind(r.kind) && effectiveStrategy(r) === tier) out.push({ id: s.id, name: s.meta.name, route: r });
        }
    }
    return out;
}

/** does the script own any route on `tier` (from its analyzed meta)? */
export function ownsAny(s: ScriptLike, tier: Strategy): boolean {
    return (s.meta.routes || []).some((r) => isNetKind(r.kind) && effectiveStrategy(r) === tier);
}
