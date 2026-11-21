/**
 * Single owner of the Editor's TypeScript workspace: stages all dynamic
 * typings (built-in React/valtio, downloaded packages' `.d.ts` files,
 * JSON data-file `.d.json.ts` declarations) and runs one epoch-stamped
 * diagnostic loop over script models so TypeScript never checks a
 * half-loaded project or flashes transient missing-module errors.
 */

import { builtinSpec, jsxElementAt } from "../shared/builtinSpecs";
import { TWEAK_MODULE } from "../shared/tweakApi";
import { declarationCandidates, normalizePath, PACKAGE_MODULES_KEY, PACKAGE_ORIGIN, PACKAGE_TYPINGS_KEY, relativePath, TYPINGS_ROOT, type StoredTypings } from "../shared/packageImports";
import { badPackageImports, coveredMissingModule, dependantsOf, importSpecs, isImageDataPath, isMarkdownPath, isSvgPath } from "../shared/scriptImports";
import { isGitignorePath, isTsxName } from "../shared/scriptName";
import { scriptLint } from "../shared/scriptLint";
import { bareImport, dataReader } from "../shared/tweakBundle";
import { baseName } from "./explorerTree";
import { jsonDeclPath, jsonModuleDts } from "./jsonTypes";
import { BUILTIN_ROOT } from "./monacoSetup";

export const IMPORT_OWNER = "tt-imports";
export const JSX_OWNER = "tt-jsx";
export const JSX_IN_TS = "jsx-in-ts";
export const TS_OWNER = "typescript";
export const LINT_OWNER = "tt-lint";

export interface TsPosition {
    lineNumber: number;
    column: number;
}

export interface TsModelLike {
    readonly uri: { toString(): string };
    getValue(): string;
    getVersionId(): number;
    getPositionAt(offset: number): TsPosition;
    isDisposed(): boolean;
    onDidChangeContent(listener: () => void): { dispose(): void };
}

export interface TsDiagnosticChain {
    messageText: string;
    next?: TsDiagnosticChain[];
}

export interface TsDiagnosticRelated {
    file?: { fileName: string };
    start?: number;
    length?: number;
    messageText: string | TsDiagnosticChain;
}

export interface TsDiagnosticLike extends TsDiagnosticRelated {
    category: number;
    code: number;
    reportsUnnecessary?: unknown;
    reportsDeprecated?: unknown;
    relatedInformation?: TsDiagnosticRelated[];
}

export interface TsWorkerLike {
    getSyntacticDiagnostics(uri: string): Promise<TsDiagnosticLike[]>;
    getSemanticDiagnostics(uri: string): Promise<TsDiagnosticLike[]>;
    getSuggestionDiagnostics?(uri: string): Promise<TsDiagnosticLike[]>;
}

export interface TsMarkerData {
    severity: number;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    message: string;
    source?: string;
    code?: string;
    tags?: number[];
    relatedInformation?: {
        resource: unknown;
        message: string;
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
    }[];
}

export interface TsScriptEntry {
    id: string;
    name: string;
    model: TsModelLike;
}

export interface TsDataInput {
    path: string;
    text: string;
}

export interface TsWorkspaceHost {
    addExtraLib(content: string, uri: string): { dispose(): void };
    /** Yield until pending `addExtraLib` / `dispose` updates have been queued to the worker. */
    flushExtraLibs(): Promise<void>;
    fileUri(path: string): string;
    getWorker(uris: unknown[]): Promise<TsWorkerLike>;
    getActiveModel(): TsModelLike | null;
    modelByUri(uri: string): TsModelLike | null;
    getModelMarkers(uri: unknown, owner: string): TsMarkerData[];
    setModelMarkers(model: TsModelLike, owner: string, markers: TsMarkerData[]): void;
    fetchBuiltinTypes(): Promise<Record<string, string>>;
    loadPackageTypings(): Promise<Record<string, string>>;
    subscribePackageStore(onChange: (typings: Record<string, string> | undefined) => void): { dispose(): void };
    onChecked(): void;
    ignoredCodes?(): number[];
    severity?: { Hint: number; Info: number; Warning: number; Error: number };
    markerTag?: { Unnecessary: number; Deprecated: number };
    editDebounceMs?: number;
}

