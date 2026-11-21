import { describe, it, expect } from "vitest";
import { badPackageImports, coveredMissingModule, dependantsOf, importKeys, missingImports } from "../src/shared/scriptImports";

describe("script imports", () => {
    it("reads import specifiers", () => {
        expect([...importKeys(`import { a } from "./utils";\nimport x from 'Lib.ts'; const y = await import("./dyn"); require("r")`)]).toEqual(["utils", "lib", "dyn", "r"]);
    });
    it("finds direct and transitive importers by name (case-insensitively)", () => {
        const s = [
            { id: "u", name: "My utils", code: "export const a = 1;" },
            { id: "b", name: "B", code: `import { a } from "./My utils";` },
            { id: "c", name: "C", code: `import { b } from "./b";` },
            { id: "d", name: "D", code: `import { a } from "./my utils.ts";` },
            { id: "e", name: "E", code: `const s = "from nothing";` },
        ];
        expect(dependantsOf("My utils", s).sort()).toEqual(["b", "c", "d"]);
        expect(dependantsOf("C", s)).toEqual([]);
    });
});

describe("missingImports (partial import/export)", () => {
    const s = [
        { name: "My utils", code: "export const a = 1;" },
        { name: "lib2", code: `import { a } from "./My utils";` },
        { name: "App", code: `import { b } from "./lib2";` },
        { name: "Other", code: "" },
    ];
    it("lists unpicked libraries a pick needs, transitively", () => {
        expect(missingImports([2], s)).toEqual([0, 1]);
        expect(missingImports([2, 1], s)).toEqual([0]);
        expect(missingImports([0, 1, 2], s)).toEqual([]);
        expect(missingImports([3], s)).toEqual([]);
    });
});

describe("badPackageImports", () => {
    it("marks a URL import on the specifier (the built-ins' esm.sh URLs and bare imports aside) and covers TypeScript's missing-module error on it", () => {
        const url = "https://unpkg.com/dayjs@1.11.13";
        const code = `import d from "${url}";\nimport R from "https://esm.sh/react@18";\nimport b from "./lib";\nimport c from "dayjs";`;
        const bad = badPackageImports(code);
        expect(bad).toHaveLength(1);
        expect(code.slice(bad[0].offset, bad[0].offset + bad[0].length)).toBe(url);
        expect(bad[0].message).toBe(`cannot import "${url}": URL imports aren't supported — add the package to "dependencies" in package.json and import it by name`);
        const msg = (u: string) => `Cannot find module '${u}' or its corresponding type declarations.`;
        expect(coveredMissingModule(msg(url))).toBe(true);
        expect(coveredMissingModule(msg("dayjs"))).toBe(false);
    });
});
