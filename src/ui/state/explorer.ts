import { proxy, ref } from "valtio";
import { allFolders, ancestorFolders, isInFolder } from "../../shared/folders";
import type { ScriptHealthInput } from "../../shared/scriptHealth";
import type { ScriptRole } from "../../shared/tweakBundle";
import type { Script } from "../../background/engine/scriptStore";
import type { DataFile } from "../../background/engine/dataFiles";
import { explorerTree, folderRowId, idRange, targetFolder, topLevelRows, type TreeRow } from "../explorerTree";

/** the settings.json virtual row (always first in the Explorer) */
export const SETTINGS_ID = "__settings__";
/** a tweak's data folder file (`atlas/.tweak/settings.json`): a virtual row, rendered from storage */
const TWEAK_DATA = "tdata:";
export const tweakDataId = (path: string): string => TWEAK_DATA + path;
export const isTweakDataId = (id: string | null | undefined): boolean => !!id?.startsWith(TWEAK_DATA);
export const tweakDataPathOf = (id: string): string => id.slice(TWEAK_DATA.length);
/** a tweak's `.tweak/stores` row (`root`: "atlas/"): closed until opened, then its stores show under it */
const TWEAK_STORES = "tstores:";
export const tweakStoresId = (root: string): string => TWEAK_STORES + root;
export const isTweakStoresId = (id: string | null | undefined): boolean => !!id?.startsWith(TWEAK_STORES);
export const tweakStoresRootOf = (id: string): string => id.slice(TWEAK_STORES.length);
/** rows that aren't tree items (no selecting, moving, renaming): settings.json and the tweaks' data folder files */
export const isVirtualRootId = (id: string | null | undefined): boolean => id === SETTINGS_ID || isTweakDataId(id) || isTweakStoresId(id);

export type ExplorerScript = Script & Partial<ScriptHealthInput> & { routeWarnings?: string[] } & Partial<Pick<ScriptRole, "role" | "entry">>;
export type NewKind = "script" | "data" | "folder" | "tweak";
export type MenuItem = { label: string; key?: string; run: () => void } | null;

/** the inline name input: renaming a row, or naming a new item in `folder` */
export type Editing = { mode: "rename"; id: string; refocusList: boolean } | { mode: "create"; kind: NewKind; folder: string };

const COLLAPSED_KEY = "wtExplorerCollapsed"; // the extension's former name (Wiretrick): kept so stored data survives

function loadCollapsed(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}

/**
 * The Explorer: what editor.ts loaded (scripts, data files, folders, the open
 * file) and the tree's own state (cursor, multi-selection, collapsed folders,
 * the inline name input, the context menu).
 */
export const explorer = proxy({
    scripts: ref([]) as readonly ExplorerScript[],
    dataFiles: ref([]) as readonly DataFile[],
    folders: ref([]) as readonly string[],
    /** the tweaks' data folder files; `root`: the tweak's folder ("atlas/") */
    tweakData: ref([]) as readonly { path: string; root: string }[],
    /** the open file */
    selectedId: null as string | null,
    /** tt-api.d.ts is shown over the open file (no row is the open file) */
    typingsShown: false,
    /** the open file has unsaved changes */
    dirty: false,
    /** keyboard cursor (VS Code's "focused" row); null = follow the open file */
    focusedId: null as string | null,
    /** bumped when the cursor moves, to scroll it into view */
    cursorMoves: 0,
    /** the multi-selection (⌘/Ctrl-click, Shift-click, Shift+↑/↓); fewer than 2 = just the cursor row */
    sel: ref(new Set<string>()) as ReadonlySet<string>,
    /** where a Shift range starts (null: the cursor) */
    selAnchor: null as string | null,
    /** data files whose JSON has errors (their name shows red, like a script's) */
    jsonErrorIds: ref(new Set<string>()) as ReadonlySet<string>,
    /** collapsed folder paths (persisted, like VS Code's) */
    collapsed: ref(new Set(loadCollapsed())) as ReadonlySet<string>,
    /** tweak folders ("atlas/") whose `.tweak/stores` row is open */
    openStores: ref(new Set<string>()) as ReadonlySet<string>,
    /** the section's header chevron */
    sectionOpen: true,
    editing: null as Editing | null,
    menu: null as { x: number; y: number; items: MenuItem[] } | null,
});

