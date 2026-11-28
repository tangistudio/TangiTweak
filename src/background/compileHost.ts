/**
 * SW-side access to script compilation/execution.
 *
 * The background's CSP forbids eval, so compilation and handler execution
 * are RPCs into the sandbox (src/background/sandboxLink.ts), the only
 * eval-permitted context:
 *
 *   compileForStorage                  → sandbox 'compileOne'
 *   compileManyForStorage              → sandbox 'compileMany'
 *   analyzeScripts                     → sandbox 'analyze'
 *   runBodyOp                          → sandbox 'run'
 *   probeRules                         → sandbox 'rules'
 *
 * scriptStore and the pipeline never call compileScript directly; they go
 * through this module.
 */
import { withData, type DataFileSource } from "../shared/compile";
import { defaultMeta, type ResMeta } from "../shared/metaParser";
import type { ParamTree } from "../shared/scriptDef";
import { dlogLevel } from "../shared/debugLog";
import { sandboxLink, serveSandbox } from "./sandboxLink";
import type { ScriptRules } from "../shared/rulesProbe";
import { dataFilesSig, ensureDataFiles } from "./engine/dataFiles";
import { dataReader, gateCompiled } from "../shared/tweakBundle";
import { ensurePackages, loadPackages, packagesSig, packagesSnapshot } from "./engine/packageImports";
import { SW_EPOCH } from "./engine/stores";
import { log } from "./engine/logs";

interface PlainScript {
    id: string;
    name: string;
    code: string;
    updatedAt: number;
    enabled: boolean;
    /** the user's and package.json layer (handler order) */
    layers?: { user?: "base" | "site" | "override"; pkg?: "base" | "site" | "override" };
}

export interface Analyzed {
    meta: ResMeta;
    paramDefs: ParamTree;
    error: string | null;
    deps: string[];
}

type ParamValues = { [scriptId: string]: Record<string, any> };

/** stable signature of every stored param value (routes may be built from any of them) */
function paramSig(v: ParamValues | undefined): string {
    const s = JSON.stringify(Object.keys(v || {}).sort().map((k) => [k, v![k]]));
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
    return h.toString(36);
}

// ---- RPC ----

/** one call; rejects when the sandbox reports an error or the call is lost */
async function sandboxCall(payload: any): Promise<any> {
    // the epoch tells the sandbox when the background (the store owner) restarted
    const resp = await sandboxLink().call({ ...payload, epoch: SW_EPOCH });
    if (resp?.error) throw new Error(resp.error);
    return resp;
}

/**
 * RPC that compiles against the data files and package modules: the
 * sandbox keeps the last set it got and answers `needDataFiles` when its
 * signature differs; then (only) the files ride along.
 */
async function sandboxCallWithData(payload: any): Promise<any | null> {
    const dataFiles = await ensureDataFiles();
    await loadPackages();
    const dataSig = dataFilesSig() + "." + packagesSig();
    const out = await sandboxCallSafe({ ...payload, dataSig });
    return out?.needDataFiles ? sandboxCallSafe({ ...payload, dataSig, dataFiles, packages: packagesSnapshot() }) : out;
}

/**
 * RPC with a null fallback: callers treat null as graceful passthrough.
 * On failure the host is torn down and the call retried once with a fresh
 * one (heals a dead/zombie document, e.g. after an extension reload or a
 * Chrome shutdown race).
 */
async function sandboxCallSafe(payload: any): Promise<any | null> {
    const link = sandboxLink();
    try {
        await link.ensure();
        return await sandboxCall(payload);
    } catch (e: any) {
        dlogLevel("compile", "warn", `sandbox RPC failed (${payload?.op}) — recreating the sandbox host: ${e?.message || e}`);
        await link.close();
        try {
            await link.ensure(true);
            const out = await sandboxCall(payload);
            dlogLevel("compile", "info", `sandbox RPC recovered after host recreation (${payload?.op})`);
            return out;
        } catch (e2: any) {
            dlogLevel("compile", "warn", `sandbox RPC retry failed (${payload?.op}): ${e2?.message || e2}`);
            return null;
        }
    }
}

