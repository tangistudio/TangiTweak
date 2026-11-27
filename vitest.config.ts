import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

// unit tests exercise the MV2 code paths: inject the build flag the
// rolldown build would provide (transform.define)
export default defineConfig({
    define: {
        __MV3__: "false",
        __FIREFOX__: "false",
        __NO_EVAL__: "false",
        __COMMIT__: JSON.stringify("test"),
        __BUILD_TIME__: JSON.stringify("1970-01-01T00:00:00.000Z"),
    },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
    // what a tweak bundle's tests import (the SDK package, stage 6 of the plan)
    resolve: {
        alias: [
            { find: /^tangitweak\/test$/, replacement: src("testing/test.ts") },
            { find: /^tangitweak$/, replacement: src("testing/standalone.ts") },
        ],
    },
    test: {
        setupFiles: ["test/setup.ts"],
        // UI component tests (*.test.tsx) need a DOM
        // (tweak bundles' own tests under test/fixtures choose theirs, as in a bundle)
        environmentMatchGlobs: [["test/!(fixtures)/**/*.test.tsx", "happy-dom"], ["test/*.test.tsx", "happy-dom"]],
    },
});
