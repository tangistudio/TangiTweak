/**
 * Toasts: small cards a tweak pops up on the open tab (`tweak.toast`), drawn
 * by the bridge in its closed shadow root, above the page.
 *
 * This module is the contract every side shares: the options a tweak
 * passes ({@link ToastInput}), their checked form ({@link ToastSpec},
 * {@link normalizeToast}), a tweak's look ({@link ToastStyle},
 * {@link normalizeToastStyle}, {@link mergeToastStyle}) and the limits.
 * The background's toast center (`toastCenter.ts`) routes, rate-limits and
 * queues them; the bridge (`toastLayer.ts`) draws them; `tangitweak/test`
 * records them.
 *
 * @module
 */

import { parseDuration } from "./duration";

/** How a toast reads: its accent color and icon. `"error"` toasts stay until closed unless `duration` says otherwise. */
export type ToastKind = "info" | "success" | "warning" | "error";
/** Every {@link ToastKind}. */
export const TOAST_KINDS: ToastKind[] = ["info", "success", "warning", "error"];

/** A corner (or edge middle) of the viewport a toast stack sits in. */
export type ToastPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
/** Every {@link ToastPosition}. */
export const TOAST_POSITIONS: ToastPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

/** How hard a toast asks for attention while its tab is in the background. */
export type ToastAttention = "none" | "tab" | "window";

/** The longest a toast waits for a tab to show it in, in milliseconds (7 days). */
export const TOAST_MAX_TTL_MS = 7 * 86_400_000;
/** How long a toast waits for a tab when `ttl` isn't set, in milliseconds (1 hour). */
export const TOAST_DEFAULT_TTL_MS = 3_600_000;
/** How long a toast stays on screen when `duration` isn't set (and it isn't an error), in milliseconds. */
export const TOAST_DEFAULT_DURATION_MS = 6000;
/** The most buttons a toast has. */
export const TOAST_MAX_ACTIONS = 2;
/** The largest `data` a toast carries to its pane, in bytes of JSON. */
export const TOAST_MAX_DATA_BYTES = 32 * 1024;
/** The largest `css` a {@link ToastStyle} takes, in characters. */
export const TOAST_MAX_CSS = 8 * 1024;
/** The most toasts one tweak shows in 10 seconds. Updating a toast by its `id` doesn't count. */
export const TOAST_BURST = 1;
/** The most toasts one tweak shows in an hour. Updating a toast by its `id` doesn't count. */
export const TOAST_PER_HOUR = 20;
/** The most toasts on screen at once in a corner; the rest fold into a "+N more" pill. */
export const TOAST_MAX_VISIBLE = 3;
/** The most toasts a tab keeps open at once, all tweaks together; the oldest non-sticky one goes first. */
export const TOAST_MAX_PER_TAB = 6;
/** The narrowest and widest a toast is, in CSS pixels. */
export const TOAST_WIDTH = { min: 280, max: 480, default: 360 } as const;

/** A button on a toast. */
export interface ToastActionSpec {
    /** What `tweak.onToastAction` receives as `actionId`. */
    id: string;
    /** The button's text. */
    label: string;
    /** An http(s) URL the button opens in a new tab (the action still reaches `tweak.onToastAction`). */
    url?: string;
}

/**
 * A tweak's look for its toasts (`tweak.toastStyle`) or one toast's
 * (`style` in its options). Colors are CSS colors; each becomes a `--tt-*`
 * variable inside the toast.
 */
export interface ToastStyle {
    /** The corner the tweak's toasts go to, unless the user picked one. */
    position?: ToastPosition;
    /** The accent: the stripe, the icon and the buttons. */
    accent?: string;
    /** The card's background. */
    background?: string;
    /** The text color. */
    text?: string;
    /** The border color. */
    border?: string;
    /** Corner radius, in pixels or any CSS length. */
    radius?: number | string;
    /** Width in pixels, clamped to {@link TOAST_WIDTH}. */
    width?: number;
    /** The CSS font family. */
    font?: string;
    /** Overrides used while the system is in dark mode: colors, radius, width and font. */
    dark?: Omit<ToastStyle, "dark" | "position" | "css" | "titleFlash" | "iconDot">;
    /** Extra CSS, scoped to the tweak's own toasts; style parts with `[part=title]` and the like. */
    css?: string;
    /** Whether the tab's title flashes while the toast waits in a background tab. Default: the user's setting. */
    titleFlash?: boolean;
    /** Whether the tab's icon gets a dot while the toast waits. Default: the user's setting. */
    iconDot?: boolean;
}

