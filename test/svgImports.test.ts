// `.svg` data files: importing one gives its markup, a string.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { bytesToImageDataUrl, dataFileValue, dependantsOf, imageDataUrlToBytes, importResolver, isDataSpec, makeLibRequire } from "../src/shared/scriptImports";
import { dataFilePathProblem } from "../src/shared/scriptName";

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const data = [{ path: "icons/logo.svg", text: LOGO }];

describe(".svg data files", () => {
    it("are data files by path (.svg, .md and raster images)", () => {
        expect(isDataSpec("./icons/Logo.SVG")).toBe(true);
        expect(isDataSpec("./README.md")).toBe(true);
        expect(isDataSpec("./icons/Logo.PNG")).toBe(true);
        expect(dataFilePathProblem("icons/logo.svg")).toBe("");
        expect(dataFilePathProblem("README.md")).toBe("");
        expect(dataFilePathProblem("icons/logo.png")).toBe("");
        expect(dataFilePathProblem("icons/.svg")).toMatch(/just \.svg/);
        expect(dataFilePathProblem(".md")).toMatch(/just \.md/);
        expect(dataFilePathProblem("icons/.png")).toMatch(/just \.png/);
        expect(dataFilePathProblem("icons/logo.txt")).toMatch(/\.json, \.md, \.svg or image/);
        expect(importResolver([], ["icons/logo.svg", "README.md", "icons/logo.png"])("ui/panel", "../README.md")).toEqual({ kind: "data", path: "README.md" });
        expect(dataFileValue("README.md", "# Title\n")).toBe("# Title\n");
        expect(dependantsOf("icons/logo.svg", [{ id: "a", name: "a", code: 'import l from "./icons/logo.svg";' }], "data")).toEqual(["a"]);
        const raw = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
        const url = bytesToImageDataUrl("icons/logo.png", raw);
        expect(url).toMatch(/^data:image\/png;base64,/);
        expect(Array.from(imageDataUrlToBytes(url))).toEqual(Array.from(raw));
        expect(dataFileValue("icons/logo.png", url)).toBe(url);
    });

    it("import as their markup (never parsed), in scripts and libraries", () => {
        expect(dataFileValue("a.svg", LOGO)).toBe(LOGO);
        const lib = { id: "l", name: "ui/icons", code: `import logo from "../icons/logo.svg";\nexport const html = logo;` };
        const main = { id: "m", name: "main", code: `import { tweak } from "tangitweak";\nimport { html } from "./ui/icons";\nimport logo from "./icons/logo.svg";\ntweak.params({ a: { type: "string", default: html }, b: { type: "string", default: logo } });` };
        const c = compileWithLibs(main, [lib], {}, data);
        expect(c.error).toBeNull();
        expect(c.paramDefs?.a.default).toBe(LOGO);
        expect(c.paramDefs?.b.default).toBe(LOGO);
        expect(c.deps).toContain("icons/logo.svg");
    });

    it("a missing one is the importer's compile error", () => {
        const c = compileWithLibs({ id: "m", name: "main", code: `import x from "./nope.svg";\nconsole.log(x);` }, [], {}, data);
        expect(c.error).toMatch(/no data file "nope\.svg"/);
    });

    it("the page-side require gives the markup too", () => {
        const requireFrom = makeLibRequire([{ name: "icons/logo.svg", json: LOGO }], () => {});
        expect(requireFrom("main")("./icons/logo.svg")).toBe(LOGO);
    });

    it("the Monaco bundle registers the xml and markdown languages for .svg and .md models", () => {
        const bundleSrc = readFileSync("src/ui/monacoBundle.ts", "utf8");
        const langs = [...bundleSrc.matchAll(/languages\/definitions\/(\w+)\/register/g)].map((m) => m[1]);
        expect(langs).toEqual(expect.arrayContaining(["typescript", "javascript", "xml", "markdown"]));
    });
});
