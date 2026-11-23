/**
 * Progress of a long store change, a folder sync pass or an Import, as the
 * background reports it to the Editor (a `{ type: "progress" }` UI-port
 * message). The work runs in steps: list what's there, read it, save it,
 * then compile every script once.
 */

/** which long change: a folder sync pass, or the Editor's Import… */
export type ProgressTask = "sync" | "import";

/**
 * - `listing`: finding the files (`done` counts them; no `total` yet)
 * - `reading`: reading them (`done` of `total`)
 * - `saving`: storing the data files and folders (`done` of `total`)
 * - `compiling`: compiling the `total` scripts together
 */
export type ProgressPhase = "listing" | "reading" | "saving" | "compiling";

/** a step of the work; `phase: null` when it's over */
export type ProgressMessage =
    | {
          type: "progress";
          task: ProgressTask;
          phase: ProgressPhase;
          done: number;
          /** 0 while unknown */
          total: number;
      }
    | { type: "progress"; task: ProgressTask; phase: null };

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const scripts = (n: number) => `${n} ${n === 1 ? "script" : "scripts"}`;

/** the one-line text the Editor shows for a step */
export function progressText(p: Exclude<ProgressMessage, { phase: null }>): string {
    switch (p.phase) {
        case "listing":
            return `Listing files (${p.done} so far)`;
        case "reading":
            return `Reading ${p.done} of ${files(p.total)}`;
        case "saving":
            return `${p.task === "import" ? "Importing" : "Saving"} ${p.done} of ${p.total}`;
        case "compiling":
            return `Compiling ${scripts(p.total)}`;
    }
}
