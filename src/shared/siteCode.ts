/**
 * Chrome MV3: how onSite code reaches the page's world. It comes as
 * `chrome.userScripts` registrations (world MAIN, `tt-main-<scriptId>`,
 * `background/userScripts.ts`), not as strings the hook evaluates: the
 * Chrome Web Store allows running code that isn't in the package only
 * through the userScripts and debugger APIs, so the MV3 hook is built
 * without `eval` (`__NO_EVAL__`).
 *
 * Each unit (a script, a library script it imports, a package module) is its
 * own source, built in the background ({@link scriptUnit},
 * {@link packageUnit}): a function expression pushed onto a queue on the
 * page's global (`Symbol.for(SITE_QUEUE)`), which the hook drains and then
 * replaces ({@link siteUnits}; either may run first). The hook finds a unit
 * by the key the page bundle names (`fk`): its name and a hash of its code
 * ({@link siteKey}), so a unit from an older save is never taken for a newer
 * one.
 *
 * A registration only reaches documents that load after it. A page whose
 * bundle names units it doesn't have (a save while it was open, a page back
 * from the back/forward cache) asks for them ({@link unitsGate}) and the
 * background runs them in that document (`userScripts.execute`, Chrome 135+).
 *
 * @module
 */

import { contentHash } from "./folderSync";
import { scriptUrl } from "./scriptError";

/**
 * The `Symbol.for` key of the page global that holds the units: an array
 * that units push `[key, function]` pairs onto until the hook replaces it
 * with its own queue.
 */
export const SITE_QUEUE = "tangitweak.site";

/**
 * A package module's function: runs with `this` = `module.exports`, in sloppy
 * mode, like a CommonJS module wrapper. Its last parameter injects the
 * module's CSS (`__ttStyle` in its code).
 */
export type PackageFn = (
    require: (spec: string) => any,
    module: {
        /** What the module exports; it may replace the object. */
        exports: any;
    },
    exports: any,
    process: any,
    global: any,
    style: (css: string, url: string) => void
) => void;

const hashes = new Map<string, string>();
/**
 * A unit's key: its name and a hash of its code, joined by a NUL character.
 * Hashes are cached by code (the cache is cleared past 500 entries).
 *
 * @param name - The script's or library's name or a package module's final URL.
 * @param js - The unit's runnable JavaScript (before {@link scriptUnit} wraps it).
 */
export function siteKey(name: string, js: string): string {
    let h = hashes.get(js);
    if (h === undefined) {
        if (hashes.size > 500) hashes.clear();
        hashes.set(js, (h = contentHash(js)));
    }
    return `${name}\0${h}`;
}

const push = (key: string, params: string) => `(globalThis[Symbol.for(${JSON.stringify(SITE_QUEUE)})] ||= []).push([${JSON.stringify(key)}, function (${params}) {`;

/**
 * A script's or library script's unit: the source of one MAIN-world user
 * script that pushes its function (strict mode; parameters `console`,
 * `require`, `module`, `exports`) under its {@link siteKey}. The user's line 1
 * is line 4, as in `scriptFunction` (`EVAL_WRAPPER_LINES`) and its
 * `sourceURL` is the script's, so error positions map the same way.
 *
 * @param js - The runnable JavaScript (TypeScript already compiled).
 */
export function scriptUnit(name: string, js: string): string {
    return `${push(siteKey(name, js), "console, require, module, exports")}\n\n"use strict";\n${js}\n}]);\n//# sourceURL=${scriptUrl(name)}`;
}

/**
 * A package module's unit: pushes its {@link PackageFn} under its
 * {@link siteKey}, with `sourceURL` set to `url`.
 *
 * @param url - The module's final URL (its name).
 */
export function packageUnit(url: string, js: string): string {
    return `${push(siteKey(url, js), "require, module, exports, process, global, __ttStyle")}\n${js}\n}]);\n//# sourceURL=${url}`;
}

/**
 * The hook's side: takes the units that arrived and replaces the queue on
 * `g` with one that takes those that arrive later. The first unit with a key
 * wins; malformed entries are ignored. The replacement is non-writable and
 * non-configurable, so the page can't swap it out (when defining it fails,
 * later units are missed).
 *
 * @param onUnit - Runs after each later push.
 * @param g - The page's global.
 * @returns A lookup of the units by {@link siteKey}.
 */
export function siteUnits(
    onUnit: () => void,
    g: any = globalThis
): {
    /** The function of the unit with this key (`undefined` when it hasn't arrived). */
    get(key: string): Function | undefined;
} {
    const units = new Map<string, Function>();
    const sym = Symbol.for(SITE_QUEUE);
    const take = (u: any) => {
        if (Array.isArray(u) && typeof u[0] === "string" && typeof u[1] === "function" && !units.has(u[0])) units.set(u[0], u[1]);
    };
    const early = g[sym];
    if (Array.isArray(early)) early.forEach(take);
    const queue = {
        push(...us: any[]): number {
            us.forEach(take);
            onUnit();
            return units.size;
        },
    };
    try {
        Object.defineProperty(g, sym, { value: queue, configurable: false, writable: false, enumerable: false });
    } catch {}
    return { get: (key) => units.get(key) };
}

/**
 * The hook's wait for the units a status names. A status whose units are all
 * here compiles at once. Otherwise the hook asks for the missing ones, again
 * every `retryMs` while they're missing (a delivery can fail), and compiles
 * when the last arrives, or after `waitMs` with what is here; units that
 * arrive after that compile as a hot update.
 */
export function unitsGate(o: {
    /** The keys of the units the last status names that aren't here. */
    missing: () => string[];
    /** Asks the extension to run these units in this document. */
    ask: (keys: string[]) => void;
    /** Compiles the last status's code. */
    compile: (hot: boolean) => void;
    /** The wait ran out; `compile` follows. */
    timedOut: () => void;
    /** How long to wait for the missing units, in milliseconds. */
    waitMs: number;
    /** How long after an ask to ask again, in milliseconds. */
    retryMs: number;
}): {
    /** A status arrived. */
    status(hot: boolean): void;
    /** A unit arrived. */
    unit(): void;
} {
    let wait: { hot: boolean; timer: ReturnType<typeof setTimeout>; again: ReturnType<typeof setInterval> } | null = null;
    /** the last compile ran without some of its units */
    let late = false;
    /** ends the wait; whether it was a hot update's */
    const end = (): boolean => {
        const hot = !!wait?.hot;
        if (wait) {
            clearTimeout(wait.timer);
            clearInterval(wait.again);
        }
        wait = null;
        return hot;
    };
    return {
        status(hot) {
            hot = end() || hot;
            late = false;
            const keys = o.missing();
            if (!keys.length) return o.compile(hot);
            const w = (wait = {
                hot,
                timer: setTimeout(() => {
                    if (wait !== w) return;
                    end();
                    late = true;
                    o.timedOut();
                    o.compile(hot);
                }, o.waitMs),
                again: setInterval(() => {
                    const still = o.missing();
                    if (wait === w && still.length) o.ask(still);
                }, o.retryMs),
            });
            o.ask(keys);
        },
        unit() {
            if ((!wait && !late) || o.missing().length) return;
            const hot = wait ? end() : true;
            late = false;
            o.compile(hot);
        },
    };
}
