/**
 * TypeScript and JSX to JavaScript for user scripts, using Sucrase.
 *
 * Importing this module registers its transpiler with {@link setTranspiler}
 * (a side effect: it exports nothing). Only the contexts that start from
 * source import it: the background (`pipeline.ts`, which also transpiles the
 * code it ships to pages), the MV3 sandbox page (`sandbox.ts`) and the
 * `tangitweak/test` harness. Bundles without it (the overlay frame) run code
 * as given, so they receive JavaScript the background already transpiled
 * (`toRunnableJs` in `compile.ts`).
 *
 * - Types are stripped with the formatting preserved: blank lines and
 *   comments survive, so line numbers in errors match the source.
 * - JSX compiles with the automatic runtime from `jsxImportSource(code)`
 *   (the built-in React unless a `@jsxImportSource` pragma picks another).
 * - Code that doesn't parse as TSX (an old-style `<T>value` cast) is retried
 *   as plain TypeScript, without JSX.
 * - Modern syntax (`?.`, `??`, class fields) stays as written: Sucrase would
 *   otherwise rewrite it into helpers declared at the top of the module,
 *   which code run from its source elsewhere wouldn't have.
 * - When both attempts fail, the second attempt's error is thrown; the
 *   compiler then runs the code as written and reports the syntax error
 *   with its line (Problems view).
 *
 * @module
 */

import { transform } from "sucrase";
import { jsxImportSource } from "./builtinSpecs";
import { setTranspiler } from "./compile";
import { dlogLevel } from "./debugLog";

setTranspiler((code) => {
    try {
        return transform(code, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", jsxImportSource: jsxImportSource(code), production: true, disableESTransforms: true }).code;
    } catch {}
    try {
        return transform(code, { transforms: ["typescript", "imports"], disableESTransforms: true }).code;
    } catch (e: any) {
        // The script's error (Problems view) carries the syntax error and its line.
        dlogLevel("compile", "debug", "TS transpile failed (a syntax error — see the Problems view)");
        throw e;
    }
});
