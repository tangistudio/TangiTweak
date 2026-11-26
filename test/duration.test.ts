// Durations tweaks write for tweak.every and tweak.toast ("30s", "1h30m", ms).
import { describe, it, expect } from "vitest";
import { formatDuration, parseDuration } from "../src/shared/duration";

describe("parseDuration", () => {
    it("reads numbers and unit text", () => {
        expect(parseDuration(1500)).toBe(1500);
        expect(parseDuration("30s")).toBe(30_000);
        expect(parseDuration("5m")).toBe(300_000);
        expect(parseDuration("1h")).toBe(3_600_000);
        expect(parseDuration("1d")).toBe(86_400_000);
        expect(parseDuration("1h30m")).toBe(5_400_000);
        expect(parseDuration("1h 30m")).toBe(5_400_000);
        expect(parseDuration("1.5h")).toBe(5_400_000);
        expect(parseDuration("250ms")).toBe(250);
    });

    it("rejects what isn't a positive duration", () => {
        for (const bad of ["1x", "", "-1h", "0m", "h", "30m1h", "1h1h", 0, -5, NaN, Infinity, null, {}]) expect(() => parseDuration(bad, "tweak.every")).toThrow(/tweak\.every/);
    });
});

describe("formatDuration", () => {
    it("writes the largest units first", () => {
        expect(formatDuration(90_000)).toBe("1m30s");
        expect(formatDuration(86_400_000 + 3_600_000)).toBe("1d1h");
        expect(formatDuration(400)).toBe("400ms");
    });
});