export interface ExplorerData {
    scripts: readonly ExplorerScript[];
    dataFiles: readonly DataFile[];
    folders: readonly string[];
    selectedId: string | null;
    typingsShown: boolean;
    dirty: boolean;
}

/** editor.ts's state → the tree (forgets selected rows that are gone) */
export function syncExplorer(d: ExplorerData): void {
    explorer.scripts = ref([...d.scripts]);
    explorer.dataFiles = ref([...d.dataFiles]);
    explorer.folders = ref([...d.folders]);
    explorer.selectedId = d.selectedId;
    explorer.typingsShown = d.typingsShown;
    explorer.dirty = d.dirty;
    if (explorer.sel.size || explorer.editing?.mode === "rename") {
        const all = new Set(treeRows(true).map((r) => r.id));
        if ([...explorer.sel].some((id) => !all.has(id))) explorer.sel = ref(new Set([...explorer.sel].filter((id) => all.has(id))));
        const e = explorer.editing;
        if (e?.mode === "rename" && !visibleRows().some((r) => r.id === e.id)) explorer.editing = null;
    }
}

export const everyFolder = (): string[] => allFolders([...explorer.folders], [...explorer.scripts.map((s) => s.meta.name), ...explorer.dataFiles.map((d) => d.path)]);

/** the tree's rows; `all`: collapsed folders' contents too */
export const treeRows = (all = false): TreeRow[] =>
    explorerTree({ scripts: explorer.scripts.map((s) => ({ id: s.id, name: s.meta.name })), dataFiles: [...explorer.dataFiles], folders: [...explorer.folders], collapsed: explorer.collapsed, all });

/** the rows shown (not the contents of collapsed folders) */
export const visibleRows = (): TreeRow[] => treeRows();

/** a row by id, shown or inside a collapsed folder */
export const treeRow = (id: string | null): TreeRow | undefined => (id ? treeRows(true).find((r) => r.id === id) : undefined);

/** the data folder files shown right inside the tweak folder `root` ("atlas/"; "" the root) */
export const tweakDataIn = (root: string): { id: string; path: string }[] =>
    explorer.tweakData.filter((d) => d.root === root).map((d) => ({ id: tweakDataId(d.path), path: d.path }));

/** a data folder file under `.tweak/stores/` (not the tweak's settings.json) */
export const isTweakStorePath = (root: string, path: string): boolean => path.slice(root.length).split("/").length > 2;

/** `root`'s data folder: its files, then its stores (shown under the `.tweak/stores` row) */
export function tweakDataGroups(root: string): { files: { id: string; path: string }[]; stores: { id: string; path: string }[] } {
    const all = tweakDataIn(root);
    return { files: all.filter((d) => !isTweakStorePath(root, d.path)), stores: all.filter((d) => isTweakStorePath(root, d.path)) };
}

/** the shown data folder rows of `root`: its files, the `.tweak/stores` row, and its stores when open */
const tweakDataRowIds = (root: string): string[] => {
    const { files, stores } = tweakDataGroups(root);
    return [...files.map((d) => d.id), ...(stores.length ? [tweakStoresId(root), ...(explorer.openStores.has(root) ? stores.map((d) => d.id) : [])] : [])];
};

/** the rows' ids, settings.json first, each expanded tweak folder's data files right after it */
export const explorerIds = (): string[] => [SETTINGS_ID, ...tweakDataRowIds(""), ...visibleRows().flatMap((r) => [r.id, ...(r.kind === "folder" && r.expanded ? tweakDataRowIds(r.path + "/") : [])])];

export function setStoresOpen(root: string, open: boolean): void {
    if (open === explorer.openStores.has(root)) return;
    const next = new Set(explorer.openStores);
    if (open) next.add(root);
    else next.delete(root);
    explorer.openStores = ref(next);
}

/** show a data folder file: open its folders and, for a store, its `.tweak/stores` row */
export function revealTweakData(path: string): void {
    const d = explorer.tweakData.find((x) => x.path === path);
    if (!d) return;
    if (d.root) revealInExplorer(d.root);
    if (isTweakStorePath(d.root, path)) setStoresOpen(d.root, true);
}

/** the ids a multi-selection can hold (settings.json and data folder files aren't selectable items) */
export const selectableIds = (): string[] => visibleRows().map((r) => r.id);

