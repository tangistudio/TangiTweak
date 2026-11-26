// tweak.every: the scheduler (alarms, state, backoff, pause, fetch gate) and the shared runner.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../src/shared/transpile";
import { compileScript } from "../src/shared/compile";
import { readInterval, runEvery, runToastAction } from "../src/shared/everyRun";
import { EVERY_BACKOFF_AFTER, EVERY_MAX_FETCHES, type EveryPeriod } from "../src/shared/every";
import type { EveryOutcome } from "../src/shared/everyRun";

vi.mock("../src/background/engine/logs", () => ({ log: () => {} }));
let gate: ((s: string, url: string) => Promise<void>) | undefined;
let connect: Record<string, string[] | undefined> = {};
vi.mock("../src/background/engine/stores", () => ({
    setBackgroundFetchGate: (fn: any) => void (gate = fn),
    connectOfScript: async (s: string) => connect[s],
}));

import { createSchedules, ALARM_PREFIX, type ScheduleRunner, type ScheduleScript } from "../src/background/engine/schedules";

const T = `import { tweak } from "tangitweak";\n`;

describe("everyRun", () => {
    it("runs a handler with ctx, reports stop, errors and the timeout without throwing", async () => {
        const { handlers: h } = compileScript(T + `tweak.every("1h", (ctx) => { if (ctx.reason === "manual") ctx.stop(); });\ntweak.every("1h", () => { throw new Error("boom"); });\ntweak.every("1h", () => new Promise(() => {}));`);
        expect(await runEvery(h, 0, { reason: "alarm" })).toMatchObject({ ok: true });
        expect(await runEvery(h, 0, { reason: "manual" })).toMatchObject({ ok: true, stopped: true });
        expect(await runEvery(h, 1, { reason: "alarm" })).toMatchObject({ ok: false, error: "boom" });
        expect(await runEvery(h, 2, { reason: "alarm" }, 20)).toMatchObject({ ok: false, error: expect.stringMatching(/longer than/) });
        expect(await runEvery(h, 9, { reason: "alarm" })).toMatchObject({ ok: false, error: expect.stringMatching(/gone/) });
    });

    it("reads interval functions; a promise or a throw is an error", () => {
        const { handlers: h } = compileScript(T + `let on = true;\ntweak.every(() => on && "2h", () => {});\ntweak.every(async () => "1h", () => {});\ntweak.every(() => { throw new Error("x"); }, () => {});\nexport const off = () => (on = false);`);
        expect(readInterval(h, 0)).toEqual({ ms: 7_200_000 });
        expect(readInterval(h, 1)).toHaveProperty("error", expect.stringMatching(/promise/));
        expect(readInterval(h, 2)).toHaveProperty("error", expect.stringMatching(/threw/));
    });

    it("runs every onToastAction handler, then throws the first failure", async () => {
        const seen: string[] = [];
        (globalThis as any).__seen = seen;
        const { handlers: h } = compileScript(T + `tweak.onToastAction(() => { throw new Error("first"); });\ntweak.onToastAction((e) => globalThis.__seen.push(e.actionId));`);
        await expect(runToastAction(h, { toastId: "t", actionId: "snooze" })).rejects.toThrow("first");
        expect(seen).toEqual(["snooze"]);
    });
});

