// tweak.every, tweak.toast and friends as compileScript collects them.
import { describe, it, expect, vi } from "vitest";
import "../src/shared/transpile";
import { compileScript } from "../src/shared/compile";
import { backoffPeriod, everyPeriod, EVERY_MAX_BACKOFF_MS } from "../src/shared/every";

const T = `import { tweak } from "tangitweak";\n`;

describe("everyPeriod", () => {
    it("reads durations, clamps short ones and treats falsy values as off", () => {
        expect(everyPeriod("5m")).toEqual({ ms: 300_000 });
        expect(everyPeriod("10s")).toEqual({ ms: 60_000, clamped: true });
        for (const v of [false, null, undefined, 0, ""]) expect(everyPeriod(v)).toEqual({ off: true });
        expect(everyPeriod("soon")).toHaveProperty("error");
    });
    it("backs off after repeated failures, up to a day", () => {
        expect(backoffPeriod(60_000, 1)).toBe(60_000);
        expect(backoffPeriod(60_000, 7)).toBeGreaterThan(60_000);
        expect(backoffPeriod(3_600_000, 40)).toBe(EVERY_MAX_BACKOFF_MS);
    });
});

describe("tweak.every in compile", () => {
    it("records schedules in meta and makes the script active", () => {
        const c = compileScript(T + `tweak.every("15m", () => {});\ntweak.every(() => "2h", () => {});\ntweak.every("20s", () => {});`);
        expect(c.error).toBeNull();
        expect(c.handlers.every).toHaveLength(3);
        expect(c.meta.every?.map(({ line: _l, ...m }) => m)).toEqual([{ index: 0, periodMs: 900_000 }, { index: 1, dynamic: true }, { index: 2, periodMs: 60_000, clamped: true }]);
        expect(c.meta.active).toBe(true);
    });
    it("rejects a bad interval literal", () => {
        expect(compileScript(T + `tweak.every("often", () => {});`).error).toMatch(/often|duration/i);
    });
    it("ignores and logs a registration after top level", async () => {
        const logSink = vi.fn();
        const c = compileScript(T + `export const later = () => tweak.every("1h", () => {});`, { logSink });
        c.exports.later();
        expect(c.handlers.every).toHaveLength(0);
        expect(logSink).toHaveBeenCalledWith("error", "tweak.every", expect.stringMatching(/after the script's top level/));
    });
});

describe("toast registrations in compile", () => {
    it("merges toastStyle calls and notes repeated keys", () => {
        const c = compileScript(T + `tweak.toastStyle({ accent: "#f80", radius: 4 });\ntweak.toastStyle({ accent: "#08f" });\ntweak.onToastAction(() => {});\ntweak.toastPane("price", () => null);`);
        expect(c.error).toBeNull();
        expect(c.meta.toast).toMatchObject({ actions: true, panes: ["price"], style: { accent: "#08f", radius: 4 }, repeated: ["accent"] });
    });
    it("refuses two panes with one name", () => {
        expect(compileScript(T + `tweak.toastPane("a", () => null);\ntweak.toastPane("a", () => null);`).error).toMatch(/already registered/);
    });
    it("rejects tweak.toast at top level and where no context can show one", async () => {
        const top = compileScript(T + `export const p = tweak.toast({ title: "hi" }); p.catch(() => {});`);
        await expect(top.exports.p).rejects.toThrow(/top level/);
        const c = compileScript(T + `export const show = () => tweak.toast({ title: "hi" });`);
        await expect(c.exports.show()).rejects.toThrow(/isn't available/);
    });
    it("passes the checked toast to the context's override", async () => {
        const toast = vi.fn(async (s: any) => ({ id: s.id, status: "shown" as const }));
        const c = compileScript(T + `export const show = () => tweak.toast({ id: "x", title: "hi", ttl: "1d" });`, { toast });
        await expect(c.exports.show()).resolves.toEqual({ id: "x", status: "shown" });
        expect(toast.mock.calls[0][0]).toMatchObject({ id: "x", title: "hi", ttl: 86_400_000, kind: "info", where: "active" });
    });
});
