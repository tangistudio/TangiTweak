/** a tweak bundle's package.json (its "tangitweak" block and standard fields; scripts have no metadata of their own) */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { fileExtension } from "../src/shared/scriptName";
import { compareVersions, highestVersion, isBundlePackageJson, minTangiTweakOf, minTangiTweakProblem, parseManifest, rangeMinimum } from "../src/shared/packageMetadata";
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

const pkg = (o: object) => JSON.stringify(o);

describe("package metadata", () => {
    it("parses a bundle's package.json: the tangitweak block and the standard fields", () => {
        const m = parseManifest(
            pkg({
                name: "kit",
                version: "2.0.0",
                description: "A kit",
                author: { name: "Ana" },
                license: "MIT",
                homepage: "https://x.dev",
                tangitweak: { displayName: "Kit", icon: "./icon.svg", connect: ["X.com"], updateURL: "https://x.dev/kit.zip" },
                dependencies: { tangitweak: "^0.40.0-alpha", dayjs: "^1.11.0", events: "npm:events@^3" },
            })
        );
        expect(m).toEqual({
            name: "Kit",
            packageName: "kit",
            version: "2.0.0",
            description: "A kit",
            author: "Ana",
            license: "MIT",
            homepage: "https://x.dev",
            icon: "./icon.svg",
            updateURL: "https://x.dev/kit.zip",
            connect: ["x.com"],
            minTangiTweakVersion: "0.40.0-alpha",
            dependencies: { tangitweak: "^0.40.0-alpha", dayjs: "^1.11.0", events: "npm:events@^3" },
            scripts: ["index.ts"],
        });
        // the npm name when there's no displayName; `main` names the entry
        const n = parseManifest(pkg({ name: "dark", main: "./src/main.tsx", tangitweak: {} }));
        expect(n.name).toBe("dark");
        expect(n.main).toBe("src/main.tsx");
        expect(n.scripts).toEqual(["src/main.tsx"]);
        expect(isBundlePackageJson(pkg({ name: "x", tangitweak: {} }))).toBe(true);
        expect(isBundlePackageJson(pkg({ name: "x" }))).toBe(false);
        expect(isBundlePackageJson("{")).toBe(false);
    });
    it("resolves bundle icons from relative .svg/.png files, inline <svg>, and URLs; a script outside a bundle has none", () => {
        const pngUrl = "data:image/png;base64,AAAA";
        const scripts = [
            { id: "s1", meta: { name: "kit/index" } },
            { id: "s2", meta: { name: "solo" } },
            { id: "s3", meta: { name: "app/entry" } },
            { id: "s4", meta: { name: "inline/index" } },
        ];
        const dataFiles = [
            { path: "kit/package.json", text: pkg({ name: "kit", tangitweak: { icon: "badge.svg" } }) },
            { path: "kit/badge.svg", text: '<svg viewBox="0 0 8 8"><circle r="4"/></svg>' },
            { path: "app/package.json", text: pkg({ name: "app", main: "entry.ts", tangitweak: { icon: "./logo.png" } }) },
            { path: "app/logo.png", text: pngUrl },
            { path: "inline/package.json", text: pkg({ name: "inline", tangitweak: { icon: '<svg xmlns="http://www.w3.org/2000/svg"/>' } }) },
        ];
        const { scriptIcons, folderIcons } = resolveWorkspaceIcons(scripts, dataFiles);
        expect(folderIcons.get("kit")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        expect(scriptIcons.get("s1")).toBe(folderIcons.get("kit"));
        expect(scriptIcons.has("s2")).toBe(false);
        expect(scriptIcons.get("s3")).toBe(pngUrl);
        expect(folderIcons.get("app")).toBe(pngUrl);
        expect(scriptIcons.get("s4")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    });
    it("rejects a wrong package.json", () => {
        expect(() => parseManifest("{")).toThrow(/valid JSON/);
        expect(() => parseManifest(`{"name":"x"}`)).toThrow(/no "tangitweak" block/);
        expect(() => parseManifest(pkg({ main: "data.json", tangitweak: {} }))).toThrow(/data\.json/);
        expect(() => parseManifest(pkg({ main: "../a.ts", tangitweak: {} }))).toThrow(/bundle's folder/);
        expect(() => parseManifest(pkg({ tangitweak: { displayName: 3 } }))).toThrow(/"tangitweak.displayName" must be a string/);
        expect(() => parseManifest(pkg({ tangitweak: {}, dependencies: [] }))).toThrow(/"dependencies" must be an object/);
        expect(() => parseManifest(pkg({ tangitweak: { updateURL: "https://x.dev/a.js" } }))).toThrow(/"tangitweak.updateURL" — the URL must end in/);
    });
    it("compares versions", () => {
        expect(compareVersions("1.10.0", "1.9")).toBe(1);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(compareVersions(undefined, "0.1")).toBe(-1);
    });
    it("takes the minimum TangiTweak version from dependencies.tangitweak, and checks it numerically, ignoring prerelease tags", () => {
        expect(rangeMinimum("^0.40.0-alpha")).toBe("0.40.0-alpha");
        expect(rangeMinimum(">=0.41.2 <1")).toBe("0.41.2");
        expect(rangeMinimum("~1.2")).toBe("1.2");
        expect(rangeMinimum("file:../sdk")).toBeUndefined();
        expect(minTangiTweakOf({ dependencies: { tangitweak: "^0.40.0-alpha" } })).toBe("0.40.0-alpha");
        expect(minTangiTweakOf({ dependencies: { dayjs: "^1" } })).toBeUndefined();
        expect(minTangiTweakOf({ dependencies: { tangitweak: "file:../sdk" }, tangitweak: { minTangiTweakVersion: "v0.41.0" } })).toBe("0.41.0");
        expect(() => parseManifest(pkg({ tangitweak: { minTangiTweakVersion: "latest" } }))).toThrow(/minTangiTweakVersion/);

        expect(minTangiTweakProblem("0.40.0-alpha", "0.40.0")).toBeNull();
        expect(minTangiTweakProblem("0.40.0", "0.40.0-alpha")).toBeNull();
        expect(minTangiTweakProblem("0.33.0", "0.35.0-alpha")).toBeNull();
        expect(minTangiTweakProblem("0.36.0", "0.35.0-alpha")).toBe("Requires TangiTweak 0.36.0 or newer (you have 0.35.0-alpha).");
        expect(minTangiTweakProblem("0.10.0", "0.9.5")).toMatch(/Requires TangiTweak 0\.10\.0/);
        expect(highestVersion(["0.32.0", undefined, "0.36.1", "0.35.0"])).toBe("0.36.1");
    });
});