export interface TsWorkspace {
    /** Run `mutateModels` as an atomic batch, then stage script + data-file changes and schedule checks. */
    sync(mutateModels: () => void, getScripts: () => TsScriptEntry[], getDataFiles: () => TsDataInput[]): string[];
    /** Update data-file `.d.json.ts` extraLibs (e.g. unsaved JSON edits) and queue importers; returns changed declaration URIs. */
    setDataFiles(dataFiles: TsDataInput[]): string[];
    /** Move `model` to the front of any pending check queue (e.g. on tab switch). */
    prioritize(model: TsModelLike | null): void;
    /** True once `model`'s current version has been checked against a ready workspace. */
    isChecked(model: TsModelLike): boolean;
    dispose(): void;
}

/** Does any script code import a built-in module (`react`, `valtio`, …) or use JSX? */
export function needsBuiltinTypings(codes: Iterable<string>): boolean {
    for (const code of codes) {
        for (const s of importSpecs(code)) if (builtinSpec(s) === s && s !== TWEAK_MODULE) return true;
    }
    return false;
}

const DEFAULT_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 };
const DEFAULT_TAG = { Unnecessary: 1, Deprecated: 2 };

function flattenMessage(t: string | TsDiagnosticChain): string {
    return typeof t === "string" ? t : [t.messageText, ...(t.next || []).map(flattenMessage)].join("\n  ");
}

const markerKey = (x: TsMarkerData): string =>
    `${x.severity} ${x.code ?? ""} ${x.startLineNumber}:${x.startColumn}-${x.endLineNumber}:${x.endColumn} ${x.message}`;

