/**
 * Formatting for user-script log output (`tweak.log` and `console.*`), shared
 * by every context a script runs in: the background (MV3: the sandbox page),
 * the MAIN-world hook, the isolated bridge, the overlay frame and
 * `tangitweak/test`. Every line reaches the extension's LOG panel as
 * `[<script name>] <source>: <text>` ({@link scriptLogLine}), attributed to
 * the script id. Lines from GUI code also carry where they ran
 * ({@link contextTag}).
 *
 * @module
 */

/** A log line's level: `console.debug` and `console.trace` log at `"debug"`, `tweak.log` at `"info"`. */
export type ScriptLogLevel = "debug" | "info" | "warn" | "error";

/** The console methods a script's `console` ({@link makeScriptConsole}) sends to the LOG panel. */
export const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * The level a console method logs at: `error` and `warn` their own,
 * `debug` and `trace` `"debug"`, anything else `"info"`.
 */
export function consoleMethodLevel(method: string): ScriptLogLevel {
    if (method === "error") return "error";
    if (method === "warn") return "warn";
    if (method === "debug" || method === "trace") return "debug";
    return "info";
}

const MAX_LEN = 4000;

function fmtOne(a: any): string {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (a === undefined) return "undefined";
    if (typeof a === "function") return `[function ${a.name || "anonymous"}]`;
    if (typeof a === "bigint" || typeof a === "symbol") return String(a);
    try {
        return JSON.stringify(a) ?? String(a);
    } catch {
        return String(a); // circular / exotic
    }
}

/**
 * Formats a log call's arguments as one line of text, separated by spaces:
 * strings as they are, errors as their stack (or `name: message`), functions
 * as `[function name]`, `undefined`, bigints and symbols as `String()` does
 * and anything else as JSON (`String()` when it can't be). Text longer than
 * 4000 characters is cut there, with `… (N more chars)`.
 */
export function formatLogArgs(args: any[]): string {
    const text = args.map(fmtOne).join(" ");
    return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}… (${text.length - MAX_LEN} more chars)` : text;
}

/** The LOG panel's line for a script's log call, e.g. `[name] console.warn: text`. */
export function scriptLogLine(name: string, source: string, text: string): string {
    return `[${name}] ${source}: ${text}`;
}

/**
 * Builds the `console` object a user script sees. Calls to
 * {@link CONSOLE_METHODS} aren't echoed to the host console (for page
 * contexts that would litter the page's devtools): each goes to `emit`
 * instead, with its level, `console.<method>` as the source and its
 * arguments formatted by {@link formatLogArgs}. Other members (`time`,
 * `table`…) fall through to the real console.
 */
export function makeScriptConsole(emit: (level: ScriptLogLevel, source: string, text: string) => void): Console {
    const shim: any = {};
    for (const method of CONSOLE_METHODS) {
        shim[method] = (...args: any[]) => emit(consoleMethodLevel(method), `console.${method}`, formatLogArgs(args));
    }
    return new Proxy(shim, { get: (t, k) => (k in t ? t[k as any] : (console as any)[k]) }) as Console;
}

/** Where a script's GUI code runs: the page's main world, the isolated world or the overlay frame. */
export type ScriptContext = "page" | "isolated" | "overlay";
/** Every {@link ScriptContext}, to check one that arrives in a message. */
export const SCRIPT_CONTEXTS: readonly ScriptContext[] = ["page", "isolated", "overlay"];

/**
 * The Log / Problems tag for a line from GUI code, e.g. `overlay › example.com`.
 * Just the context when `url` is missing or doesn't parse.
 */
export function contextTag(ctx: ScriptContext, url?: string): string {
    let host = "";
    try {
        host = url ? new URL(url).host : "";
    } catch {}
    return host ? `${ctx} › ${host}` : ctx;
}
