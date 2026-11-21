/**
 * The globals a script and the packages it loads see, when something other
 * than the realm's own globals should answer them. The extension never sets
 * one: a script sees its world's real globals. The test loader
 * (src/testing) sets one per tab and world, so each copy of a tweak gets its
 * own `window`, `document` and `location`, and none of Node's globals
 * (`Buffer`, `process`, …) — as in the browser.
 */
export interface ScriptScope {
    /**
     * the code's global lookups, before the realm's: compiled code runs
     * inside `with (vars)`, so a name `vars` has (`in`) is read and written
     * there — a polyfill's `globalThis.Buffer = …` is then seen as `Buffer`
     */
    vars: object;
    /** names this scope's package cache (tabs and worlds don't share package instances) */
    key: string;
    /** a package's `global` */
    global?: object;
}

let provider: (() => ScriptScope | undefined) | undefined;

export function setScriptScopeProvider(fn: (() => ScriptScope | undefined) | undefined): void {
    provider = fn;
}

/** the scope code compiled now runs in (none: the realm's globals) */
export function scriptScope(): ScriptScope | undefined {
    return provider?.();
}