export function createTsWorkspace(host: TsWorkspaceHost): TsWorkspace {
    const sev = host.severity ?? DEFAULT_SEVERITY;
    const tag = host.markerTag ?? DEFAULT_TAG;
    const editDebounceMs = host.editDebounceMs ?? 250;

    interface TrackedEntry {
        id: string;
        name: string;
        model: TsModelLike;
        syncedVersion: number;
        sub: { dispose(): void };
    }
    interface ExtraLibSlot {
        content: string;
        lib: { dispose(): void };
    }

    const entries = new Map<string, TrackedEntry>();
    const modelToId = new Map<TsModelLike, string>();
    const libs = {
        builtin: new Map<string, ExtraLibSlot>(),
        packages: new Map<string, ExtraLibSlot>(),
        data: new Map<string, ExtraLibSlot>(),
        bare: new Map<string, ExtraLibSlot>(),
    };
    let typingFiles: Record<string, string> = {};
    let lastData: TsDataInput[] = [];
    const prevDataDts = new Map<string, string>();
    const dirty = new Set<TsModelLike>();
    const editTimers = new Map<TsModelLike, ReturnType<typeof setTimeout>>();
    const checkedVersion = new WeakMap<TsModelLike, number>();
    const rawMarkers = new WeakMap<TsModelLike, TsMarkerData[]>();
    const modelRetries = new WeakMap<TsModelLike, number>();

    let epoch = 0;
    let extraLibsDirty = false;
    let inSyncBatch = false;
    let draining = false;
    let drainScheduled = false;
    let disposed = false;
    let workerRetries = 0;
    let priorityModel: TsModelLike | null = null;

    let builtinLoaded = false;
    let builtinPromise: Promise<void> | null = null;

    function putLibs(slot: Map<string, ExtraLibSlot>, want: Map<string, string>): string[] {
        const changed: string[] = [];
        for (const [uri, cur] of slot) {
            if (want.get(uri) === cur.content) continue;
            cur.lib.dispose();
            slot.delete(uri);
            changed.push(uri);
        }
        for (const [uri, content] of want) {
            if (slot.has(uri)) continue;
            slot.set(uri, { content, lib: host.addExtraLib(content, uri) });
            changed.push(uri);
        }
        if (changed.length) {
            extraLibsDirty = true;
            epoch++;
        }
        return changed;
    }

    function applyPackageTypings(files: Record<string, string>, recheckExisting: boolean): void {
        if (disposed) return;
        typingFiles = files;
        const want = new Map(Object.entries(files).map(([p, text]) => [`file:///${TYPINGS_ROOT}/${p}`, text]));
        const changed = putLibs(libs.packages, want);
        if (changed.length && recheckExisting && entries.size) {
            for (const e of entries.values()) dirty.add(e.model);
            kickDrain();
        }
    }

    const initialPkgTypings: Promise<void> = host
        .loadPackageTypings()
        .then((files) => applyPackageTypings(files, false))
        .catch(() => {});

    const storeSub = host.subscribePackageStore((files) => {
        if (files !== undefined) applyPackageTypings(files, true);
    });

    function ensureBuiltins(codes: Iterable<string>): Promise<void> {
        if (builtinLoaded || !needsBuiltinTypings(codes)) return Promise.resolve();
        if (!builtinPromise) {
            builtinPromise = host
                .fetchBuiltinTypes()
                .then((files) => {
                    if (disposed) return;
                    const want = new Map(Object.entries(files).map(([p, text]) => [`${BUILTIN_ROOT}/${p}`, text]));
                    putLibs(libs.builtin, want);
                    builtinLoaded = true;
                })
                .catch(() => {
                    builtinPromise = null;
                });
        }
        return builtinPromise;
    }

    function updateImportMarkers(m: TsModelLike): void {
        if (m.isDisposed()) return;
        const code = m.getValue();
        const bad = badPackageImports(code);
        const had = host.getModelMarkers(m.uri, IMPORT_OWNER);
        if (!bad.length && !had.length) return;
        const markers: TsMarkerData[] = bad.map((b) => {
            const a = m.getPositionAt(b.offset);
            const e = m.getPositionAt(b.offset + b.length);
            return {
                severity: sev.Error,
                source: "tangitweak",
                code: "package-import",
                message: b.message,
                startLineNumber: a.lineNumber,
                startColumn: a.column,
                endLineNumber: e.lineNumber,
                endColumn: e.column,
            };
        });
        if (markers.map(markerKey).join("\n") === had.map(markerKey).join("\n")) return;
        host.setModelMarkers(m, IMPORT_OWNER, markers);
    }

    /** scriptLint's diagnostics (world access, rules side effects, selectors and shortcuts), whole-line: lint sees transpiled code, which keeps lines but not columns */
    function updateLintMarkers(m: TsModelLike): void {
        if (m.isDisposed()) return;
        const code = m.getValue();
        const found = scriptLint(code);
        const had = host.getModelMarkers(m.uri, LINT_OWNER);
        if (!found.length && !had.length) return;
        const lines = code.split("\n");
        const markers: TsMarkerData[] = found.map((d) => {
            const text = lines[d.line - 1] ?? "";
            const startColumn = text.length - text.trimStart().length + 1;
            return {
                severity: d.severity === "error" ? sev.Error : sev.Warning,
                source: "tangitweak",
                code: d.rule,
                message: d.message,
                startLineNumber: d.line,
                startColumn,
                endLineNumber: d.line,
                endColumn: Math.max(text.trimEnd().length + 1, startColumn + 1),
            };
        });
        if (markers.map(markerKey).join("\n") === had.map(markerKey).join("\n")) return;
        host.setModelMarkers(m, LINT_OWNER, markers);
    }

    function updateJsxMarker(m: TsModelLike, scriptName: string): void {
        if (m.isDisposed()) return;
        const at = !isTsxName(scriptName) ? jsxElementAt(m.getValue()) : -1;
        if (at < 0 && !host.getModelMarkers(m.uri, JSX_OWNER).length) return;
        if (at < 0) {
            host.setModelMarkers(m, JSX_OWNER, []);
            return;
        }
        const a = m.getPositionAt(at);
        host.setModelMarkers(m, JSX_OWNER, [
            {
                severity: sev.Error,
                source: "tangitweak",
                code: JSX_IN_TS,
                message: `JSX needs a .tsx file — rename this script to "${baseName(scriptName)}.tsx"`,
                startLineNumber: a.lineNumber,
                startColumn: a.column,
                endLineNumber: a.lineNumber,
                endColumn: a.column + 1,
            },
        ]);
    }

    function filterCoveredMarkers(markers: TsMarkerData[]): TsMarkerData[] {
        return markers.filter((mk) => !(mk.code === "2307" && coveredMissingModule(mk.message)));
    }

    /** Write visible TypeScript markers; returns true when the model's visible markers changed. */
    function publishTypeScriptMarkers(m: TsModelLike, all: TsMarkerData[]): boolean {
        const visible = filterCoveredMarkers(all);
        const had = host.getModelMarkers(m.uri, TS_OWNER);
        if (!visible.length && !had.length) return false;
        if (visible.map(markerKey).join("\n") === had.map(markerKey).join("\n")) return false;
        host.setModelMarkers(m, TS_OWNER, visible);
        return true;
    }

    function categoryToSeverity(c: number): number {
        return c === 1 ? sev.Error : c === 0 ? sev.Warning : c === 2 ? sev.Hint : sev.Info;
    }

    function toMarkers(m: TsModelLike, diags: TsDiagnosticLike[], ignored: number[]): TsMarkerData[] {
        const ignore = ignored.length ? new Set(ignored) : null;
        return diags
            .filter((d) => !ignore?.has(d.code))
            .map((d) => {
                const start = d.start || 0;
                const length = d.length || 1;
                const a = m.getPositionAt(start);
                const b = m.getPositionAt(start + length);
                const tags: number[] = [];
                if (d.reportsUnnecessary) tags.push(tag.Unnecessary);
                if (d.reportsDeprecated) tags.push(tag.Deprecated);
                const relatedInformation = d.relatedInformation?.flatMap((r) => {
                    const target = r.file ? host.modelByUri(r.file.fileName) : m;
                    if (!target || target.isDisposed()) return [];
                    const rs = r.start || 0;
                    const rl = r.length || 1;
                    const ra = target.getPositionAt(rs);
                    const rb = target.getPositionAt(rs + rl);
                    return [
                        {
                            resource: target.uri,
                            message: flattenMessage(r.messageText),
                            startLineNumber: ra.lineNumber,
                            startColumn: ra.column,
                            endLineNumber: rb.lineNumber,
                            endColumn: rb.column,
                        },
                    ];
                });
                return {
                    severity: categoryToSeverity(d.category),
                    startLineNumber: a.lineNumber,
                    startColumn: a.column,
                    endLineNumber: b.lineNumber,
                    endColumn: b.column,
                    message: flattenMessage(d.messageText),
                    code: String(d.code),
                    ...(tags.length ? { tags } : {}),
                    ...(relatedInformation?.length ? { relatedInformation } : {}),
                };
            });
    }

    function liveScripts() {
        return [...entries.values()]
            .filter((e) => !e.model.isDisposed())
            .map((e) => ({ id: e.id, name: e.name, code: e.model.getValue(), model: e.model }));
    }

    function clearEditTimer(m: TsModelLike): void {
        const t = editTimers.get(m);
        if (t !== undefined) {
            clearTimeout(t);
            editTimers.delete(m);
        }
    }

    function untrackModel(m: TsModelLike): void {
        clearEditTimer(m);
        dirty.delete(m);
        modelToId.delete(m);
    }

    function onModelEdited(m: TsModelLike): void {
        if (inSyncBatch || disposed || m.isDisposed()) return;
        clearEditTimer(m);
        editTimers.set(
            m,
            setTimeout(() => {
                editTimers.delete(m);
                if (disposed || m.isDisposed()) return;
                const id = modelToId.get(m);
                const entry = id ? entries.get(id) : undefined;
                if (!entry) return;
                entry.syncedVersion = m.getVersionId();
                updateJsxMarker(m, entry.name);
                updateImportMarkers(m);
                updateLintMarkers(m);
                const live = liveScripts();
                dirty.add(m);
                for (const depId of dependantsOf(entry.name, live, "script")) {
                    const dep = entries.get(depId);
                    if (dep) dirty.add(dep.model);
                }
                epoch++;
                kickDrain();
            }, editDebounceMs)
        );
    }

    function applyDataFilesInternal(
        input: TsDataInput[],
        live: { id: string; name: string; code: string }[],
        toCheck: Set<TsModelLike>
    ): string[] {
        lastData = input;
        const want = new Map<string, string>();
        const nextDts = new Map<string, string>();
        for (const f of input) {
            if (isSvgPath(f.path) || isMarkdownPath(f.path) || isImageDataPath(f.path) || isGitignorePath(f.path)) continue;
            const decl = jsonDeclPath(f.path);
            const content = jsonModuleDts(f.text);
            nextDts.set(f.path, content);
            want.set("file:///" + decl, content);
            want.set(host.fileUri("/" + decl), content);
        }
        const changedPaths = new Set<string>();
        for (const [path, prev] of prevDataDts) if (nextDts.get(path) !== prev) changedPaths.add(path);
        for (const [path, cur] of nextDts) if (prevDataDts.get(path) !== cur) changedPaths.add(path);
        prevDataDts.clear();
        for (const [path, cur] of nextDts) prevDataDts.set(path, cur);

        const changedUris = putLibs(libs.data, want);
        if (entries.size) {
            for (const path of changedPaths) {
                for (const depId of dependantsOf(path, live, "data")) {
                    const dep = entries.get(depId);
                    if (dep) toCheck.add(dep.model);
                }
            }
        }
        return changedUris;
    }

    /** the bare-import stubs of the live scripts, at their models' folder URIs */
    function applyBareStubs(): string[] {
        const want = new Map<string, string>();
        for (const [path, text] of bareImportStubs(liveScripts(), lastData, typingFiles)) {
            const i = path.indexOf("/node_modules/");
            want.set(`file:///${path}`, text);
            want.set(host.fileUri("/" + path.slice(0, i)) + path.slice(i), text);
        }
        return putLibs(libs.bare, want);
    }

    function pickNextDirty(): TsModelLike | undefined {
        const active = host.getActiveModel();
        if (active && dirty.has(active)) return active;
        if (priorityModel && dirty.has(priorityModel)) return priorityModel;
        return dirty.values().next().value;
    }

    function kickDrain(): void {
        if (draining || drainScheduled || disposed || !dirty.size) return;
        drainScheduled = true;
        queueMicrotask(() => {
            drainScheduled = false;
            if (!disposed) void drain();
        });
    }

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    async function drain(): Promise<void> {
        if (draining || disposed) return;
        draining = true;
        try {
            while (dirty.size > 0 && !disposed) {
                for (const m of [...dirty]) {
                    if (m.isDisposed() || !modelToId.has(m)) dirty.delete(m);
                }
                if (!dirty.size) break;

                const myEpoch = epoch;
                const codes = [...entries.values()].filter((e) => !e.model.isDisposed()).map((e) => e.model.getValue());

                await Promise.all([initialPkgTypings, ensureBuiltins(codes)]);

                if (disposed) return;
                if (epoch !== myEpoch) continue;
                if (applyBareStubs().length) continue;

                if (extraLibsDirty) {
                    extraLibsDirty = false;
                    await host.flushExtraLibs();
                    if (disposed) return;
                    if (epoch !== myEpoch || extraLibsDirty) continue;
                }

                const allUris = [...entries.values()].filter((e) => !e.model.isDisposed()).map((e) => e.model.uri);
                if (!allUris.length) {
                    dirty.clear();
                    break;
                }

                let worker: TsWorkerLike;
                try {
                    worker = await host.getWorker(allUris);
                } catch {
                    if (epoch !== myEpoch) continue;
                    if (++workerRetries <= 2) {
                        await sleep(100);
                        continue;
                    }
                    break;
                }
                workerRetries = 0;
                if (disposed) return;
                if (epoch !== myEpoch) continue;

                while (dirty.size > 0 && epoch === myEpoch && !extraLibsDirty && !disposed) {
                    const m = pickNextDirty();
                    if (!m) break;
                    dirty.delete(m);
                    if (m.isDisposed() || !modelToId.has(m)) continue;

                    const version = m.getVersionId();
                    const uri = m.uri.toString();
                    let raw: TsDiagnosticLike[];
                    try {
                        const [syn, sem, sug] = await Promise.all([
                            worker.getSyntacticDiagnostics(uri),
                            worker.getSemanticDiagnostics(uri),
                            worker.getSuggestionDiagnostics ? worker.getSuggestionDiagnostics(uri) : Promise.resolve([]),
                        ]);
                        raw = [...syn, ...sem, ...sug];
                    } catch {
                        if (!m.isDisposed() && modelToId.has(m)) {
                            if (epoch !== myEpoch) dirty.add(m);
                            else if ((modelRetries.get(m) ?? 0) < 2) {
                                modelRetries.set(m, (modelRetries.get(m) ?? 0) + 1);
                                dirty.add(m);
                                await sleep(50);
                            }
                        }
                        break;
                    }

                    if (disposed || m.isDisposed() || !modelToId.has(m)) continue;
                    if (epoch !== myEpoch || extraLibsDirty || m.getVersionId() !== version) {
                        dirty.add(m);
                        continue;
                    }

                    modelRetries.delete(m);
                    const markers = toMarkers(m, raw, host.ignoredCodes?.() ?? []);
                    rawMarkers.set(m, markers);
                    checkedVersion.set(m, version);
                    publishTypeScriptMarkers(m, markers);
                    host.onChecked();
                }
            }
        } finally {
            draining = false;
            if (!disposed && dirty.size > 0) kickDrain();
        }
    }

    return {
        sync(mutateModels, getScripts, getDataFiles): string[] {
            inSyncBatch = true;
            try {
                mutateModels();
            } finally {
                inSyncBatch = false;
            }

            const hadEntries = entries.size > 0;
            const nextScripts = getScripts();
            const nextById = new Map(nextScripts.map((s) => [s.id, s]));
            const toCheck = new Set<TsModelLike>();
            const invalidatedNames = new Set<string>();
            const markerRefresh: { model: TsModelLike; name: string }[] = [];
            let structuralChange = false;

            for (const [id, prev] of [...entries]) {
                const next = nextById.get(id);
                if (!next) {
                    prev.sub.dispose();
                    untrackModel(prev.model);
                    entries.delete(id);
                    invalidatedNames.add(prev.name);
                    structuralChange = true;
                } else if (next.model !== prev.model) {
                    prev.sub.dispose();
                    untrackModel(prev.model);
                    clearEditTimer(next.model);
                    const sub = next.model.onDidChangeContent(() => onModelEdited(next.model));
                    entries.set(id, { id, name: next.name, model: next.model, syncedVersion: next.model.getVersionId(), sub });
                    modelToId.set(next.model, id);
                    toCheck.add(next.model);
                    invalidatedNames.add(prev.name);
                    invalidatedNames.add(next.name);
                    markerRefresh.push({ model: next.model, name: next.name });
                    structuralChange = true;
                }
            }

            for (const next of nextScripts) {
                const prev = entries.get(next.id);
                if (!prev) {
                    const sub = next.model.onDidChangeContent(() => onModelEdited(next.model));
                    entries.set(next.id, { id: next.id, name: next.name, model: next.model, syncedVersion: next.model.getVersionId(), sub });
                    modelToId.set(next.model, next.id);
                    toCheck.add(next.model);
                    if (hadEntries) invalidatedNames.add(next.name);
                    markerRefresh.push({ model: next.model, name: next.name });
                    structuralChange = true;
                } else if (prev.name !== next.name || prev.syncedVersion !== next.model.getVersionId()) {
                    clearEditTimer(next.model);
                    const oldName = prev.name;
                    prev.name = next.name;
                    prev.syncedVersion = next.model.getVersionId();
                    toCheck.add(next.model);
                    invalidatedNames.add(next.name);
                    if (oldName !== next.name) invalidatedNames.add(oldName);
                    markerRefresh.push({ model: next.model, name: next.name });
                    structuralChange = true;
                }
            }

            const live = liveScripts();
            for (const name of invalidatedNames) {
                for (const depId of dependantsOf(name, live, "script")) {
                    const dep = entries.get(depId);
                    if (dep) toCheck.add(dep.model);
                }
            }

            const changedDeclUris = applyDataFilesInternal(getDataFiles(), live, toCheck);

            for (const { model, name } of markerRefresh) {
                updateJsxMarker(model, name);
                updateImportMarkers(model);
                updateLintMarkers(model);
            }

            if (structuralChange) epoch++;
            for (const m of toCheck) dirty.add(m);
            kickDrain();
            return changedDeclUris;
        },

        setDataFiles(dataFiles): string[] {
            const toCheck = new Set<TsModelLike>();
            const changedDeclUris = applyDataFilesInternal(dataFiles, liveScripts(), toCheck);
            for (const m of toCheck) dirty.add(m);
            kickDrain();
            return changedDeclUris;
        },

        prioritize(model): void {
            priorityModel = model;
        },

        isChecked(model): boolean {
            return checkedVersion.get(model) === model.getVersionId();
        },

        dispose(): void {
            disposed = true;
            for (const t of editTimers.values()) clearTimeout(t);
            editTimers.clear();
            for (const e of entries.values()) e.sub.dispose();
            entries.clear();
            modelToId.clear();
            dirty.clear();
            storeSub.dispose();
            for (const group of Object.values(libs)) {
                for (const s of group.values()) s.lib.dispose();
                group.clear();
            }
        },
    };
}

