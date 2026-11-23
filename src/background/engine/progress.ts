import type { ProgressPhase, ProgressTask } from "../../shared/progress";
import { broadcastToUi } from "./logs";

/** at most one update per phase this often (the last step of a phase always goes) */
const THROTTLE_MS = 100;

export interface ProgressReporter {
    /** the work is at `done` of `total` (0: unknown) in `phase` */
    step(phase: ProgressPhase, done: number, total?: number): void;
    /** the work is over (done or failed) */
    end(): void;
}

/** Report a long store change's steps to the Editor (see shared/progress). */
export function progressReporter(task: ProgressTask): ProgressReporter {
    let phase: ProgressPhase | null = null;
    let last = 0;
    return {
        step(p, done, total = 0) {
            const now = Date.now();
            if (p === phase && now - last < THROTTLE_MS && (total === 0 || done < total)) return;
            phase = p;
            last = now;
            broadcastToUi({ type: "progress", task, phase: p, done, total });
        },
        end() {
            if (phase !== null) broadcastToUi({ type: "progress", task, phase: null });
            phase = null;
        },
    };
}