// reverse calls from the sandbox: storage + logging
serveSandbox({
    reverse: async (payload: any) => {
        if (payload.op === "log") {
            log(typeof payload.tabId === "number" ? payload.tabId : -1, payload.msg, payload.level || "info", payload.scriptId, payload.netKind === "observed" || payload.netKind === "modified" || payload.netKind === "missed" ? payload.netKind : undefined, undefined, typeof payload.requestId === "string" ? payload.requestId : undefined);
            return {};
        }
        if (payload.op === "paramSet") {
            const { setParamFromCode } = await import("./engine/scriptStore");
            await setParamFromCode(payload.scriptId, payload.key, payload.value).catch(() => {});
            return {};
        }
        const { scriptStorageGet, scriptStorageSet } = await import("./engine/scriptStore");
        if (payload.op === "storageGet") return { value: await scriptStorageGet(payload.scriptId, payload.key) };
        if (payload.op === "storageSet") await scriptStorageSet(payload.scriptId, payload.key, payload.value);
        return {};
    },
});

// ---- public API ----

/** compileForStorage error when the sandbox host itself failed (not user code). */
export const SANDBOX_COMPILE_FAILED = "sandbox compile failed";

/** the stored scripts a save-time compile resolves imports against */
export interface StorageCompileContext {
    /** the saved script's id (it replaces its stored copy in `scripts`) */
    id: string;
    scripts: { id: string; name: string; code: string }[];
    /** every script's stored param values (libraries compile with theirs) */
    paramValues?: ParamValues;
    /** data files that aren't stored (yet) — a package being installed; they shadow stored ones at the same path */
    data?: DataFileSource[];
    /** compile it even if its package.json asks for a newer TangiTweak (installing shows that apart) */
    anyVersion?: boolean;
}

/**
 * Compile a saved script for storage: meta + paramDefs (saveScript path).
 * Imports resolve against the stored scripts in `ctx` (so e.g. a param
 * definition imported from a module is captured with its real type);
 * imports with no matching (or a broken) module resolve to inert stubs —
 * routes built from those come out empty until the reload-time analyze.
 * Package URLs it imports are downloaded first.
 */
export async function compileForStorage(
    code: string,
    name?: string,
    paramValues?: Record<string, any>,
    ctx?: StorageCompileContext
): Promise<{ meta: ResMeta; paramDefs: ParamTree; error: string | null }> {
    const label = name || "x";
    const id = ctx?.id ?? "x";
    const target = { id, name: label, code };
    const scripts = (ctx?.scripts ?? []).filter((s) => s.id !== id);
    const values: ParamValues = { ...(ctx?.paramValues ?? {}), [id]: paramValues ?? {} };
    const data = withData(await ensureDataFiles(), ctx?.data);
    const gate = (c: StorageCompiled): StorageCompiled => gateCompiled(label, c, [label, ...scripts.map((s) => s.name)], dataReader(data), ctx?.anyVersion ? null : undefined);
    // a save retries the script's own failed package downloads
    await ensurePackages([target], { retry: true, data: ctx?.data });
    await ensurePackages(scripts, { data: ctx?.data });
    const resp = await sandboxCallWithData({ op: "compileOne", target, scripts, paramValues: values, extraData: ctx?.data });
    const r = resp?.result;
    if (!r) {
        dlogLevel("compile", "warn", `compileForStorage "${label}": sandbox compile returned nothing — script meta NOT updated`);
        return { meta: defaultMeta(), paramDefs: {}, error: SANDBOX_COMPILE_FAILED };
    }
    dlogLevel(
        "compile", "debug",
        `compiled "${label}" → active=${r.meta.active} match=${JSON.stringify(r.meta.match)} params=[${Object.keys(r.paramDefs || {}).join(", ")}] deps=[${(r.deps || []).join(", ")}]${r.error ? " — compile error (in the Problems view)" : ""}`
    );
    return gate({ meta: r.meta, paramDefs: r.paramDefs, error: r.error });
}

type StorageCompiled = { meta: ResMeta; paramDefs: ParamTree; error: string | null };