/** where a package URL's declarations start in the typings mirror: its pointer, else the file TypeScript finds by itself */
function typesEntry(files: Record<string, string>, url: string): string | undefined {
    const dir = `unpkg.com/${url.slice(PACKAGE_ORIGIN.length)}`;
    let types: unknown;
    try {
        types = JSON.parse(files[`${dir}/package.json`] ?? "null")?.types;
    } catch {}
    const entry = typeof types === "string" ? normalizePath(`${dir}/${types}`) : undefined;
    return entry && entry in files ? entry : declarationCandidates(dir).find((c) => c in files);
}

/**
 * `<bundle>/node_modules/<spec>/package.json` stubs (path → text) pointing
 * each bare import of a bundle file at its dependency's downloaded typings,
 * so `import { zip } from "fflate"` type-checks.
 */
export function bareImportStubs(scripts: Iterable<{ name: string; code: string }>, data: TsDataInput[], typings: Record<string, string>): Map<string, string> {
    const read = dataReader(data);
    const out = new Map<string, string>();
    for (const s of scripts) {
        for (const spec of importSpecs(s.code)) {
            const r = bareImport(s.name, spec, read);
            const entry = r && "url" in r ? typesEntry(typings, r.url) : undefined;
            if (!entry) continue;
            const folder = `${r!.pkgPath.slice(0, r!.pkgPath.lastIndexOf("/") + 1)}node_modules/${spec}`;
            out.set(`${folder}/package.json`, JSON.stringify({ types: relativePath(folder, `${TYPINGS_ROOT}/${entry}`) }));
        }
    }
    return out;
}

