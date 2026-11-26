/**
 * Runs a compiled tweak's `tweak.every` handlers, reads their intervals and
 * runs its `tweak.onToastAction` handlers. Shared by the MV3 sandbox, the
 * MV2 background and the test SDK, so all three behave the same.
 *
 * @module
 */
import type { ScriptHandlers } from "./compile";
import { EVERY_TIMEOUT_MS, everyPeriod, type EveryPeriod, type EveryReason } from "./every";
import type { ToastEvent } from "./toast";

/** What one `tweak.every` run receives as `ctx`. */
export interface EveryCtx {
    /** Aborts when the run takes longer than its time limit. */
    signal: AbortSignal;
    /** Why it runs. */
    reason: EveryReason;
    /** When it last ran, in ms since epoch. */
    lastRun?: number;
    /** Unschedules this `every` until the tweak is saved, turned on again or run by hand. */
    stop(): void;
}

/** How one run went. */
export interface EveryOutcome {
    ok: boolean;
    /** Why it failed. */
    error?: string;
    /** It called `ctx.stop()`. */
    stopped?: true;
    /** How long it took, in ms. */
    ms: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs schedule `index` of a tweak. Never throws: a failure is in the outcome. */
export async function runEvery(h: ScriptHandlers, index: number, a: { reason: EveryReason; lastRun?: number }, timeoutMs = EVERY_TIMEOUT_MS): Promise<EveryOutcome> {
    const t0 = Date.now();
    const entry = h.every.find((e) => e.index === index);
    if (!entry) return { ok: false, error: `tweak.every #${index} is gone`, ms: 0 };
    const ac = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctx: EveryCtx = {
        signal: ac.signal,
        reason: a.reason,
        ...(a.lastRun !== undefined ? { lastRun: a.lastRun } : {}),
        stop: () => void (stopped = true),
    };
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            ac.abort(new Error(`tweak.every #${index} took longer than ${Math.round(timeoutMs / 1000)} s`));
            reject(ac.signal.reason);
        }, timeoutMs);
    });
    try {
        await Promise.race([Promise.resolve().then(() => entry.fn(ctx)), timeout]);
        return { ok: true, ...(stopped ? { stopped: true as const } : {}), ms: Date.now() - t0 };
    } catch (e) {
        return { ok: false, error: msg(e), ...(stopped ? { stopped: true as const } : {}), ms: Date.now() - t0 };
    } finally {
        clearTimeout(timer);
    }
}

/** Reads schedule `index`'s interval now: a function is called (a throw or a bad value reads as an error, which counts as off). */
export function readInterval(h: ScriptHandlers, index: number): EveryPeriod {
    const entry = h.every.find((e) => e.index === index);
    if (!entry) return { off: true };
    if (typeof entry.interval !== "function") return everyPeriod(entry.interval);
    try {
        const v = (entry.interval as () => unknown)();
        if (v && typeof (v as any).then === "function") return { error: "tweak.every: the interval function must return a duration right away, not a promise" };
        return everyPeriod(v);
    } catch (e) {
        return { error: `tweak.every: the interval function threw: ${msg(e)}` };
    }
}

/** Runs a tweak's `tweak.onToastAction` handlers in order; throws the first failure after all ran. */
export async function runToastAction(h: ScriptHandlers, event: ToastEvent): Promise<void> {
    let first: unknown;
    for (const a of h.toastAction) {
        try {
            await a.fn({ ...event });
        } catch (e) {
            first ??= e;
        }
    }
    if (first !== undefined) throw first;
}
