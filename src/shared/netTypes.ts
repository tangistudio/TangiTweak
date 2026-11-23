/**
 * Records behind the Editor's Network view, shared by the background
 * recorder and the UI that shows them.
 *
 * The background (`src/background/network.ts`) records one {@link NetEntry}
 * per request while an Editor holds a `"network"` port. It keeps only
 * script-touched rows (no bodies) while nobody watches. It attaches what a
 * script did to a request as {@link NetOutcome}s, parsed from the engine's
 * script-attributed log lines: this module also builds those lines
 * ({@link missedLine}, {@link observedLine}, {@link kindSkipLine},
 * {@link RAN_ACTIONS}) and classifies them ({@link outcomeKind}), so the
 * writer and the parser agree on the wording. Updates reach the UI as
 * {@link NetPortMsg}s.
 *
 * @module
 */

/**
 * What a script did to a request.
 *
 * - `"observed"`: a handler ran but changed nothing (returned `undefined`,
 *   the same body or threw).
 * - `"modified"`: it changed the body, headers or status or blocked,
 *   redirected or answered the request itself.
 */
export type NetKind = "observed" | "modified";
/**
 * A {@link NetKind} or `"missed"`: a body handler should have run for this
 * request but no strategy ran it.
 *
 * A missed outcome is a warning, neither observed nor modified. Its log line
 * comes from {@link missedLine}.
 */
export type OutcomeKind = NetKind | "missed";

/** One thing a script did to a request, shown on its {@link NetEntry} row. */
export interface NetOutcome {
    /** ID of the script the log line is attributed to. */
    scriptId: string;
    /** The script's name as the log line's `[Name]` prefix gives it ({@link NetOutcome.scriptId} when the line has none). */
    scriptName: string;
    /**
     * The log line without its `[Name]` prefix and trailing URL, e.g.
     * `"onResponseBody applied (120b → 140b)"`.
     *
     * When the line was tagged with the strategy that ran it
     * (`[helper] [Name] …`), the tag is appended, e.g. `"… (helper)"`.
     */
    action: string;
    /** Level of the log line the outcome was parsed from. */
    level: "debug" | "info" | "warn" | "error";
    /** Whether the script observed, modified or missed the request (see {@link outcomeKind}). */
    kind: OutcomeKind;
    /** When the background recorded it, in ms since the epoch (`Date.now()`). */
    at: number;
}

const OBSERVED_MARK = "→ observed (no change)";
const MISSED_MARK = " never ran for ";

/**
 * Builds the WARN log line for a body handler no strategy ran, in the form
 * `[Name] onResponseBody never ran for <url> (document) — reason`.
 *
 * The background logs it with kind `"missed"`; {@link outcomeKind} also
 * recognizes it by its wording when a relayed line has no explicit kind.
 *
 * @param handler - The handler's label, e.g. `onResponseBody`.
 * @param what - What kind of load it was, e.g. `document`.
 * @param reason - Why no strategy ran it.
 */
export function missedLine(scriptName: string, handler: string, url: string, what: string, reason: string): string {
    return `[${scriptName}] ${handler}${MISSED_MARK}${url} (${what}) — ${reason}`;
}

/**
 * Builds the DEBUG log line for a script whose `onResponseBody` handlers
 * didn't run because their `binary` option excludes this body.
 *
 * The request counts as handled (the line is logged as `"observed"`), so it
 * isn't reported as missed.
 *
 * @param binaryBody - Whether the body was binary: `true` means the routes
 *   have `binary: false`, `false` means they have `binary: true` (binary only).
 */
export function kindSkipLine(scriptName: string, url: string, binaryBody: boolean): string {
    const why = binaryBody ? "the body is binary and the route has binary: false" : "the body is text and the route has binary: true (binary only)";
    return `[${scriptName}] onResponseBody → not run — ${why} ${url}`;
}

/**
 * The action a Network row shows when a script's page-side code ran for that
 * document or fetched it, keyed by {@link RanApi}.
 *
 * The bridge reports these to the background (a `scriptRan` message, once
 * per script and API per document, except `pageFetch`, which is sent per
 * fetch), which logs them as `"observed"` DEBUG lines on the document's URL.
 */