/**
 * `compileForStorage` for several stored scripts at once (the importers of
 * a changed library): one compile pass and, in MV3, one sandbox call, so
 * the shared libraries are transpiled and run once. A script missing from
 * the result failed in the sandbox host (keep what's stored).
 */
export async function compileManyForStorage(
    scripts: { id: string; name: string; code: string }[],
    ids: string[],
    paramValues: ParamValues
): Promise<Map<string, StorageCompiled>> {
    const out = new Map<string, StorageCompiled>();
    if (!ids.length) return out;
    const t0 = performance.now();
    await ensurePackages(scripts);
    const read = dataReader(await ensureDataFiles());
    const names = scripts.map((s) => s.name);
    const note = (id: string, r: { meta: ResMeta; paramDefs?: ParamTree; error: string | null; deps?: string[] }) => {
        const name = scripts.find((s) => s.id === id)?.name;
        dlogLevel("compile", "debug", `compiled "${name}" → active=${r.meta.active} match=${JSON.stringify(r.meta.match)} params=[${Object.keys(r.paramDefs || {}).join(", ")}] deps=[${(r.deps || []).join(", ")}]${r.error ? " — compile error (in the Problems view)" : ""}`);
        out.set(id, gateCompiled(name ?? "", { meta: r.meta, paramDefs: r.paramDefs || {}, error: r.error }, names, read));
    };
    const resp = await sandboxCallWithData({ op: "compileMany", ids, scripts, paramValues });
    for (const id of ids) {
        const r = resp?.results?.[id];
        if (r) note(id, r);
        else dlogLevel("compile", "warn", `compileManyForStorage: sandbox returned nothing for "${scripts.find((s) => s.id === id)?.name}" — its meta is NOT updated`);
    }
    dlogLevel("compile", "debug", `timing: compiled ${ids.length} importer(s) in one pass — ${Math.round(performance.now() - t0)} ms`);
    return out;
}

/**
 * Analyze ALL scripts (meta.routes/paramDefs/deps) with the stored param
 * values — routes may be built from params. Reload + getHookBundle path.
 */
export async function analyzeScripts(scripts: { id: string; name: string; code: string; updatedAt: number }[], paramValues?: ParamValues): Promise<Map<string, Analyzed>> {
    const out = await analyzeUngated(scripts, paramValues);
    const read = dataReader(await ensureDataFiles());
    const names = scripts.map((s) => s.name);
    for (const s of scripts) {
        const a = out.get(s.id);
        if (a) out.set(s.id, gateCompiled(s.name, a, names, read));
    }
    return out;
}

/** analyzeScripts, every script as it compiles on its own (before bundle roles) */
async function analyzeUngated(scripts: { id: string; name: string; code: string; updatedAt: number }[], paramValues?: ParamValues): Promise<Map<string, Analyzed>> {
    const out = new Map<string, Analyzed>();
    if (!scripts.length) return out;
    // imports resolve by name (relative paths) and into the data files
    await ensureDataFiles();
    await ensurePackages(scripts);
    const sig = paramSig(paramValues) + "." + dataFilesSig() + "." + packagesSig();
    // FAST PATH: chrome.storage.session-cached analyses, valid while no
    // script's updatedAt changed. A freshly-woken SW serves a page's
    // getHookBundle from here (one storage read) instead of booting the
    // offscreen doc + sandbox — the difference between onDocument running at
    // document_start and after the page already initialized.
    const cached = await readAnalyzeCache();
    if (cached && scripts.every((s) => cached[s.id]?.updatedAt === s.updatedAt && cached[s.id]?.paramSig === sig && cached[s.id]?.name === s.name)) {
        for (const s of scripts) out.set(s.id, cached[s.id].analyzed);
        dlogLevel("compile", "debug", `analyze cache hit — ${scripts.length} script(s) served from session storage (no sandbox round-trip)`);
        return out;
    }
    const t0 = performance.now();
    const resp = await sandboxCallWithData({ op: "analyze", scripts: scripts.map((s) => ({ ...s, enabled: true })), paramValues: paramValues || {} });
    if (!resp) {
        dlogLevel("compile", "error", `sandbox analyze FAILED for ${scripts.length} script(s) — the page bundle serves WITHOUT them (no interception/onDocument until the next successful analyze)`);
        return out;
    }
    for (const s of scripts) {
        const r = resp?.results?.[s.id];
        if (r) out.set(s.id, r);
        else dlogLevel("compile", "warn", `sandbox analyze returned no result for "${s.name}" — it will not intercept in this bundle`);
    }
    dlogLevel("compile", "debug", `timing: sandbox analyzed ${scripts.length} script(s) — ${Math.round(performance.now() - t0)} ms`);
    await persistAnalyzeCache(
        scripts.filter((s) => out.has(s.id)).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt, paramSig: sig, analyzed: out.get(s.id)! }))
    );
    return out;
}

