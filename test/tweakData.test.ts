import { describe, expect, it } from "vitest";
import { dataFileTarget, dataFolderName, dataFolderProblem, nonDefaultParams, parseStoreFile, planTweakSettings, renderTweakSettings } from "../src/shared/tweakData";
import type { ParamTree } from "../src/shared/scriptDef";

const DEFS: ParamTree = {
    enabled: { type: "boolean", default: true },
    host: { type: "string", default: "a.com" },
    network: { retries: { type: "number", default: 3 }, env: { type: "enum", choices: ["dev", "prod"], default: "dev" } },
};

describe("a tweak's data folder", () => {
    it("the folder name is one safe segment", () => {
        expect(dataFolderProblem(".tweak")).toBeNull();
        expect(dataFolderProblem("data_1")).toBeNull();
        for (const bad of ["", "a/b", "a\\b", ".", "..", "node_modules", "NODE_MODULES", "a b", "é", ".git", ".tangitweak", 7]) expect(dataFolderProblem(bad)).toBeTruthy();
        expect(dataFolderName("../x")).toBe(".tweak");
        expect(dataFolderName(".data")).toBe(".data");
    });

    it("settings.json holds the enable switch and only non-default params", () => {
        expect(JSON.parse(renderTweakSettings(true, DEFS, {}))).toEqual({ enabled: true });
        const text = renderTweakSettings(false, DEFS, { host: "a.com", network: { retries: 3, env: "prod" } });
        expect(JSON.parse(text)).toEqual({ enabled: false, params: { network: { env: "prod" } } });
        expect(nonDefaultParams(DEFS, { enabled: false, host: "b.com" })).toEqual({ host: "b.com" });
    });

    it("planning a settings.json: omitted params go back to defaults; anything invalid throws", () => {
        const cur = { enabled: false, defs: DEFS, values: { host: "b.com", network: { retries: 9 } } };
        expect(planTweakSettings("{}", cur)).toEqual({ enabled: true, params: { host: "a.com", "network.retries": 3 } });
        expect(planTweakSettings(JSON.stringify({ enabled: false, params: { host: "b.com", network: { retries: 9 } } }), cur)).toEqual({ params: {} });
        expect(() => planTweakSettings("{bad", cur)).toThrow(/invalid JSON/);
        expect(() => planTweakSettings(JSON.stringify({ enabled: "yes" }), cur)).toThrow(/enabled/);
        expect(() => planTweakSettings(JSON.stringify({ params: { nope: 1 } }), cur)).toThrow(/no "nope"/);
        expect(() => planTweakSettings(JSON.stringify({ params: { network: { env: "qa" } } }), cur)).toThrow(/network\.env/);
        expect(() => planTweakSettings(JSON.stringify({ scripts: {} }), cur)).toThrow(/unknown key/);
    });

    it("settings.json holds the layer choice", () => {
        expect(JSON.parse(renderTweakSettings(true, undefined, undefined, "base"))).toEqual({ enabled: true, layer: "base" });
        const cur = { enabled: true, layer: "base" as const };
        expect(planTweakSettings(JSON.stringify({ enabled: true, layer: "base" }), cur)).toEqual({ params: {} });
        expect(planTweakSettings(JSON.stringify({ enabled: true, layer: "override" }), cur)).toEqual({ params: {}, layer: "override" });
        expect(planTweakSettings(JSON.stringify({ enabled: true }), cur)).toEqual({ params: {}, layer: null });
        expect(() => planTweakSettings(JSON.stringify({ layer: "top" }), cur)).toThrow(/layer/);
    });

    it("maps paths to a bundle's settings.json or a store file per ID", () => {
        const roots = ["", "mock/", "mock/inner/"];
        expect(dataFileTarget("mock/.tweak/settings.json", ".tweak", roots)).toEqual({ root: "mock/", settings: true });
        expect(dataFileTarget("mock/inner/.tweak/stores/cart.json", ".tweak", roots)).toEqual({ root: "mock/inner/", store: "cart" });
        expect(dataFileTarget(".tweak/stores/a.b.json", ".tweak", roots)).toEqual({ root: "", store: "a.b" });
        expect(dataFileTarget("mock/.tweak/stores/Bad.json", ".tweak", roots)).toMatchObject({ error: expect.stringMatching(/store ID/) });
        expect(dataFileTarget("mock/.tweak/notes.md", ".tweak", roots)).toMatchObject({ error: expect.any(String) });
        expect(dataFileTarget("mock/.data/settings.json", ".tweak", roots)).toBeNull();
        expect(dataFileTarget("other/.tweak/settings.json", ".tweak", ["mock/"])).toBeNull();
    });

    it("a store file is a JSON object of storable values", () => {
        expect(parseStoreFile('{"n":1,"list":[1,"a"]}')).toEqual({ n: 1, list: [1, "a"] });
        expect(() => parseStoreFile("[1]")).toThrow(/JSON object/);
        expect(() => parseStoreFile("{x")).toThrow(/invalid JSON/);
    });
});
