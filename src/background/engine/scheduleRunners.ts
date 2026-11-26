/**
 * Where `tweak.every` and `tweak.onToastAction` handlers run: MV3 in the
 * offscreen sandbox (no eval in the service worker), MV2 right here in the
 * background page.
 *
 * @module
 */
import { runHookOp } from "../compileHost";
import { ensureBuiltins } from "../../shared/builtins";
import { readInterval, runEvery, runToastAction } from "../../shared/everyRun";
import type { ScheduleRunner, ScheduleScript } from "./schedules";
import { compileMv2, type CompiledEntry } from "./strategies/strategyScripts";
import { packagesSnapshot } from "./packageImports";

/** MV3: each hook is a sandbox call with every enabled script (the sandbox keeps them compiled). */
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

/** MV2: the scripts with schedules or toast actions, compiled once per reload. */
export function inProcessRunner(): ScheduleRunner {
    let scripts: ScheduleScript[] = [];
    let params: Record<string, Record<string, any>> = {};
    let compiled: Promise<Map<string, CompiledEntry>> | null = null;
    const get = async (s: string) => {
        compiled ??= (async () => {
            const wanted = (x: { meta: ScheduleScript["meta"] }) => !!x.meta.every?.length || !!x.meta.toast?.actions;
            await ensureBuiltins(scripts.filter(wanted).map((x) => x.code), packagesSnapshot()).catch(() => {});
            return new Map(compileMv2(scripts, params, wanted).map((c) => [c.id, c]));
        })();
        const c = (await compiled).get(s);
        if (!c) throw new Error("this tweak is off or gone");
        if (c.compiled.error) throw new Error(c.compiled.error.split("\n")[0]);
        return c.compiled.handlers;
    };
    return {
        reload(next, paramValues) {
            scripts = next;
            params = paramValues;
            compiled = null;
        },
        async every(s, index, a) {
            return runEvery(await get(s), index, a);
        },
        async interval(s, index) {
            return readInterval(await get(s), index);
        },
        async toastAction(s, event) {
            await runToastAction(await get(s), event);
        },
    };
}
