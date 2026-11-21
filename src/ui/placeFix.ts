/**
 * Editor quick fixes for where a handler runs: an onSite handler using a
 * store or a handle (which the site's world can't have) moves to
 * tweak.onPage — or the stores it uses become `tweak.siteStore`s.
 */
import { apiPattern, closeOf, codeOnly } from "../shared/codeScan";

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/** `tweak.onSite` registrations' `onSite` name, at or before `offset`: the nearest one becomes `onPage` */
export function onPageEdit(code: string, offset: number): TextEdit | null {
    const re = new RegExp(`\\b${apiPattern(code)}\\s*\\.\\s*(onSite)\\s*\\(`, "g");
    let at = -1;
    for (let m = re.exec(code); m && m.index < offset; m = re.exec(code)) at = m.index + m[0].indexOf("onSite");
    return at < 0 ? null : { start: at, end: at + "onSite".length, text: "onPage" };
}

/**
 * The nearest `tweak.onSite(` handler at or before `offset`: the
 * `tweak.pageStore` / `tweak.globalStore` it uses — directly, or through the
 * top-level variables bound to them — become `tweak.siteStore` (a
 * `tweak.globalStore`'s ID and persist option go: site stores take no name
 * and aren't saved). Empty when it uses none.
 */
export function siteStoreEdits(code: string, offset: number): TextEdit[] {
    const src = codeOnly(code);
    const api = apiPattern(code);
    const re = new RegExp(`(?<![\\w$.])${api}\\s*\\.\\s*onSite\\s*(?:<[^()]*>\\s*)?\\(`, "g");
    let from = -1;
    for (let m = re.exec(src); m && m.index < offset; m = re.exec(src)) from = m.index + m[0].length;
    if (from < 0) return [];
    const to = closeOf(src, from) - 1;
    const args = src.slice(from, to);
    const out: TextEdit[] = [];
    const change = (kindAt: number, kind: string) => {
        out.push({ start: kindAt, end: kindAt + kind.length, text: "siteStore" });
        if (kind === "globalStore") out.push(...globalArgs(src, kindAt + kind.length));
    };
    for (const d of args.matchAll(new RegExp(`(?<![\\w$.])(${api})\\s*\\.\\s*(pageStore|tabStore|globalStore)\\b`, "g")))
        change(from + d.index! + d[0].length - d[2].length, d[2]);
    for (const b of src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*(${api})\\s*\\.\\s*(pageStore|tabStore|globalStore)\\b`, "g"))) {
        if (b.index! >= from && b.index! < to) continue;
        if (!new RegExp(`(?<![\\w$.])${b[1].replace(/\$/g, "\\$")}(?![\\w$]|\\s*:(?!:))`).test(args)) continue;
        change(b.index! + b[0].length - b[3].length, b[3]);
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * The edits dropping a `tweak.globalStore(id, initial, persist)` call's first
 * and third arguments, from just past `globalStore` (a siteStore takes no
 * name and isn't saved).
 */
function globalArgs(src: string, at: number): TextEdit[] {
    const open = /^\s*(?:<[^()]*>\s*)?\(/.exec(src.slice(at));
    if (!open) return [];
    const from = at + open[0].length;
    const close = closeOf(src, from) - 1;
    const commas: number[] = [];
    let depth = 0;
    for (let i = from; i < close; i++) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "," && !depth) commas.push(i);
    }
    const out: TextEdit[] = [];
    if (commas.length) out.push({ start: from, end: commas[0] + 1 + /^\s*/.exec(src.slice(commas[0] + 1))![0].length, text: "" });
    if (commas.length >= 2 && src.slice(commas[1] + 1, close).trim()) out.push({ start: commas[1], end: close, text: "" });
    return out;
}