/** the row the cursor is on */
export const cursorId = (): string | null => explorer.focusedId ?? explorer.selectedId;

// ---- folders ----
export function setCollapsed(next: ReadonlySet<string>): void {
    explorer.collapsed = ref(new Set(next));
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
}

/** forget the state of folders that are gone */
export function pruneCollapsed(): void {
    const all = new Set(everyFolder());
    if ([...explorer.collapsed].some((f) => !all.has(f))) setCollapsed(new Set([...explorer.collapsed].filter((f) => all.has(f))));
}

export function setFolderExpanded(path: string, expanded: boolean): void {
    if (expanded === !explorer.collapsed.has(path)) return;
    const next = new Set(explorer.collapsed);
    if (expanded) next.delete(path);
    else next.add(path);
    setCollapsed(next);
}

/** expand the folders `path` is in (VS Code reveals the file it opens) */
export function revealInExplorer(path: string): void {
    const shut = ancestorFolders(path).filter((f) => explorer.collapsed.has(f));
    if (shut.length) setCollapsed(new Set([...explorer.collapsed].filter((f) => !shut.includes(f))));
}

/** expand or collapse `folder` and every subfolder inside it (`""` = every folder in the explorer) */
export function setSubtreeExpanded(folder: string, expanded: boolean): void {
    const match = (f: string): boolean => !folder || f.toLowerCase() === folder.toLowerCase() || isInFolder(f, folder);
    const next = new Set(explorer.collapsed);
    for (const f of everyFolder()) {
        if (!match(f)) continue;
        if (expanded) next.delete(f);
        else next.add(f);
    }
    setCollapsed(next);
    if (!expanded) {
        const cur = treeRow(cursorId());
        const top = cur ? ancestorFolders(cur.path).find((f) => next.has(f)) : undefined;
        if (top) explorer.focusedId = folderRowId(top);
    }
}

export function collapseAll(): void {
    setSubtreeExpanded("", false);
}

// ---- cursor and multi-selection ----
export function moveFocus(id: string): void {
    explorer.focusedId = id;
    explorer.cursorMoves++;
}

export function clearSel(): void {
    explorer.sel = ref(new Set());
    explorer.selAnchor = null;
}

export function setSel(ids: Iterable<string>, anchor: string | null = explorer.selAnchor): void {
    explorer.sel = ref(new Set(ids));
    explorer.selAnchor = anchor;
}

/** Shift-click / Shift+↑↓: select from the anchor (default: the cursor) to `id`; `add` keeps what was selected */
export function selectRange(id: string, add = false): void {
    const cur = cursorId();
    const anchor = explorer.selAnchor ?? (cur && !isVirtualRootId(cur) ? cur : id);
    setSel([...(add ? explorer.sel : []), ...idRange(selectableIds(), anchor, id)], anchor);
    moveFocus(id);
}

/** ⌘/Ctrl-click: add `id` to the selection (with the cursor row, when starting one) or take it out */
export function toggleSel(id: string): void {
    const cur = cursorId();
    const next = explorer.sel.size < 2 ? new Set(cur && !isVirtualRootId(cur) && treeRow(cur) ? [cur] : []) : new Set(explorer.sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next, id);
    moveFocus(id);
}

/** what an action on row `id` applies to: the multi-selection when `id` is in it (not what's inside its selected folders), else that row */
export function actionRows(id: string): TreeRow[] {
    if (explorer.sel.size > 1 && explorer.sel.has(id)) return topLevelRows(treeRows(true).filter((r) => explorer.sel.has(r.id)));
    const row = treeRow(id);
    return row ? [row] : [];
}

// ---- the inline name input ----
/** Inline rename (double-click a name, or F2); `refocusList`: the tree gets the focus back after. */
export function startRename(id: string, refocusList = false): void {
    if (treeRow(id)) explorer.editing = { mode: "rename", id, refocusList };
}

/**
 * New Tweak / New Module / New JSON File / New Folder: an inline name input in `folder`
 * (default: the focused folder, or the focused file's folder), as in VS Code.
 */
export function startCreate(kind: NewKind, folder = targetFolder(treeRow(cursorId()))): void {
    if (explorer.editing) return;
    explorer.sectionOpen = true;
    if (folder) revealInExplorer(folder + "/");
    explorer.editing = { mode: "create", kind, folder };
}
