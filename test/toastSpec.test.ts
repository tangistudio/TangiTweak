import { describe, expect, it } from "vitest";
import { mergeToastStyle, normalizeToast, normalizeToastStyle, TOAST_MAX_TTL_MS } from "../src/shared/toast";

describe("normalizeToast", () => {
    it("fills defaults from a plain message", () => {
        const t = normalizeToast("Price dropped");
        expect(t).toMatchObject({ message: "Price dropped", kind: "info", duration: 6000, where: "active", ttl: 3_600_000, attention: "tab" });
        expect(t.id).toBeTruthy();
    });
    it("keeps errors sticky and parses durations", () => {
        expect(normalizeToast({ title: "x", kind: "error" }).duration).toBe("sticky");
        expect(normalizeToast({ title: "x", duration: "10s", ttl: "1d" })).toMatchObject({ duration: 10_000, ttl: 86_400_000 });
        expect(normalizeToast({ title: "x", ttl: "30d" }).ttl).toBe(TOAST_MAX_TTL_MS);
    });
    it("rejects bad options", () => {
        expect(() => normalizeToast({})).toThrow(/title, a message or a pane/);
        expect(() => normalizeToast({ title: "x", url: "javascript:alert(1)" })).toThrow(/http/);
        expect(() => normalizeToast({ title: "x", actions: ["a", "b", "c"] })).toThrow(/at most 2/);
        expect(() => normalizeToast({ title: "x", actions: ["close"] })).toThrow(/taken/);
        expect(() => normalizeToast({ title: "x", ttl: "1x" })).toThrow(/ttl/);
        expect(() => normalizeToast({ title: "x", data: { s: "a".repeat(40_000) } })).toThrow(/KB/);
    });
    it("maps string actions to id and label", () => {
        expect(normalizeToast({ title: "x", actions: ["Open", { id: "snooze", label: "Later" }] }).actions).toEqual([
            { id: "Open", label: "Open" },
            { id: "snooze", label: "Later" },
        ]);
    });
});

describe("toast styles", () => {
    it("checks keys and values", () => {
        expect(normalizeToastStyle({ accent: "#e8590c", width: 9999, position: "top-left" })).toEqual({ accent: "#e8590c", width: 480, position: "top-left" });
        expect(() => normalizeToastStyle({ colour: "red" })).toThrow(/unknown key/);
        expect(() => normalizeToastStyle({ accent: "red; x: y" })).toThrow(/one CSS value/);
        expect(() => normalizeToastStyle({ css: "@import url(x)" })).toThrow(/@import/);
    });
    it("merges with later keys winning and css adding up", () => {
        expect(mergeToastStyle({ accent: "red", css: "a{}" }, undefined, { accent: "blue", css: "b{}" })).toEqual({ accent: "blue", css: "a{}\nb{}" });
    });
});
