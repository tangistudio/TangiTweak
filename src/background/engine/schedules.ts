/**
 * `tweak.every`: one `chrome.alarms` alarm per enabled schedule
 * (`tt-every:<scriptId>:<index>`), reconciled on every reload. Each alarm
 * runs its handler in the background (MV3: the sandbox, MV2: in process,
 * through a {@link ScheduleRunner}). The state of each schedule (last run,
 * failures in a row, stopped, paused) lives in chrome.storage.local so a
 * restarted service worker and a browser restart keep it.
 *
 * Rules (docs/scripting.md, tweak.every):
 * - runs of one schedule never overlap, and one run gets 60 s;
 * - after {@link EVERY_BACKOFF_AFTER} failures in a row the period doubles;
 * - `ctx.stop()` holds it until the tweak is saved, turned on again or Run now;
 * - the user's pause wins over the tweak;
 * - an interval function is read again when a store of the tweak changes;
 * - `tweak.fetch` in a run makes at most {@link EVERY_MAX_FETCHES} calls, and
 *   a packaged tweak reaches only its `"tangitweak.connect"` hosts.
 *
 * @module
 */
import { backoffPeriod, EVERY_BACKOFF_AFTER, EVERY_MAX_FETCHES, type EveryPeriod, type EveryReason } from "../../shared/every";
import type { EveryOutcome } from "../../shared/everyRun";
import type { EveryMeta, ResMeta } from "../../shared/metaParser";
import type { ToastEvent } from "../../shared/toast";
import { connectAllows } from "../../shared/packageMetadata";
import { log } from "./logs";
import { connectOfScript, setBackgroundFetchGate } from "./stores";

export const ALARM_PREFIX = "tt-every:";
export const SCHEDULES_KEY = "ttSchedules";

/** A script as the scheduler sees it. */
export interface ScheduleScript {
    id: string;
    code: string;
    enabled: boolean;
    updatedAt: number;
    meta: ResMeta;
}

/** Runs a script's background hooks (MV3: the sandbox; MV2: in process). */
export interface ScheduleRunner {
    every(s: string, index: number, a: { reason: EveryReason; lastRun?: number }): Promise<EveryOutcome>;
    interval(s: string, index: number): Promise<EveryPeriod>;
    toastAction(s: string, event: ToastEvent): Promise<void>;
    /** The scripts changed: drop what was compiled for the old ones. */
    reload(scripts: ScheduleScript[], paramValues: Record<string, Record<string, any>>): void;
}

/** One schedule's saved state. */
export interface ScheduleState {
    /** The tweak's `updatedAt` this state is for (a save clears `stopped` and the failures). */
    rev: number;
    lastRun?: number;
    /** How long the last run took, in ms. */
    lastMs?: number;
    lastError?: string;
    /** Failed runs in a row. */
    failures: number;
    /** `ctx.stop()` was called. */
    stopped?: boolean;
    /** The user paused it. */
    paused?: boolean;
    /** The period it runs at now (backoff included), when on. */
    periodMs?: number;
    /** Why it doesn't run, when it doesn't (for the Editor and the popup). */
    off?: string;
}

interface Saved {
    pauseAll?: boolean;
    states: Record<string, ScheduleState>;
}

/** One schedule, for the Editor's Schedules list and the popup. */
export interface ScheduleRow extends ScheduleState {
    scriptId: string;
    name: string;
    index: number;
    line?: number;
    running: boolean;
    /** When it runs next (ms since epoch), when it's on. */
    nextAt?: number;
}

const keyOf = (s: string, i: number) => `${s}:${i}`;
const alarmOf = (s: string, i: number) => `${ALARM_PREFIX}${s}:${i}`;
const minutes = (ms: number) => ms / 60_000;

const alarms = (): typeof chrome.alarms | undefined => (typeof chrome !== "undefined" ? (chrome as any).alarms : undefined);

function getAlarm(name: string): Promise<chrome.alarms.Alarm | undefined> {
    const a = alarms();
    if (!a) return Promise.resolve(undefined);
    return new Promise((r) => a.get(name, (x) => (void chrome.runtime?.lastError, r(x ?? undefined))));
}