/** Production adapter wiring `createTsWorkspace` to Monaco and `chrome.storage.local`. */
export function createMonacoTsWorkspace(opts: {
    monaco: any;
    getActiveModel: () => any;
    onChecked: () => void;
}): TsWorkspace {
    const { monaco, getActiveModel, onChecked } = opts;
    const tsDefaults = monaco.languages.typescript.typescriptDefaults;
    return createTsWorkspace({
        addExtraLib: (content, uri) => tsDefaults.addExtraLib(content, uri),
        flushExtraLibs: () => new Promise((r) => setTimeout(r, 0)),
        fileUri: (path) => monaco.Uri.file(path).toString(),
        getWorker: async (uris) => (await monaco.languages.typescript.getTypeScriptWorker())(...uris),
        getActiveModel,
        modelByUri: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)),
        getModelMarkers: (uri, owner) => monaco.editor.getModelMarkers({ resource: uri, owner }),
        setModelMarkers: (model, owner, markers) => monaco.editor.setModelMarkers(model, owner, markers),
        fetchBuiltinTypes: () => fetch(chrome.runtime.getURL("lib/builtin-types.json")).then((r) => r.json()),
        loadPackageTypings: () =>
            new Promise<Record<string, string>>((resolve) =>
                chrome.storage.local.get(PACKAGE_TYPINGS_KEY, (d) => {
                    void chrome.runtime.lastError;
                    resolve((d?.[PACKAGE_TYPINGS_KEY] as StoredTypings | undefined)?.files ?? {});
                })
            ),
        subscribePackageStore: (onChange) => {
            const listener = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
                if (area !== "local" || !(c[PACKAGE_MODULES_KEY] || c[PACKAGE_TYPINGS_KEY])) return;
                const typings = c[PACKAGE_TYPINGS_KEY] ? ((c[PACKAGE_TYPINGS_KEY].newValue as StoredTypings | undefined)?.files ?? {}) : undefined;
                onChange(typings);
            };
            chrome.storage.onChanged.addListener(listener);
            return { dispose: () => chrome.storage.onChanged.removeListener(listener) };
        },
        onChecked,
        ignoredCodes: () => tsDefaults.getDiagnosticsOptions()?.diagnosticCodesToIgnore ?? [],
        severity: monaco.MarkerSeverity,
        markerTag: monaco.MarkerTag,
    });
}
