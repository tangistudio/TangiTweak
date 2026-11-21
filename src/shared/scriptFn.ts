/**
 * Turns user-script source into a callable. The script gets a CommonJS-ish
 * `require/module/exports` and a shadowed `console`; `require("tangitweak")`
 * is the file's own `tweak`, made by the TweakHost the caller passes
 * (tweakApi.ts).
 */
import { explainRemovedTt, scriptUrl } from "./scriptError";
import { scriptScope } from "./scriptScope";
import { tweakRequire, type TweakHost } from "./tweakApi";

export type ScriptFn = (host: TweakHost, console: any, require: any, module: any, exports: any) => void;
/** a script's code as a function (`new Function`, or an MV3 site unit) */
export type RawScriptFn = (console: any, require: any, module: any, exports: any) => void;

/** `name` labels the script's stack frames (scriptError.ts) and is the file its `tweak` belongs to */
export function scriptFunction(js: string, name: string): ScriptFn {
    const tail = `\n${js}\n//# sourceURL=${scriptUrl(name)}`;
    const scope = scriptScope();
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    if (!scope) return withTweak(new Function("console", "require", "module", "exports", `"use strict";${tail}`) as RawScriptFn, name);
    // `with` is sloppy-mode only: it wraps the strict function, which can still redeclare a global (`const document = …`)
    const outer = new Function("__ttScope", `with (__ttScope) return function (console, require, module, exports) {"use strict";${tail}\n}`);
    return withTweak(outer(scope.vars) as RawScriptFn, name);
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