/** What `tweak.toast` takes: a message, or the full options. */
export type ToastInput = string | ToastOptionsInput;

/** The options a tweak passes to `tweak.toast`, before they are checked. */
export interface ToastOptionsInput {
    title?: string;
    message?: string;
    kind?: ToastKind;
    icon?: string | false;
    url?: string;
    actions?: (ToastActionSpec | string)[];
    duration?: number | string;
    id?: string;
    where?: string;
    ttl?: number | string;
    style?: ToastStyle;
    attention?: ToastAttention;
    pane?: string;
    data?: unknown;
}

/** A toast's checked options, as the background routes them and the bridge draws them. */
export interface ToastSpec {
    /** The toast's id, unique in its tweak: showing one with the same id replaces it. */
    id: string;
    /** The bold first line. */
    title?: string;
    /** The text under it. Plain text only. */
    message?: string;
    /** Its kind. */
    kind: ToastKind;
    /** An emoji or short text, an http(s) or `data:image` URL, or `false` for none (the kind's icon otherwise). */
    icon?: string | false;
    /** What a click on the toast opens, in a new tab: http(s) only. */
    url?: string;
    /** Its buttons, at most {@link TOAST_MAX_ACTIONS}. */
    actions?: ToastActionSpec[];
    /** How long it stays on screen in milliseconds (the timer pauses while the tab is hidden or hovered), or `"sticky"` until closed. */
    duration: number | "sticky";
    /** Which tab shows it: `"active"`, `"this"` (the calling page's) or a URL pattern. */
    where: string;
    /** How long it waits for a tab, in milliseconds. */
    ttl: number;
    /** Its own look, over its tweak's. */
    style?: ToastStyle;
    /** What its tab does while it waits in the background. */
    attention: ToastAttention;
    /** The `tweak.toastPane` that draws it, if any. */
    pane?: string;
    /** What the pane gets, as JSON. */
    data?: unknown;
}

/** What `tweak.toast` resolves to. */
export interface ToastResult {
    /** The toast's id. */
    id: string;
    /** `"shown"` on a tab, `"queued"` until a tab can show it, or `"dropped"` (muted, rate-limited or too many). */
    status: "shown" | "queued" | "dropped";
    /** Why it was dropped. */
    reason?: string;
}

/** What a user did to a toast, as `tweak.onToastAction` receives it. */
export interface ToastEvent {
    /** The toast's id. */
    toastId: string;
    /** The button's id, or `"click"` (the card) or `"close"` (closed by the user). */
    actionId: string;
    /** What a pane passed to `ui.action(id, value)`. */
    value?: unknown;
}

const isStr = (v: unknown): v is string => typeof v === "string";
let autoId = 0;

/** Makes a toast id, unique in this context. */
export function newToastId(): string {
    return `t${Date.now().toString(36)}${(++autoId).toString(36)}`;
}

function text(v: unknown, what: string, max: number): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (!isStr(v)) throw new Error(`tweak.toast: ${what} must be a string`);
    return v.length > max ? v.slice(0, max - 1) + "…" : v;
}

/** Whether `url` is an http(s) URL. */
export function isWebUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Checks a toast's options and fills in the defaults.
 *
 * @throws When an option is wrong: an unknown kind, a non-http(s) `url`, too many actions, a bad duration, `data` over {@link TOAST_MAX_DATA_BYTES}.
 */
