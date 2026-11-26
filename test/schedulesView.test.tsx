import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

const calls: any[] = [];
let rows: any[] = [];
vi.mock("../src/ui/lib/toastsApi", () => ({
    toastsApi: {
        schedules: async () => rows,
        runNow: async (s: string, i: number) => void calls.push(["runNow", s, i]),
        pause: async (s: string, i: number, p: boolean) => void calls.push(["pause", s, i, p]),
    },
}));

import { SchedulesView, relTime } from "../src/ui/panel/SchedulesView";
import { actions } from "../src/ui/shell/actions";

const tick = () => act(() => new Promise((r) => setTimeout(r, 5)));
afterEach(() => (cleanup(), (calls.length = 0)));

describe("the Schedules view", () => {
    it("lists each schedule with its next and last run; Run now, Pause and the name act on that one", async () => {
        const now = Date.now();
        rows = [
            { scriptId: "s1", name: "Deals", index: 0, line: 4, running: false, failures: 0, rev: 1, periodMs: 600_000, nextAt: now + 240_000, lastRun: now - 60_000, lastMs: 12 },
            { scriptId: "s2", name: "Build", index: 0, running: false, failures: 3, rev: 1, paused: true, off: "paused", lastRun: now - 5_000, lastError: "HTTP 500" },
        ];
        const opened: any[] = [];
        actions.openProblem = (id, p) => void opened.push([id, p.line]);
        render(<SchedulesView hidden={false} />);
        await tick();
        const trs = [...document.querySelectorAll(".sched-row")];
        expect(trs.map((t) => [...t.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent))).toEqual([
            ["Deals", "10m", "in 4m", "1m ago, took 12 ms"],
            ["Build", "", "paused", "5s ago: HTTP 500"],
        ]);
        expect(trs[1].querySelector(".sched-pause")!.textContent).toBe("Resume");
        fireEvent.click(trs[0].querySelector(".sched-run")!);
        fireEvent.click(trs[1].querySelector(".sched-pause")!);
        fireEvent.click(trs[0].querySelector(".sched-name")!);
        await tick();
        expect(calls).toEqual([
            ["runNow", "s1", 0],
            ["pause", "s2", 0, false],
        ]);
        expect(opened).toEqual([["s1", 4]]);
    });

    it("says how to add one when there are none", async () => {
        rows = [];
        render(<SchedulesView hidden={false} />);
        await tick();
        expect(document.querySelector("#schedules-view")!.textContent).toMatch(/No schedules.*tweak\.every/);
        expect(relTime(1000, 1500)).toBe("now");
    });
});
