/**
 * Which import specifiers name a built-in module (the extension's own
 * valtio and React, src/shared/builtins.ts, and "tangitweak": each file's
 * `tweak`, shared/tweakApi.ts). Pure, so the Editor, the page hook and the
 * download step can ask without loading the modules.
 */
import { TWEAK_MODULE } from "./tweakApi";

export const REACT_BUILTINS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] as const;
export const VALTIO_BUILTINS = ["valtio", "valtio/vanilla", "valtio/utils", "valtio/vanilla/utils", "valtio/react", "valtio/react/utils"] as const;
export const ALL_BUILTINS: readonly string[] = [...REACT_BUILTINS, ...VALTIO_BUILTINS, TWEAK_MODULE];

/** where the built-ins' typings (lib/builtin-types.json, keyed like node_modules) go under `root`, by tsconfig `paths` */
export function builtinPaths(root: string): Record<string, string[]> {
    return {
        valtio: [`${root}/valtio/esm/index.d.mts`],
        "valtio/*": [`${root}/valtio/esm/*.d.mts`],
        react: [`${root}/@types/react/index.d.ts`],
        "react/*": [`${root}/@types/react/*.d.ts`],
        "react-dom": [`${root}/@types/react-dom/index.d.ts`],
        "react-dom/*": [`${root}/@types/react-dom/*.d.ts`],
        csstype: [`${root}/csstype/index.d.ts`],
    };
}

/** the built-in a specifier names — bare (`valtio/react`) or an esm.sh URL of any version — or null */
export function builtinSpec(spec: string): string | null {
    return builtinSpecIn(spec, ALL_BUILTINS);
}

/** builtinSpec with the list passed in: self-contained, the ESLint plugin embeds its source (generatedFiles) */
export function builtinSpecIn(spec: string, all: readonly string[]): string | null {
    if (all.includes(spec)) return spec;
    const m = /^https:\/\/esm\.sh\/(?:v\d+\/)?(react|react-dom|valtio)(?:@[^/?#]*)?((?:\/[^?#]*)?)(?:[?#].*)?$/.exec(spec);
    if (!m) return null;
    const name = m[1] + (m[2] || "").replace(/\/$/, "");
    return all.includes(name) ? name : null;
}

/** does the built-in need React (rather than only valtio's vanilla parts)? */
export function builtinNeedsReact(name: string, code = ""): boolean {
    if (name.startsWith("react")) return true;
    if (name === "valtio/react" || name === "valtio/react/utils") return true;
    // `valtio` and `valtio/utils` include the hooks; React loads only if the code uses them
    return (name === "valtio" || name === "valtio/utils") && /\buse(?:Snapshot|Proxy)\b/.test(code);
}

/** the file's `/** @jsxImportSource <name> *\/` pragma, or null */
export function jsxPragma(code: string): string | null {
    const m = /@jsxImportSource\s+([^\s*]+)/.exec(code);
    return m ? m[1] : null;
}

/** where a file's JSX runtime comes from: its pragma, else the built-in React */
export const jsxImportSource = (code: string): string => jsxPragma(code) ?? "react";

/**
 * Does the file (likely) contain JSX? A heuristic for the import scan and
 * the Editor's language mode (the compiler tries JSX anyway): a pragma, or
 * an element/fragment opening in expression position plus a closing tag.
 */
export function usesJsx(code: string): boolean {
    return !!jsxPragma(code) || jsxElementAt(code) >= 0;
}

/** offset of the first (likely) JSX element's `<`, or -1 */
export function jsxElementAt(code: string): number {
    const m = /(?:^|[=(,:?&|{}[;]|\breturn|=>)\s*(<)(?:[A-Za-z][\w.:-]*|>)/m.exec(code);
    return m && /<\/[\w.:-]*>|\/>/.test(code) ? m.index + m[0].lastIndexOf("<", m[0].length - 1) : -1;
}
