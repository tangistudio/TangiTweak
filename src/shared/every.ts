/**
 * `tweak.every`: the limits shared by the compile (which records each
 * schedule in the script's meta), the background scheduler and the test
 * SDK, and {@link everyPeriod}, which reads an interval.
 *
 * @module
 */

import { parseDuration } from "./duration";

/** The shortest period, in milliseconds (1 minute): a shorter one is clamped up to it. */
export const EVERY_MIN_MS = 60_000;
/** The longest a period grows to after failures in a row, in milliseconds (1 day). */
export const EVERY_MAX_BACKOFF_MS = 86_400_000;
/** How many failed runs in a row start doubling the period. */
export const EVERY_BACKOFF_AFTER = 5;
/** How long one run may take before its `ctx.signal` aborts it, in milliseconds. */
export const EVERY_TIMEOUT_MS = 60_000;
/** The most `tweak.every` schedules one tweak registers. */
export const EVERY_MAX = 50;
/** The most `tweak.fetch` calls one run makes. */
export const EVERY_MAX_FETCHES = 20;

/** Why a run started: on schedule, overdue at browser start, or Run now. */
export type EveryReason = "alarm" | "startup" | "manual";

/** What an interval reads as: a period, off, or an error to show. */
export type EveryPeriod = { ms: number; clamped?: true } | { off: true } | { error: string };

/** Reads an interval's value: a duration (clamped to {@link EVERY_MIN_MS}), or `false`, `null`, `undefined` or `0` for off. */
export function everyPeriod(value: unknown): EveryPeriod {
    if (value === false || value === null || value === undefined || value === 0 || value === "") return { off: true };
    try {
        const ms = parseDuration(value as any, "tweak.every: interval");
        return ms < EVERY_MIN_MS ? { ms: EVERY_MIN_MS, clamped: true } : { ms };
    } catch (e: any) {
        return { error: String(e?.message ?? e) };
    }
}

/** The period after `failures` failed runs in a row: doubled per failure from {@link EVERY_BACKOFF_AFTER} on, up to {@link EVERY_MAX_BACKOFF_MS}. */
export function backoffPeriod(ms: number, failures: number): number {
    if (failures < EVERY_BACKOFF_AFTER) return ms;
    return Math.min(EVERY_MAX_BACKOFF_MS, ms * 2 ** Math.min(20, failures - EVERY_BACKOFF_AFTER + 1));
}