export const RAN_ACTIONS = {
    /** `onSite` code ran on the document (reported by the page MAIN world hook through the bridge). */
    onSite: "onSite ran",
    /** `onPage` code ran on the document. */
    onPage: "onPage ran",
    /** The script's overlay was shown on the document. */
    onOverlay: "overlay shown",
    /** The script's overlay fetched this URL as the page (`from: "page"`). */
    pageFetch: "fetched by its overlay",
} as const;
/** Kind of page-side activity a `scriptRan` message reports: a key of {@link RAN_ACTIONS}. */
export type RanApi = keyof typeof RAN_ACTIONS;
/** Whether `x` is a {@link RanApi}; the background checks the bridge's `scriptRan` messages with it. */
export const isRanApi = (x: unknown): x is RanApi => typeof x === "string" && Object.prototype.hasOwnProperty.call(RAN_ACTIONS, x);

/**
 * Builds the DEBUG log line for a handler that ran without changing anything:
 * `[Name] <handler> → observed (no change)[ — why] <url>`.
 *
 * It ends with the URL, so the background attaches it to that request. Its
 * wording makes {@link outcomeKind} classify it as `"observed"`.
 *
 * @param handler - The handler's label, e.g. `onResponseBody`.
 * @param why - Optional reason, appended after the mark.
 */
export function observedLine(scriptName: string, handler: string, url: string, why?: string): string {
    return `[${scriptName}] ${handler} ${OBSERVED_MARK}${why ? ` — ${why}` : ""} ${url}`;
}

/**
 * Classifies a script-attributed log line as observed, modified or missed.
 *
 * Engine code passes the kind explicitly; a valid `explicit` always
 * wins. Relayed lines without one fall back to:
 *
 * - `"missed"` for a WARN line containing `" never ran for "` (see
 *   {@link missedLine}).
 * - `"observed"` for errors, DEBUG lines, `"→ observed (no change)"` lines
 *   (see {@link observedLine}) and the script's own output
 *   (`[Name] tweak.log: …`, `[Name] console.<method>: …`).
 * - `"modified"` for anything else (the engine's INFO action lines).
 *
 * @param level - The line's log level (`"debug"`, `"info"`, `"warn"` or `"error"`).
 * @param explicit - The kind the logger gave, if any; other values are ignored.
 */
export function outcomeKind(level: string, message: string, explicit?: OutcomeKind): OutcomeKind {
    if (explicit === "observed" || explicit === "modified" || explicit === "missed") return explicit;
    if (level === "warn" && message.includes(MISSED_MARK)) return "missed";
    if (level === "debug" || level === "error" || message.includes(OBSERVED_MARK)) return "observed";
    if (/^\[[^\]]*\] (tweak\.log|console\.\w+):/.test(message)) return "observed";
    return "modified";
}

/**
 * A captured request or response body: capped text or a placeholder for
 * binary data.
 *
 * The cap is the Settings body cap (`bodyCap`, in kB, times 1024
 * characters). Bodies are kept only while the Network view records; rows
 * kept while nobody watches have none.
 */
export interface NetBody {
    /**
     * The body as text, cut at the cap.
     *
     * Empty for a binary body; `"(file upload)"` for a request body that was
     * only a file upload.
     */
    text: string;
    /** Full size in bytes (UTF-8 for text), before the cap. `0` for a file upload. */
    size: number;
    /** Whether {@link NetBody.text} was cut at the cap. */
    truncated: boolean;
    /**
     * Whether the body is binary, so {@link NetBody.text} holds no content.
     *
     * Bytes count as binary when the first 1024 contain a NUL byte; a file
     * upload is binary too.
     */
    binary: boolean;
}

/**
 * One row of the Network view: a request the background saw through
 * `webRequest` (observe-only) or a synthetic row for one only a script
 * action reported.
 *
 * A redirect is archived as its own row (with {@link NetEntry.redirectTo})
 * and the request continues in a new one.
 */
