/**
 * The Network view's handler stack: which handlers match a request, in the
 * order they run (asked from the background), and what each one did, read
 * from the request's outcome log lines.
 *
 * @module
 */
import type { StackHandler } from "../../shared/precedence";
import type { NetEntry, NetOutcome } from "../../shared/netTypes";

/** What a handler in the stack did to the request. */
export type StackOutcome = "decided" | "overruled" | "skipped" | "ran on mock" | "ran" | "not seen";

/** A stack row: the handler and what it did. */
export interface StackRow extends StackHandler {
    /** What it did, from the request's log lines. */
    outcome: StackOutcome;
}

/** Asks the background for the handlers that match a request, in run order. */
export async function fetchStack(e: Pick<NetEntry, "url" | "method" | "type">): Promise<StackHandler[]> {
    try {
        const r = await chrome.runtime.sendMessage({ type: "netStack", url: e.url, method: e.method, resourceType: e.type });
        return Array.isArray(r) ? r : [];
    } catch {
        return [];
    }
}

const DECISION = /^onRequest(?: #\d+)? → (block|redirect|replaceResponse|allow)\b/;

/**
 * Pairs each handler with what it did, from the request's outcomes. An
 * onRequest decision line names no handler, so it goes to the script's last
 * matching onRequest handler.
 */
export function stackOutcomes(stack: StackHandler[], outcomes: NetOutcome[]): StackRow[] {
    const lastOnRequest = new Map<string, number>();
    stack.forEach((h, i) => h.kind === "onRequest" && lastOnRequest.set(h.scriptId, i));
    return stack.map((h, i) => {
        const mine = outcomes.filter((o) => o.scriptId === h.scriptId).map((o) => o.action);
        const own = (a: string) => a.startsWith(`${h.label} `);
        let outcome: StackOutcome = "not seen";
        if (mine.some((a) => own(a) && a.includes(" was overruled"))) outcome = "overruled";
        else if (mine.some((a) => a.startsWith(`${h.label} → skipped`))) outcome = "skipped";
        else if (mine.some((a) => a.startsWith(`${h.label} ran on a mock`))) outcome = "ran on mock";
        else if (lastOnRequest.get(h.scriptId) === i && mine.some((a) => DECISION.test(a))) outcome = "decided";
        else if (mine.some((a) => own(a) || (a.startsWith(h.kind) && !/^\w+ #\d+/.test(a)))) outcome = "ran";
        return { ...h, outcome };
    });
}
