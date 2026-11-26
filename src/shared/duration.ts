/**
 * Durations as tweaks write them: a number of milliseconds, or text such as
 * `"30s"`, `"5m"`, `"1h"`, `"1d"` or `"1h30m"`. Used by `tweak.every` (the
 * interval) and `tweak.toast` (`ttl`, `duration`).
 *
 * @module
 */

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;

/**
 * Milliseconds for a duration: a positive finite number as is, or text made
 * of one or more `<number><unit>` parts (units `ms`, `s`, `m`, `h`, `d`),
 * largest first, such as `"1h30m"`. Spaces between parts are allowed.
 *
 * @throws When the value isn't a positive duration (`"1x"`, `""`, `"-1h"`, `"0m"`, `0`, `NaN`).
 */
export function parseDuration(value: unknown, what = "duration"): number {
    if (typeof value === "number") {
        if (Number.isFinite(value) && value > 0) return value;
        throw new Error(`${what}: expected a positive number of milliseconds, got ${value}`);
    }
    if (typeof value !== "string") throw new Error(`${what}: expected milliseconds or text like "30s", "5m", "1h" or "1d"`);
    const text = value.replace(/\s+/g, "");
    let ms = 0;
    let at = 0;
    let last = Infinity;
    while (at < text.length) {
        PART.lastIndex = at;
        const m = PART.exec(text);
        if (!m) break;
        const unit = UNIT_MS[m[2]];
        if (unit >= last) throw new Error(`${what}: "${value}" repeats a unit or lists them out of order (write "1h30m")`);
        last = unit;
        ms += Number(m[1]) * unit;
        at = PART.lastIndex;
    }
    if (!text || at !== text.length) throw new Error(`${what}: "${value}" isn't a duration; write it like "30s", "5m", "1h", "1d" or "1h30m"`);
    if (!(ms > 0)) throw new Error(`${what}: "${value}" must be longer than zero`);
    return Math.round(ms);
}

/** Short text for a duration in milliseconds, for logs and the UI: `"90s"` → `"1m30s"`. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    let left = Math.round(ms / 1000);
    const out: string[] = [];
    for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
        const n = Math.floor(left / size);
        if (n) out.push(`${n}${unit}`);
        left -= n * size;
    }
    return out.join("");
}
