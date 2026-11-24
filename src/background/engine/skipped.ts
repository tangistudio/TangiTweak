/**
 * "→ skipped:" warnings — a handler that matched a request but didn't run
 * because a final result (block, redirect, replacement) took priority.
 * The rules live in shared/precedence.ts; this keeps the enabled routes
 * (refreshed by pipeline.reload) and logs one WARN line per request that the
 * Network view shows as "missed" (`is:missed`).
 */
import { effectiveStrategy, handlerLayer, isNetKind } from "../../shared/route";
import { handlerStack, skippedBy, skippedLine, type RouteRef, type StackHandler, type SkipOptions, type SkipRequest, type Winner } from "../../shared/precedence";
import { log } from "./logs";
import type { Script } from "./scriptStore";

let routes: RouteRef[] = [];

/** enabled scripts' network routes, in list order */
export function netRouteRefs(scripts: Script[]): RouteRef[] {
    const out: RouteRef[] = [];
    scripts.forEach((s, order) => {
        if (!s.enabled || !s.meta.active) return;
        for (const route of s.meta.routes || []) {
            if (!isNetKind(route.kind)) continue;
            const l = handlerLayer(route, s.layers);
            out.push({ scriptId: s.id, scriptName: s.meta.name, order, route, layer: l.layer, layerSource: l.source, strategy: effectiveStrategy(route) });
        }
    });
    return out;
}

export function setSkipRoutes(scripts: Script[]): void {
    routes = netRouteRefs(scripts);
}

/** the handlers that match a request, in run order (the Network view's stack) */
export function stackFor(req: SkipRequest): StackHandler[] {
    return handlerStack(routes, req);
}

/** warn for every handler `w` kept from running on this request */
export function reportSkipped(tabId: number, req: SkipRequest, w: Winner | null | undefined, requestId?: string, opts?: SkipOptions): void {
    if (!w || !routes.length) return;
    for (const r of skippedBy(routes, req, w, opts)) log(tabId, skippedLine(r, w, req.url, opts), "warn", r.scriptId, "missed", req.url, requestId);
}

/** test seam */
export function __skipRoutes(): RouteRef[] {
    return routes;
}
