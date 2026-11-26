import { useEffect, useState } from "react";
import { formatDuration } from "../../shared/duration";
import { toastsApi, type ScheduleRow } from "../lib/toastsApi";
import { actions } from "../shell/actions";

const POLL_MS = 2000;

/** "in 4 min", "now", "5 min ago" */
export function relTime(at: number, now = Date.now()): string {
    const d = at - now;
    if (Math.abs(d) < 1000) return "now";
    return d > 0 ? `in ${formatDuration(d)}` : `${formatDuration(-d)} ago`;
}

function nextOf(r: ScheduleRow): string {
    if (r.running) return "running";
    if (r.off) return r.off;
    return r.nextAt ? relTime(r.nextAt) : "";
}

/**
 * The Schedules view: every `tweak.every`, when it runs next, how its last
 * run went, with Run now and Pause. Asks the background every 2 s while it shows.
 */
export function SchedulesView({ hidden }: { hidden: boolean }) {
    const [rows, setRows] = useState<ScheduleRow[] | null>(null);
    const [error, setError] = useState("");
    const [, setTick] = useState(0);
    const refresh = () =>
        toastsApi.schedules().then(
            (r) => (setRows(r), setError("")),
            (e) => setError(String(e?.message ?? e))
        );
    useEffect(() => {
        if (hidden) return;
        void refresh();
        const t = setInterval(() => (void refresh(), setTick((n) => n + 1)), POLL_MS);
        return () => clearInterval(t);
    }, [hidden]);
    const act = (p: Promise<unknown>) =>
        void p.then(
            () => refresh(),
            (e) => actions.status(String(e?.message ?? e), "error")
        );
    const msg = error || (rows && !rows.length ? "No schedules. A tweak runs code on a schedule with tweak.every(\"10m\", (ctx) => { … })." : "");
    return (
        <div id="schedules-view" hidden={hidden}>
            {msg ? <div className="preview-msg">{msg}</div> : null}
            {rows?.length ? (
                <table className="sched-table">
                    <thead>
                        <tr>
                            <th>Tweak</th>
                            <th>Every</th>
                            <th>Next</th>
                            <th>Last run</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={`${r.scriptId}:${r.index}`} className={r.off ? "sched-row off" : "sched-row"} data-script={r.scriptId}>
                                <td>
                                    <a href="#" className="sched-name" title="Open the tweak at this schedule" onClick={(e) => (e.preventDefault(), actions.openProblem(r.scriptId, { severity: "warning", kind: "runtime", message: "", ...(r.line ? { line: r.line } : {}) }))}>
                                        {r.name}
                                        {rows.filter((x) => x.scriptId === r.scriptId).length > 1 ? ` #${r.index + 1}` : ""}
                                    </a>
                                </td>
                                <td>{r.periodMs ? formatDuration(r.periodMs) : ""}</td>
                                <td className="sched-next">{nextOf(r)}</td>
                                <td className={r.lastError ? "sched-last err" : "sched-last"} title={r.lastError ?? ""}>
                                    {r.lastRun ? `${relTime(r.lastRun)}${r.lastMs !== undefined ? `, took ${r.lastMs} ms` : ""}` : "never"}
                                    {r.lastError ? `: ${r.lastError}` : ""}
                                </td>
                                <td className="sched-actions">
                                    <button className="sched-run" disabled={r.running} onClick={() => act(toastsApi.runNow(r.scriptId, r.index))}>
                                        Run now
                                    </button>{" "}
                                    <button className="sched-pause" onClick={() => act(toastsApi.pause(r.scriptId, r.index, !r.paused))}>
                                        {r.paused ? "Resume" : "Pause"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </div>
    );
}