function allAlarms(): Promise<chrome.alarms.Alarm[]> {
    const a = alarms();
    if (!a) return Promise.resolve([]);
    return new Promise((r) => a.getAll((x) => (void chrome.runtime?.lastError, r(x ?? []))));
}

function clearAlarm(name: string): Promise<void> {
    const a = alarms();
    if (!a) return Promise.resolve();
    return new Promise((r) => a.clear(name, () => (void chrome.runtime?.lastError, r())));
}

/** The scheduler: one per background. */
export interface Schedules {
    reload(scripts: ScheduleScript[], paramValues: Record<string, Record<string, any>>): Promise<void>;
    /** A store of `s` changed: read its interval functions again. */
    storeChanged(s: string): void;
    /** Runs a schedule now (the Editor's Run now): clears `ctx.stop()`. */
    runNow(s: string, index: number): Promise<EveryOutcome | undefined>;
    /** Pauses or resumes one schedule, or all of a tweak's (`index` undefined). */
    setPaused(s: string, index: number | undefined, paused: boolean): Promise<void>;
    /** Pauses or resumes all polling. */
    setPauseAll(paused: boolean): Promise<void>;
    pausedAll(): Promise<boolean>;
    list(s?: string): Promise<ScheduleRow[]>;
    /** Runs a tweak's onToastAction handlers (the toast center calls it). */
    toastAction(s: string, event: ToastEvent): Promise<void>;
    /** The alarm fired. */
    onAlarm(name: string): Promise<void>;
}

