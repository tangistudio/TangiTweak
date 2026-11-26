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
import type { ToastStyle } from "./toast";

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
    /** Its `tweak.every` schedules, in order. Absent when it has none. */
    every?: EveryMeta[];
    /** What it set up for toasts at top level. Absent when nothing. */
    toast?: ToastMeta;
}

/** One `tweak.every` schedule, as the compile found it. */
export interface EveryMeta {
    /** Its registration index in the script (`every #index` in the Log). */
    index: number;
    /** The line of the `tweak.every` call in the script, when known. */
    line?: number;
    /** A fixed interval's period in milliseconds (after clamping). Absent for an interval function or a bad interval. */
    periodMs?: number;
    /** Set when the interval is a function, read in the background whenever a store it read changes. */
    dynamic?: true;
    /** Set when a fixed interval was shorter than the 1 minute floor and was clamped up to it. */
    clamped?: true;
    /** Why a fixed interval is unusable (`"1x"`), for Problems. */
    error?: string;
}

/** A script's toast setup. */
export interface ToastMeta {
    /** Whether it registered `tweak.onToastAction`. */
    actions?: true;
    /** The names of its `tweak.toastPane` panes, in order. */
    panes?: string[];
    /** Its merged `tweak.toastStyle`. */
    style?: ToastStyle;
    /** Style keys more than one `tweak.toastStyle` call set (Problems warns). */
    repeated?: string[];
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

/** Fills `active` (it registered a handler or a `tweak.every`) and `match` from `routes` in place and returns `meta`. */
export function finishMeta(meta: ResMeta): ResMeta {
    meta.active = meta.routes.length > 0 || !!meta.every?.length;
    meta.match = scriptUrls(meta.routes);
    return meta;
}
