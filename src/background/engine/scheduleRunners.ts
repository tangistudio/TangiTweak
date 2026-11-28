/**
 * Where `tweak.every` and `tweak.onToastAction` handlers run: in the
 * sandbox (the background can't eval).
 *
 * @module
 */
import { runHookOp } from "../compileHost";
import type { ScheduleRunner } from "./schedules";

/** each hook is a sandbox call with every enabled script (the sandbox keeps them compiled). */
export function sandboxRunner(): ScheduleRunner {
    let plain: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    let params: Record<string, Record<string, any>> = {};
    return {
        reload(scripts, paramValues) {
            plain = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
            params = paramValues;
        },
        async every(s, index, a) {
            return (await runHookOp(plain, params, { hook: "every", scriptId: s, index, ...a })).outcome;
        },
        async interval(s, index) {
            return (await runHookOp(plain, params, { hook: "interval", scriptId: s, index })).period;
        },
        async toastAction(s, event) {
            await runHookOp(plain, params, { hook: "toastAction", scriptId: s, event });
        },
    };
}