/** Makes the scheduler and hooks it to `chrome.alarms`. */
export function createSchedules(runner: ScheduleRunner): Schedules {
    let scripts: ScheduleScript[] = [];
    let saved: Saved = { states: {} };
    let loaded: Promise<void> | null = null;
    let firstReload = true;
    let ready!: () => void;
    const reloaded = new Promise<void>((r) => (ready = r));
    const running = new Set<string>();
    /** fetches made by each script's runs in progress */
    const fetches = new Map<string, number>();
    const warnedLocal = new Set<string>();

    const load = () =>
        (loaded ??= new Promise<void>((r) => {
            try {
                chrome.storage.local.get([SCHEDULES_KEY], (d) => {
                    void chrome.runtime?.lastError;
                    const v = d?.[SCHEDULES_KEY];
                    saved = v && typeof v === "object" && v.states && typeof v.states === "object" ? v : { states: {} };
                    r();
                });
            } catch {
                r();
            }
        }));
    const save = () =>
        new Promise<void>((r) => {
            try {
                chrome.storage.local.set({ [SCHEDULES_KEY]: saved }, () => (void chrome.runtime?.lastError, r()));
            } catch {
                r();
            }
        });

    const scriptOf = (s: string) => scripts.find((x) => x.id === s);
    const metaOf = (s: string, i: number): EveryMeta | undefined => scriptOf(s)?.meta.every?.find((e) => e.index === i);
    const nameOf = (s: string) => scriptOf(s)?.meta.name ?? s;
    const live = (x: ScheduleScript) => x.enabled && !!x.meta.every?.length;

    /** The period of a schedule now (reads an interval function). */
    async function periodOf(s: string, e: EveryMeta): Promise<EveryPeriod> {
        if (e.dynamic) return runner.interval(s, e.index).catch((err) => ({ error: String(err?.message ?? err) }));
        if (e.error) return { error: e.error };
        return e.periodMs ? { ms: e.periodMs } : { off: true };
    }

    /** Sets one schedule's alarm from its state and period. */
    async function arm(s: string, e: EveryMeta, period?: EveryPeriod): Promise<void> {
        const k = keyOf(s, e.index);
        const st = saved.states[k];
        const name = alarmOf(s, e.index);
        const why = saved.pauseAll ? "all polling is paused" : st.paused ? "paused by you" : st.stopped ? "stopped (ctx.stop)" : undefined;
        const p = why ? undefined : (period ?? (await periodOf(s, e)));
        const off = why ?? (p && "error" in p ? p.error : p && "off" in p ? "off (interval returned false)" : undefined);
        if (off || !p || !("ms" in p)) {
            if (st.off !== off) log(-1, `every #${e.index} ${off}`, "info", s);
            st.off = off;
            delete st.periodMs;
            await clearAlarm(name);
            return;
        }
        delete st.off;
        const ms = backoffPeriod(p.ms, st.failures);
        const old = await getAlarm(name);
        if (old && old.periodInMinutes === minutes(ms) && st.periodMs === ms) return;
        st.periodMs = ms;
        // keep the time it was due: a new period only moves the next run when it's sooner
        const due = st.lastRun !== undefined ? st.lastRun + ms : Date.now() + ms;
        alarms()?.create(name, { when: Math.max(Date.now() + 1000, old ? Math.min(old.scheduledTime, due) : due), periodInMinutes: minutes(ms) });
    }

    async function reload(next: ScheduleScript[], paramValues: Record<string, Record<string, any>>): Promise<void> {
        await load();
        scripts = next;
        runner.reload(next, paramValues);
        const wanted = new Map<string, { s: string; e: EveryMeta }>();
        for (const x of next) if (live(x)) for (const e of x.meta.every!) wanted.set(keyOf(x.id, e.index), { s: x.id, e });
        for (const k of Object.keys(saved.states)) if (!wanted.has(k)) delete saved.states[k];
        for (const a of await allAlarms()) {
            if (!a.name.startsWith(ALARM_PREFIX)) continue;
            if (!wanted.has(a.name.slice(ALARM_PREFIX.length))) await clearAlarm(a.name);
        }
        const overdue: { s: string; i: number }[] = [];
        for (const [k, { s, e }] of wanted) {
            const rev = scriptOf(s)!.updatedAt;
            let st = saved.states[k];
            if (!st) st = saved.states[k] = { rev, failures: 0 };
            else if (st.rev !== rev) {
                // a save starts it over (the user's pause stays)
                st.rev = rev;
                st.failures = 0;
                delete st.stopped;
                delete st.lastError;
            }
            const hadAlarm = !!(await getAlarm(alarmOf(s, e.index)));
            await arm(s, e);
            // the browser lost the alarms (Firefox restart, Chrome update): run what's overdue once
            if (firstReload && !hadAlarm && st.periodMs && st.lastRun !== undefined && Date.now() - st.lastRun >= st.periodMs) overdue.push({ s, i: e.index });
        }
        firstReload = false;
        await save();
        ready();
        for (const o of overdue) void run(o.s, o.i, "startup");
    }

    async function run(s: string, i: number, reason: EveryReason): Promise<EveryOutcome | undefined> {
        const k = keyOf(s, i);
        const e = metaOf(s, i);
        const st = saved.states[k];
        if (!e || !st || !scriptOf(s)?.enabled) return undefined;
        if (reason !== "manual" && (saved.pauseAll || st.paused || st.stopped || st.off)) return undefined;
        if (running.has(k)) {
            log(-1, `every #${i}: still running, skipped this turn`, "info", s);
            return undefined;
        }
        running.add(k);
        try {
            const out = await runner.every(s, i, { reason, ...(st.lastRun !== undefined ? { lastRun: st.lastRun } : {}) }).catch((err): EveryOutcome => ({ ok: false, error: String(err?.message ?? err), ms: 0 }));
            const now = saved.states[k];
            if (!now) return out; // the tweak went away meanwhile
            now.lastRun = Date.now();
            now.lastMs = out.ms;
            const wasFailing = now.failures >= EVERY_BACKOFF_AFTER;
            if (out.ok) {
                now.failures = 0;
                delete now.lastError;
                log(-1, `every #${i}: ran in ${out.ms} ms${reason === "alarm" ? "" : ` (${reason})`}`, "info", s);
            } else {
                now.failures++;
                now.lastError = out.error;
                log(-1, `every #${i} failed: ${out.error}`, "error", s);
                if (now.failures === EVERY_BACKOFF_AFTER) log(-1, `every #${i} failed ${EVERY_BACKOFF_AFTER} times in a row; it waits longer after each failure until it succeeds`, "error", s);
            }
            if (out.stopped) {
                now.stopped = true;
                log(-1, `every #${i} stopped (ctx.stop)`, "info", s);
            }
            // a manual run of a stopped one starts it again
            if (reason === "manual" && !out.stopped) delete now.stopped;
            if (out.stopped || reason === "manual" || wasFailing || now.failures >= EVERY_BACKOFF_AFTER) {
                now.periodMs = undefined;
                await arm(s, e);
            }
            await save();
            return out;
        } finally {
            running.delete(k);
            if (![...running].some((x) => x.startsWith(s + ":"))) fetches.delete(s);
        }
    }

    // a tweak.every run's fetches: counted, and packaged tweaks reach their connect hosts only
    setBackgroundFetchGate(async (s, url) => {
        if (![...running].some((x) => x.startsWith(s + ":"))) return;
        const n = (fetches.get(s) ?? 0) + 1;
        fetches.set(s, n);
        if (n > EVERY_MAX_FETCHES) throw new Error(`tweak.fetch: a tweak.every run makes at most ${EVERY_MAX_FETCHES} requests`);
        const connect = await connectOfScript(s);
        if (connectAllows(connect ?? [], url)) return;
        let host = url;
        try {
            host = new URL(url).hostname;
        } catch {}
        if (connect) throw new Error(`tweak.fetch in tweak.every reaches only the hosts in package.json's "tangitweak.connect" (and their subdomains); add "${host}" to it`);
        if (!warnedLocal.has(`${s}:${host}`)) {
            warnedLocal.add(`${s}:${host}`);
            log(-1, `tweak.fetch in tweak.every reaches ${host}; in a package it would have to be in package.json's "tangitweak.connect"`, "warn", s);
        }
    });

    const storeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const api: Schedules = {
        reload,
        storeChanged(s) {
            const x = scriptOf(s);
            if (!x || !live(x) || !x.meta.every!.some((e) => e.dynamic)) return;
            // a burst of store writes reads the intervals once
            clearTimeout(storeTimers.get(s));
            storeTimers.set(
                s,
                setTimeout(async () => {
                    storeTimers.delete(s);
                    for (const e of x.meta.every!) if (e.dynamic && saved.states[keyOf(s, e.index)]) await arm(s, e);
                    await save();
                }, 50)
            );
        },
        async runNow(s, i) {
            await reloaded;
            return run(s, i, "manual");
        },
        async setPaused(s, i, paused) {
            await reloaded;
            for (const e of scriptOf(s)?.meta.every ?? []) {
                if (i !== undefined && e.index !== i) continue;
                const st = saved.states[keyOf(s, e.index)];
                if (!st) continue;
                if (paused) st.paused = true;
                else delete st.paused;
                await arm(s, e);
            }
            await save();
        },
        async setPauseAll(paused) {
            await reloaded;
            if (paused) saved.pauseAll = true;
            else delete saved.pauseAll;
            for (const x of scripts) if (live(x)) for (const e of x.meta.every!) if (saved.states[keyOf(x.id, e.index)]) await arm(x.id, e);
            await save();
        },
        async pausedAll() {
            await load();
            return !!saved.pauseAll;
        },
        async list(only) {
            await reloaded;
            const rows: ScheduleRow[] = [];
            const all = new Map((await allAlarms()).map((a) => [a.name, a.scheduledTime]));
            for (const x of scripts) {
                if (!live(x) || (only !== undefined && x.id !== only)) continue;
                for (const e of x.meta.every!) {
                    const st = saved.states[keyOf(x.id, e.index)];
                    if (!st) continue;
                    const nextAt = all.get(alarmOf(x.id, e.index));
                    rows.push({ ...st, scriptId: x.id, name: nameOf(x.id), index: e.index, ...(e.line ? { line: e.line } : {}), running: running.has(keyOf(x.id, e.index)), ...(nextAt ? { nextAt } : {}) });
                }
            }
            return rows;
        },
        toastAction: (s, event) => runner.toastAction(s, event),
        async onAlarm(name) {
            if (!name.startsWith(ALARM_PREFIX)) return;
            await reloaded;
            const rest = name.slice(ALARM_PREFIX.length);
            const cut = rest.lastIndexOf(":");
            const s = rest.slice(0, cut);
            const i = Number(rest.slice(cut + 1));
            if (!saved.states[keyOf(s, i)]) {
                await clearAlarm(name);
                return;
            }
            await run(s, i, "alarm");
        },
    };
    // registered at once: an alarm that wakes the service worker fires right after it starts
    alarms()?.onAlarm.addListener((a) => void api.onAlarm(a.name));
    return api;
}
