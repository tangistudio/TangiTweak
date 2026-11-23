import { createFolder, deleteDataFile, deleteScript, holdingChanges, saveDataFile, saveScriptsBatch } from "./scriptStore";
import { progressReporter } from "./progress";

/** what the Editor's Import… applies, already picked and matched to the existing files */
export interface ImportRequest {
    /** new folders, empty ones included */
    folders: string[];
    /** `id`: the data file it replaces */
    dataFiles: { id?: string; path: string; text: string }[];
    /** `id`: the script it replaces, or a new id */
    scripts: { id: string; name: string; code: string }[];
    /** a package's files its new version doesn't have */
    deletes: { kind: "script" | "data"; id: string; path: string }[];
}

/**
 * Import files as one change: folders and data files first, then every
 * script compiled together (against them), then the deletions; the store
 * announces it once, so open tabs only get the finished state. Reports
 * its steps to the Editor. Resolves with what failed (the rest applies).
 */
export async function importFiles(req: ImportRequest): Promise<{ failed: string[] }> {
    const progress = progressReporter("import");
    const failed: string[] = [];
    const why = (e: any) => String(e?.message || e);
    try {
        await holdingChanges(async () => {
            const total = req.folders.length + req.dataFiles.length;
            let done = 0;
            for (const f of req.folders) {
                progress.step("saving", done++, total);
                await createFolder(f).catch((e) => failed.push(why(e)));
            }
            for (const d of req.dataFiles) {
                progress.step("saving", done++, total);
                await saveDataFile(d).catch((e) => failed.push(why(e)));
            }
            if (total) progress.step("saving", total, total);
            if (req.scripts.length) {
                progress.step("compiling", 0, req.scripts.length);
                await saveScriptsBatch(req.scripts);
            }
            for (const f of req.deletes) {
                await (f.kind === "script" ? deleteScript(f.id) : deleteDataFile(f.id)).catch((e) => failed.push(`can't delete "${f.path}": ${why(e)}`));
            }
        });
    } finally {
        progress.end();
    }
    return { failed };
}