export function normalizeToast(input: ToastInput): ToastSpec {
    const o: ToastOptionsInput = isStr(input) ? { message: input } : input;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("tweak.toast: pass a message or { title, message, … }");
    const kind = o.kind ?? "info";
    if (!TOAST_KINDS.includes(kind)) throw new Error(`tweak.toast: kind must be one of ${TOAST_KINDS.join(", ")}`);
    const title = text(o.title, "title", 200);
    const message = text(o.message, "message", 1000);
    if (!title && !message && !o.pane) throw new Error("tweak.toast: give it a title, a message or a pane");
    const spec: ToastSpec = {
        id: o.id === undefined ? newToastId() : String(text(o.id, "id", 100)),
        kind,
        duration: "sticky",
        where: "active",
        ttl: TOAST_DEFAULT_TTL_MS,
        attention: "tab",
    };
    if (title) spec.title = title;
    if (message) spec.message = message;
    if (o.icon === false) spec.icon = false;
    else if (o.icon !== undefined) {
        const icon = text(o.icon, "icon", 2048)!;
        if (/^(https?:|data:image\/)/i.test(icon) ? false : icon.length > 8) throw new Error("tweak.toast: icon is an emoji or short text, or an http(s) or data:image URL");
        spec.icon = icon;
    }
    if (o.url !== undefined) {
        if (!isStr(o.url) || !isWebUrl(o.url)) throw new Error("tweak.toast: url must be an http(s) URL");
        spec.url = o.url;
    }
    if (o.actions !== undefined) {
        if (!Array.isArray(o.actions)) throw new Error("tweak.toast: actions must be a list");
        if (o.actions.length > TOAST_MAX_ACTIONS) throw new Error(`tweak.toast: at most ${TOAST_MAX_ACTIONS} actions`);
        spec.actions = o.actions.map((a, i) => {
            const label = text(isStr(a) ? a : a?.label, `actions[${i}].label`, 40);
            if (!label) throw new Error(`tweak.toast: actions[${i}] needs a label`);
            const id = isStr(a) ? a : text(a.id, `actions[${i}].id`, 100) || label;
            if (id === "click" || id === "close") throw new Error(`tweak.toast: "${id}" is taken, pick another action id`);
            const url = isStr(a) ? undefined : a.url;
            if (url !== undefined && (!isStr(url) || !isWebUrl(url))) throw new Error(`tweak.toast: actions[${i}].url must be an http(s) URL`);
            return url ? { id, label, url } : { id, label };
        });
    }
    if (o.duration === undefined) spec.duration = kind === "error" ? "sticky" : TOAST_DEFAULT_DURATION_MS;
    else if (o.duration === "sticky") spec.duration = "sticky";
    else spec.duration = parseDuration(o.duration, "tweak.toast: duration");
    if (o.where !== undefined) {
        const w = text(o.where, "where", 2000)!;
        if (!w) throw new Error(`tweak.toast: where is "active", "this" or a URL pattern`);
        spec.where = w;
    }
    if (o.ttl !== undefined) spec.ttl = Math.min(parseDuration(o.ttl, "tweak.toast: ttl"), TOAST_MAX_TTL_MS);
    if (o.style !== undefined) spec.style = normalizeToastStyle(o.style, "tweak.toast: style");
    if (o.attention !== undefined) {
        if (!["none", "tab", "window"].includes(o.attention)) throw new Error(`tweak.toast: attention must be "none", "tab" or "window"`);
        spec.attention = o.attention;
    }
    if (o.pane !== undefined) spec.pane = text(o.pane, "pane", 100);
    if (o.data !== undefined) {
        let json: string;
        try {
            json = JSON.stringify(o.data);
        } catch {
            throw new Error("tweak.toast: data must be JSON");
        }
        if (json === undefined) throw new Error("tweak.toast: data must be JSON");
        if (new TextEncoder().encode(json).length > TOAST_MAX_DATA_BYTES) throw new Error(`tweak.toast: data is over ${TOAST_MAX_DATA_BYTES / 1024} KB`);
        spec.data = JSON.parse(json);
    }
    return spec;
}

const STYLE_KEYS = ["position", "accent", "background", "text", "border", "radius", "width", "font", "dark", "css", "titleFlash", "iconDot"] as const;
const DARK_KEYS = ["accent", "background", "text", "border", "radius", "width", "font"];

/**
 * Checks a {@link ToastStyle}.
 *
 * @throws On an unknown key or a wrong value.
 */
