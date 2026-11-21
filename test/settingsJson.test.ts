import { describe, expect, it } from "vitest";
import { DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, parseSettings, planSettings, renderSettings, type GlobalSettings } from "../src/shared/settingsJson";

const G: GlobalSettings = { logLevel: DEFAULT_LOG_LEVEL, logCap: DEFAULT_LOG_CAP };

describe("settings.json", () => {
    it("renders {} when all globals are at their defaults", () => {
        expect(renderSettings({ ...G, dataFolder: ".tweak" })).toBe("{}\n");
    });

    it("renders only non-default globals", () => {
        const text = renderSettings({ logLevel: "debug", logCap: 500, bodyCap: 4096, dataFolder: ".data" });
        expect(JSON.parse(text)).toEqual({ logLevel: "debug", bodyCap: 4096, dataFolder: ".data" });
    });

    it("full-file plan resets omitted globals back to defaults", () => {
        const plan = planSettings(parseSettings("{}"), { logLevel: "debug", logCap: 1000, bodyCap: 4096, dataFolder: ".data" });
        expect(plan).toEqual({ logLevel: "info", logCap: 500, bodyCap: 2048, dataFolder: ".tweak" });
    });

    it("skips an invalid dataFolder and ignores the old scripts key", () => {
        for (const bad of ["a/b", "..", "node_modules", "", "a b"]) expect(planSettings(parseSettings(JSON.stringify({ dataFolder: bad })), G)).toEqual({});
        expect(parseSettings(JSON.stringify({ scripts: { "A.ts": { enabled: false } } }))).toEqual({ globals: {} });
    });

    it("rejects non-object JSON roots and invalid JSON syntax", () => {
        expect(() => parseSettings("{bad")).toThrow(/invalid JSON/);
        expect(() => parseSettings("[]")).toThrow(/JSON object/);
        expect(() => parseSettings("123")).toThrow(/JSON object/);
    });
});
