/**
 * Script metadata ({@link ResMeta}), worked out when a script compiles: its
 * top-level code runs once and the handlers it registers become its routes.
 *
 * A script is ACTIVE when its top-level code registers at least one handler
 * (`tweak.onRequest(route, fn)`, …). A bundle's modules register nothing on
 * their own: the entry calls into them.
 *
 * @module
 */

import { scriptUrls, type RouteMeta } from "./route";

export type { Strategy } from "./route";

/** What a script's compile found out about it, saved with the script. */
export interface ResMeta {
    /** The script's display name (its file name in the Editor). */
    name: string;
    /** Whether it registered at least one handler at top level (with its current params). */
    active: boolean;
    /** The handlers it registered, in order; empty when it registered none or failed to compile. */
    routes: RouteMeta[];
    /** The union of its routes' URL patterns, for the badge and "active on this tab" only (never to dispatch). */
    match: string[];
}

/**
 * The metadata of a script that registered nothing, named `"Untitled script"`.
 * Shared: copy it with {@link defaultMeta} rather than changing it.
 */
export const DEFAULT_META: ResMeta = {
    name: "Untitled script",
    active: false,
    routes: [],
    match: [],
};

/** Makes a fresh copy of {@link DEFAULT_META}, named `name` (e.g. the file name) when given. */
export function defaultMeta(name?: string): ResMeta {
    return { ...DEFAULT_META, routes: [], match: [], name: name || DEFAULT_META.name };
}

/** Fills `active` and `match` from `routes` in place and returns `meta`. */
export function finishMeta(meta: ResMeta): ResMeta {
    meta.active = meta.routes.length > 0;
    meta.match = scriptUrls(meta.routes);
    return meta;
}