export function normalizeToastStyle(s: unknown, where = "tweak.toastStyle"): ToastStyle {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${where}: expected an object like { accent: "#e8590c" }`);
    const out: ToastStyle = {};
    for (const [k, v] of Object.entries(s)) {
        if (v === undefined) continue;
        if (!(STYLE_KEYS as readonly string[]).includes(k)) throw new Error(`${where}: unknown key "${k}" (keys: ${STYLE_KEYS.join(", ")})`);
        if (k === "position") {
            if (!TOAST_POSITIONS.includes(v as ToastPosition)) throw new Error(`${where}: position must be one of ${TOAST_POSITIONS.join(", ")}`);
            out.position = v as ToastPosition;
        } else if (k === "width") {
            if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: width is a number of pixels`);
            out.width = Math.min(TOAST_WIDTH.max, Math.max(TOAST_WIDTH.min, Math.round(v)));
        } else if (k === "radius") {
            if (typeof v === "number" && Number.isFinite(v)) out.radius = v;
            else if (isStr(v) && /^[\w.%\s-]{1,40}$/.test(v)) out.radius = v;
            else throw new Error(`${where}: radius is a number of pixels or a CSS length`);
        } else if (k === "dark") {
            const bad = v && typeof v === "object" ? Object.keys(v).find((x) => !DARK_KEYS.includes(x)) : "";
            if (bad !== undefined) throw new Error(`${where}: dark is an object of ${DARK_KEYS.join(", ")}${bad ? ` (not "${bad}")` : ""}`);
            out.dark = normalizeToastStyle(v, `${where}: dark`) as ToastStyle["dark"];
        } else if (k === "titleFlash" || k === "iconDot") {
            if (typeof v !== "boolean") throw new Error(`${where}: ${k} is true or false`);
            out[k] = v;
        } else if (k === "css") {
            if (!isStr(v)) throw new Error(`${where}: css is a string`);
            if (v.length > TOAST_MAX_CSS) throw new Error(`${where}: css is over ${TOAST_MAX_CSS} characters`);
            if (/@import/i.test(v)) throw new Error(`${where}: css can't @import`);
            out.css = v;
        } else {
            // colors and the font: one CSS value, nothing that ends the declaration
            if (!isStr(v) || v.length > 200 || /[;{}<>]/.test(v)) throw new Error(`${where}: ${k} is one CSS value, like "#e8590c"`);
            (out as any)[k] = v;
        }
    }
    return out;
}

/**
 * Merges looks, later ones winning per key; `css` adds up.
 *
 */
export function mergeToastStyle(...styles: (ToastStyle | undefined)[]): ToastStyle {
    const out: ToastStyle = {};
    for (const s of styles) {
        if (!s) continue;
        for (const [k, v] of Object.entries(s)) {
            if (v === undefined) continue;
            if (k === "css") out.css = out.css ? `${out.css}\n${v}` : (v as string);
            else if (k === "dark") out.dark = { ...out.dark, ...(v as object) };
            else (out as any)[k] = v;
        }
    }
    return out;
}

/** The keys both styles set (but `css`, which adds up). */
export function repeatedStyleKeys(a: ToastStyle, b: ToastStyle): string[] {
    return Object.keys(b).filter((k) => k !== "css" && k in a);
}

/**
 * A toast as the bridge draws it: its spec, whose it is and how it looks,
 * resolved by the background's toast center.
 */
export interface ToastView extends ToastSpec {
    /** Unique in the tab: `<script id>:<toast id>`. Showing a toast with the same key replaces it in place. */
    key: string;
    /** The tweak's name, for the "from <tweak>" line. */
    source: string;
    /** The look: the tweak's `toastStyle`, then the toast's own `style` (empty when the user chose the same look for all toasts). */
    look: ToastStyle;
    /** The corner, resolved: the user's (for the site, then global), then the toast's, then the tweak's, then bottom-right. */
    position: ToastPosition;
    /** Whether the user's corner decided `position`. */
    userCorner: boolean;
    /** Whether the tab title flashes and its icon gets a dot while the toast waits unseen. */
    signals: { titleFlash: boolean; iconDot: boolean };
    /** When the tweak made it (ms since epoch). */
    createdAt: number;
}

/** Picks a toast's corner. `site` and `global` are the user's choices; the user wins over the tweak. */
export function resolveToastPosition(o: { site?: ToastPosition; global?: ToastPosition; toast?: ToastPosition; tweak?: ToastPosition }): { position: ToastPosition; userCorner: boolean } {
    const user = o.site ?? o.global;
    if (user) return { position: user, userCorner: true };
    return { position: o.toast ?? o.tweak ?? "bottom-right", userCorner: false };
}