// ---- analyze cache (MV3): session storage, refreshed on script changes ----

const ANALYZE_CACHE_KEY = "resAnalyzeCache";

type AnalyzeCache = Record<string, { updatedAt: number; name?: string; paramSig?: string; analyzed: Analyzed }>;

async function readAnalyzeCache(): Promise<AnalyzeCache | null> {
    try {
        const got = await chrome.storage.session.get(ANALYZE_CACHE_KEY);
        return got?.[ANALYZE_CACHE_KEY] ?? null;
    } catch {
        return null;
    }
}

async function persistAnalyzeCache(entries: { id: string; name: string; updatedAt: number; paramSig: string; analyzed: Analyzed }[]): Promise<void> {
    try {
        // keyed by script id; each write overwrites that id's older entry
        const cached = (await readAnalyzeCache()) ?? {};
        for (const e of entries) cached[e.id] = { updatedAt: e.updatedAt, name: e.name, paramSig: e.paramSig, analyzed: e.analyzed };
        // bound growth: drop ids not seen in a while (keep ≤ 200)
        const ids = Object.keys(cached);
        if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete cached[id];
        await chrome.storage.session.set({ [ANALYZE_CACHE_KEY]: cached });
    } catch (e: any) {
        dlogLevel("compile", "warn", `analyze cache write failed: ${e?.message || e}`);
    }
}

/**
 * Run a body op (requestDecision / transform / responseHeaders)
 * in the sandbox. Returns null
 * on any failure (callers treat it as passthrough).
 */
export async function runBodyOp(
    scripts: PlainScript[],
    paramValues: Record<string, any>,
    op: "requestDecision" | "transform" | "responseHeaders",
    args: Record<string, any>
): Promise<any | null> {
    const out = await sandboxCallWithData({ op: "run", runOp: op, scripts, paramValues, args });
    dlogLevel("compile", "debug", `runBodyOp ${op} → ${JSON.stringify(out)?.slice(0, 120)}`);
    return out;
}

/**
 * One background hook of one script in the sandbox: a `tweak.every`
 * run, an interval read or the `tweak.onToastAction` handlers
 * (src/shared/everyRun.ts). Throws when the sandbox can't run it.
 */
export async function runHookOp(scripts: PlainScript[], paramValues: Record<string, any>, args: Record<string, any>): Promise<any> {
    const out = await sandboxCallWithData({ op: "hook", scripts, paramValues, args });
    if (!out) throw new Error("the sandbox didn't answer");
    if (out.error) throw new Error(out.error);
    return out;
}

/**
 * Run every enabled script's `rules` handlers once in the sandbox and
 * translate them (src/shared/rulesProbe.ts). null on failure.
 */
export async function probeRules(scripts: PlainScript[], paramValues: Record<string, any>, tabIds?: number[], storeSnaps?: Record<string, any>): Promise<Record<string, ScriptRules> | null> {
    const out = await sandboxCallWithData({ op: "rules", scripts, paramValues, tabIds, storeSnaps });
    return out?.results ?? null;
}

/**
 * Evaluate the user's proxy decision (`__resUser` source from shared/pac)
 * for one URL in the sandbox (needs eval). "DIRECT" on
 * failure.
 */
export async function evalProxyDecision(source: string, url: string, host: string): Promise<string> {
    const out = await sandboxCallSafe({ op: "pac", source, args: { url, host } });
    return typeof out?.result === "string" ? out.result : "DIRECT";
}
