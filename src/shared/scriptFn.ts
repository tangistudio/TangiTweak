/**
 * Turns user-script source into a callable. The script gets a CommonJS-ish
 * `require/module/exports` and a shadowed `console`; `require("tangitweak")`
 * is the file's own `tweak`, made by the TweakHost the caller passes
 * (tweakApi.ts).
 */
import { explainRemovedTt, scriptUrl } from "./scriptError";
import { tweakRequire, type TweakHost } from "./tweakApi";

export type ScriptFn = (host: TweakHost, console: any, require: any, module: any, exports: any) => void;
/** a script's code as a function (`new Function`, or an MV3 site unit) */
export type RawScriptFn = (console: any, require: any, module: any, exports: any) => void;

/** `name` labels the script's stack frames (scriptError.ts) and is the file its `tweak` belongs to */
export function scriptFunction(js: string, name: string): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    return withTweak(new Function("console", "require", "module", "exports", `"use strict";\n${js}\n//# sourceURL=${scriptUrl(name)}`) as RawScriptFn, name);
}

/** `fn` (file `name`'s code) with `require("tangitweak")` giving the file's `tweak` from `host` */
export function withTweak(fn: RawScriptFn, name: string): ScriptFn {
    return (host, console, require, module, exports) => {
        try {
            fn(console, tweakRequire(host, name, require), module, exports);
        } catch (e) {
            throw explainRemovedTt(e);
        }
    };
}