export interface NetEntry {
    /**
     * Unique row ID.
     *
     * The `webRequest` requestId; `<requestId>:r<n>` for an archived redirect
     * hop; `syn:<n>` for a synthetic row the background couldn't tie to a
     * requestId.
     */
    id: string;
    /** Tab that made the request (`-1` when unknown; a synthetic row learns it from the next caller that knows it). */
    tabId: number;
    /** Request URL; for the row that continues a redirect, the redirect's target. */
    url: string;
    /** HTTP method, e.g. `"GET"`. Synthetic rows default to `"GET"` until a caller gives one. */
    method: string;
    /** webRequest resource type: main_frame, script, xmlhttprequest… (`"other"` for synthetic rows). */
    type: string;
    /** HTTP status code; `null` until the response headers arrive. */
    status: number | null;
    /** The status line's reason phrase, e.g. `"Not Found"`; empty when unknown. */
    statusText: string;
    /** The response's content type without parameters, e.g. `"text/html"`; empty when unknown. */
    mime: string;
    /** Size in bytes, from content-length when known (a synthetic row uses its recorded body's size). */
    size: number | null;
    /** Whether the browser served the response from its cache. */
    fromCache: boolean;
    /** When the request started, in ms since the epoch. */
    startedAt: number;
    /** When it completed or failed, in ms since the epoch; `null` while pending. */
    endedAt: number | null;
    /**
     * Where the request is.
     *
     * A pending row left when recording stops is marked `"done"`, since its
     * listeners are gone.
     */
    state: "pending" | "done" | "failed";
    /** The browser's network error, e.g. `"net::ERR_BLOCKED_BY_CLIENT"`, when {@link NetEntry.state} is `"failed"`. */
    error?: string;
    /** Where this hop redirected to; set only on an archived redirect row. */
    redirectTo?: string;
    /** Origin that started the request (`initiator` or Firefox's `originUrl`). */
    initiator?: string;
    /** Server IP address, when the browser reports it. */
    ip?: string;
    /** Request headers as `[name, value]` pairs, in the order sent. */
    requestHeaders?: [string, string][];
    /**
     * Response headers as `[name, value]` pairs.
     *
     * On completion they are replaced with the final headers, which include
     * changes made by blocking listeners (`onResponseHeaders`).
     */
    responseHeaders?: [string, string][];
    /** Request payload (onBeforeRequest requestBody); form data is shown URL-encoded. */
    requestBody?: NetBody;
    /** The body the page received: known only when TangiTweak handled the response. */
    responseBody?: NetBody;
    /** The upstream body before a script modified it. */
    originalResponseBody?: NetBody;
    /**
     * Whether the row was recorded only from a script action (a page-strategy
     * replacement never hits the network).
     *
     * The background folds a synthetic row into the real request when
     * `webRequest` reports it shortly after.
     */
    synthetic?: boolean;
    /** What scripts did to the request, in the order the background recorded it. */
    outcomes: NetOutcome[];
}

/**
 * Messages the background posts to the Editor on its `"network"` port (and
 * the passive `"network-counts"` port, which gets the same rows without
 * starting the recording).
 *
 * - `netSnapshot`: every row, oldest first; sent when a port connects and,
 *   to passive ports, when recording stops.
 * - `netUpdate`: rows added or changed, batched over a short delay.
 * - `netCleared`: all rows were removed (the UI sent `{ type: "netClear" }`).
 * - `netRemoved`: these synthetic rows were folded into a real request.
 */
export type NetPortMsg =
    | {
          /** Every row, replacing the UI's list. */
          type: "netSnapshot";
          /** All recorded rows, oldest first. */
          entries: NetEntry[];
      }
    | {
          /** Rows added or changed since the last update. */
          type: "netUpdate";
          /** The new or changed rows, whole. */
          entries: NetEntry[];
      }
    | {
          /** All rows were removed. */
          type: "netCleared";
      }
    | {
          /** Rows were removed. */
          type: "netRemoved";
          /** IDs ({@link NetEntry.id}) of the removed rows. */
          ids: string[];
      };
