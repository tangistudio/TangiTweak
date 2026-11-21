/** metadata.json (a bundle's package metadata; scripts have none of their own) */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { fileExtension } from "../src/shared/scriptName";
import { compareVersions, highestVersion, minTangiTweakProblem, parseManifest } from "../src/shared/packageMetadata";
import { resolveWorkspaceIcons } from "../src/shared/packageModel";

const SCRIPT = `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://example.com/*", strategy: "extension" }, () => {});`;

describe("file names", () => {
    it("keeps the whole extension unselected on rename", () => {
        expect(fileExtension("a/x.tangitweak.ts")).toBe(".tangitweak.ts");
        expect(fileExtension("x.tangitweak.tsx")).toBe(".tangitweak.tsx");
        expect(fileExtension("x.ts")).toBe(".ts");
        expect(fileExtension("d.json")).toBe(".json");
        expect(fileExtension("README")).toBe("");
    });
});

describe("compiling", () => {
    it("runs any script that registers handlers", () => {
        for (const name of ["x", "x.tangitweak", "dir/lib"]) expect(compileWithLibs({ id: "a", name, code: SCRIPT }, []).meta.active).toBe(true);
    });
    it("a script has no metadata of its own: tweak.metadata is gone", () => {
        const c = compileWithLibs({ id: "a", name: "x.tangitweak", code: `import { tweak } from "tangitweak"; tweak.metadata({ name: "Dark", version: "1.2.0" });\n${SCRIPT}` }, []);
        expect(c.error).toMatch(/tweak\.metadata is not a function/);
        expect((compileWithLibs({ id: "a", name: "x.tangitweak", code: SCRIPT }, []).meta as { metadata?: unknown }).metadata).toBeUndefined();
    });
});

describe("package metadata", () => {
    it("parses a bundle's metadata.json", () => {
        const m = parseManifest(JSON.stringify({ name: "Kit", version: "2.0.0", icon: "./icon.svg", connect: ["X.com"], scripts: ["./a.ts", "sub/b.tangitweak.tsx"] }));
        expect(m).toEqual({ name: "Kit", version: "2.0.0", icon: "./icon.svg", connect: ["x.com"], scripts: ["a.ts", "sub/b.tangitweak.tsx"] });
        expect(parseManifest(JSON.stringify({ updateURL: "https://x.dev/kit.zip", scripts: ["a.ts"] })).updateURL).toBe("https://x.dev/kit.zip");
        expect(() => parseManifest(JSON.stringify({ updateURL: "https://x.dev/a.js", scripts: ["a.ts"] }))).toThrow(/"updateURL" — the URL must end in/);
    });
    it("resolves bundle icons from relative .svg/.png files, inline <svg>, and URLs; a script outside a bundle has none", () => {
        const pngUrl = "data:image/png;base64,AAAA";
        const scripts = [
            { id: "s1", meta: { name: "kit/main" } },
            { id: "s2", meta: { name: "solo" } },
            { id: "s3", meta: { name: "app/entry" } },
            { id: "s4", meta: { name: "inline/x" } },
        ];
        const dataFiles = [
            { path: "kit/metadata.json", text: JSON.stringify({ name: "Kit", icon: "badge.svg", scripts: ["main.ts"] }) },
            { path: "kit/badge.svg", text: '<svg viewBox="0 0 8 8"><circle r="4"/></svg>' },
            { path: "app/metadata.json", text: JSON.stringify({ name: "App", icon: "./logo.png", scripts: ["entry.ts"] }) },
            { path: "app/logo.png", text: pngUrl },
            { path: "inline/metadata.json", text: JSON.stringify({ name: "Inline", icon: '<svg xmlns="http://www.w3.org/2000/svg"/>', scripts: ["x.ts"] }) },
        ];
        const { scriptIcons, folderIcons } = resolveWorkspaceIcons(scripts, dataFiles);
        expect(folderIcons.get("kit")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        expect(scriptIcons.get("s1")).toBe(folderIcons.get("kit"));
        expect(scriptIcons.has("s2")).toBe(false);
        expect(scriptIcons.get("s3")).toBe(pngUrl);
        expect(folderIcons.get("app")).toBe(pngUrl);
        expect(scriptIcons.get("s4")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    });
    it("rejects a wrong metadata.json", () => {
        expect(() => parseManifest("{")).toThrow(/valid JSON/);
        expect(() => parseManifest(`{"name":"x"}`)).toThrow(/scripts/);
        expect(() => parseManifest(`{"scripts":["data.json"]}`)).toThrow(/data\.json/);
        expect(() => parseManifest(`{"scripts":["../a.tangitweak.ts"]}`)).toThrow(/bundle's folder/);
        expect(() => parseManifest(`{"name":3,"scripts":["a.tangitweak.ts"]}`)).toThrow(/"name" must be a string/);
    });
    it("compares versions", () => {
        expect(compareVersions("1.10.0", "1.9")).toBe(1);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(compareVersions(undefined, "0.1")).toBe(-1);
    });
    it("validates and checks metadata.json's minTangiTweakVersion", () => {
        const m = parseManifest(JSON.stringify({ name: "Kit", minTangiTweakVersion: "v0.35.0", scripts: ["a.ts"] }));
        expect(m.minTangiTweakVersion).toBe("0.35.0");
        expect(() => parseManifest(JSON.stringify({ minTangiTweakVersion: "latest", scripts: ["a.ts"] }))).toThrow(/minTangiTweakVersion/);

        expect(minTangiTweakProblem("0.35.0", "0.35.0-alpha")).toBeNull();
        expect(minTangiTweakProblem("0.33.0", "0.35.0-alpha")).toBeNull();
        expect(minTangiTweakProblem("0.36.0", "0.35.0-alpha")).toBe("Requires TangiTweak 0.36.0 or newer (you have 0.35.0-alpha).");
        expect(highestVersion(["0.32.0", undefined, "0.36.1", "0.35.0"])).toBe("0.36.1");
    });
});