describe("schedules", () => {
    let alarmMap: Map<string, chrome.alarms.Alarm>;
    let local: Record<string, any>;
    let fire: ((a: { name: string }) => void) | undefined;
    let outcomes: EveryOutcome[];
    let periods: EveryPeriod[];
    let runs: { s: string; index: number; reason: string; lastRun?: number }[];

    const runner: ScheduleRunner = {
        reload: () => {},
        every: async (s, index, a) => (runs.push({ s, index, ...a }), outcomes.shift() ?? { ok: true, ms: 1 }),
        interval: async () => periods.shift() ?? { ms: 3_600_000 },
        toastAction: async () => {},
    };

    const script = (every: any[], o: Partial<ScheduleScript> = {}): ScheduleScript => ({ id: "s1", code: "", enabled: true, updatedAt: 1, meta: { name: "Watcher", every } as any, ...o });
    const alarm = (i = 0) => alarmMap.get(`${ALARM_PREFIX}s1:${i}`);

    beforeEach(() => {
        alarmMap = new Map();
        local = {};
        outcomes = [];
        periods = [];
        runs = [];
        connect = {};
        vi.stubGlobal("chrome", {
            runtime: {},
            storage: { local: { get: (_k: any, cb: any) => cb(structuredClone(local)), set: (o: any, cb: any) => (Object.assign(local, structuredClone(o)), cb?.()) } },
            alarms: {
                create: (name: string, o: any) => alarmMap.set(name, { name, scheduledTime: o.when, periodInMinutes: o.periodInMinutes }),
                get: (name: string, cb: any) => cb(alarmMap.get(name)),
                getAll: (cb: any) => cb([...alarmMap.values()]),
                clear: (name: string, cb: any) => (alarmMap.delete(name), cb?.(true)),
                onAlarm: { addListener: (fn: any) => void (fire = fn) },
            },
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("arms one alarm per schedule, first due after one period, and clears it when the tweak goes off", async () => {
        const sc = createSchedules(runner);
        const t0 = Date.now();
        await sc.reload([script([{ index: 0, periodMs: 900_000 }])], {});
        expect(alarm()).toMatchObject({ periodInMinutes: 15 });
        expect(alarm()!.scheduledTime).toBeGreaterThanOrEqual(t0 + 900_000);
        await sc.reload([script([{ index: 0, periodMs: 900_000 }], { enabled: false })], {});
        expect(alarm()).toBeUndefined();
        expect(local.ttSchedules.states).toEqual({});
    });

    it("an alarm runs the handler and records the run; ctx.stop holds it until a save", async () => {
        const sc = createSchedules(runner);
        await sc.reload([script([{ index: 0, periodMs: 900_000 }])], {});
        outcomes.push({ ok: true, stopped: true, ms: 3 });
        fire!({ name: `${ALARM_PREFIX}s1:0` });
        await vi.waitFor(() => expect(local.ttSchedules.states["s1:0"]).toMatchObject({ stopped: true, failures: 0, lastRun: expect.any(Number) }));
        expect(runs[0]).toMatchObject({ reason: "alarm" });
        expect(alarm()).toBeUndefined();
        await sc.reload([script([{ index: 0, periodMs: 900_000 }], { updatedAt: 2 })], {});
        expect(local.ttSchedules.states["s1:0"].stopped).toBeUndefined();
        expect(alarm()).toBeDefined();
    });

    it("backs off after repeated failures and returns to the period after a success", async () => {
        const sc = createSchedules(runner);
        await sc.reload([script([{ index: 0, periodMs: 60_000 }])], {});
        for (let i = 0; i < EVERY_BACKOFF_AFTER + 1; i++) {
            outcomes.push({ ok: false, error: "down", ms: 1 });
            await sc.onAlarm(`${ALARM_PREFIX}s1:0`);
        }
        expect(local.ttSchedules.states["s1:0"]).toMatchObject({ failures: EVERY_BACKOFF_AFTER + 1, lastError: "down" });
        expect(alarm()!.periodInMinutes).toBeGreaterThan(1);
        await sc.onAlarm(`${ALARM_PREFIX}s1:0`);
        expect(alarm()!.periodInMinutes).toBe(1);
    });

    it("the user's pause wins; Run now still runs; pause all clears every alarm", async () => {
        const sc = createSchedules(runner);
        await sc.reload([script([{ index: 0, periodMs: 900_000 }, { index: 1, periodMs: 900_000 }])], {});
        await sc.setPaused("s1", 0, true);
        expect(alarm(0)).toBeUndefined();
        await sc.onAlarm(`${ALARM_PREFIX}s1:0`);
        expect(runs).toHaveLength(0);
        await expect(sc.runNow("s1", 0)).resolves.toMatchObject({ ok: true });
        expect(runs[0].reason).toBe("manual");
        await sc.setPauseAll(true);
        expect(alarm(1)).toBeUndefined();
        expect(await sc.pausedAll()).toBe(true);
        expect((await sc.list("s1")).map((r) => r.off)).toEqual(["all polling is paused", "all polling is paused"]);
        await sc.setPauseAll(false);
        expect(alarm(1)).toBeDefined();
        expect(alarm(0)).toBeUndefined();
    });

    it("an interval function sets the period and is read again when a store changes", async () => {
        const sc = createSchedules(runner);
        periods.push({ ms: 7_200_000 });
        await sc.reload([script([{ index: 0, dynamic: true }])], {});
        expect(alarm()!.periodInMinutes).toBe(120);
        periods.push({ off: true });
        sc.storeChanged("s1");
        await vi.waitFor(() => expect(alarm()).toBeUndefined());
        expect((await sc.list())[0].off).toMatch(/interval returned false/);
    });

    it("runs a schedule the browser lost once on startup when it's overdue", async () => {
        local.ttSchedules = { states: { "s1:0": { rev: 1, failures: 0, lastRun: Date.now() - 2 * 900_000, periodMs: 900_000 } } };
        const sc = createSchedules(runner);
        await sc.reload([script([{ index: 0, periodMs: 900_000 }])], {});
        await vi.waitFor(() => expect(runs).toMatchObject([{ reason: "startup", lastRun: expect.any(Number) }]));
    });

    it("gates tweak.fetch during a run: connect hosts for packages, a count limit for all", async () => {
        let release!: () => void;
        const slow: ScheduleRunner = { ...runner, every: () => new Promise((r) => (release = () => r({ ok: true, ms: 1 }))) };
        const sc = createSchedules(slow);
        await sc.reload([script([{ index: 0, periodMs: 900_000 }])], {});
        await expect(gate!("s1", "https://anywhere.example/")).resolves.toBeUndefined();
        const p = sc.runNow("s1", 0);
        await vi.waitFor(() => expect(release).toBeDefined());
        connect.s1 = ["api.example.com"];
        await expect(gate!("s1", "https://api.example.com/x")).resolves.toBeUndefined();
        await expect(gate!("s1", "https://evil.example/")).rejects.toThrow(/tangitweak.connect/);
        for (let i = 2; i < EVERY_MAX_FETCHES; i++) await gate!("s1", "https://api.example.com/x");
        await expect(gate!("s1", "https://api.example.com/x")).rejects.toThrow(/at most/);
        release();
        await p;
    });
});
