/** The background's schedules and toasts ops, for the Editor, Settings and the popup. */
import { sendWake } from "./messaging";
import type { ScheduleRow } from "../../background/engine/schedules";
import type { ToastHistoryEntry, ToastPrefs } from "../../background/engine/toastCenter";

export type { ScheduleRow, ToastHistoryEntry, ToastPrefs };

async function ask<T>(msg: Record<string, unknown>): Promise<T> {
    const r = await sendWake<{ result?: T; error?: string } | undefined>(msg);
    if (!r) throw new Error("no answer from the background");
    if (r.error) throw new Error(r.error);
    return r.result as T;
}

/** A pref set to `null` goes back to its default. */
export type ToastPrefsPatch = { [K in keyof ToastPrefs]?: ToastPrefs[K] | null };

export const toastsApi = {
    schedules: (scriptId?: string) => ask<ScheduleRow[]>({ type: "schedules.list", scriptId }),
    runNow: (scriptId: string, index: number) => ask<unknown>({ type: "schedules.runNow", scriptId, index }),
    /** `index` undefined: every schedule of the tweak. */
    pause: (scriptId: string, index: number | undefined, paused: boolean) => ask<void>({ type: "schedules.pause", scriptId, index, paused }),
    pauseAll: (paused: boolean) => ask<void>({ type: "schedules.pauseAll", paused }),
    pausedAll: () => ask<boolean>({ type: "schedules.pausedAll" }),
    prefs: () => ask<ToastPrefs>({ type: "toasts.prefs" }),
    setPrefs: (prefs: ToastPrefsPatch) => ask<ToastPrefs>({ type: "toasts.setPrefs", prefs }),
    mute: (scriptId: string, muted: boolean) => ask<void>({ type: "toasts.mute", scriptId, muted }),
    history: (scriptId?: string) => ask<Record<string, ToastHistoryEntry[]>>({ type: "toasts.history", scriptId }),
};
