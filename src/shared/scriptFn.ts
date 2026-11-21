/**
 * Turns user-script source into a callable. The script sees the TangiTweak
 * API as `tt`, plus a CommonJS-ish `require/module/exports` and a shadowed
 * `console`. `require("tangitweak")` is the file's own `tweak` (tweakApi.ts).
 */
import { scriptUrl } from "./scriptError";
import { tweakRequire } from "./tweakApi";

export type ScriptFn = (api: any, console: any, require: any, module: any, exports: any) => void;

/** `name` labels the script's stack frames (scriptError.ts) and is the file its `tweak` belongs to */
export function scriptFunction(js: string, name: string): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    return withTweak(new Function("tt", "console", "require", "module", "exports", `"use strict";\n${js}\n//# sourceURL=${scriptUrl(name)}`) as ScriptFn, name);
}

/** `fn` (file `name`'s code) with `require("tangitweak")` giving the file's `tweak` */
export function withTweak(fn: ScriptFn, name: string): ScriptFn {
    return (tt, console, require, module, exports) => fn(tt, console, tweakRequire(tt, name, require), module, exports);
}
