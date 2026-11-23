/**
 * Script parameters: the defs a tweak passes to `tweak.params({...})` and the
 * helpers that resolve, validate, store and parse their values.
 *
 * Values are edited in the manager, the popup and settings.json; the
 * background stores them (`background/engine/scriptStore.ts`) and the
 * compilers resolve them with {@link resolveParamValues}. Handler code can
 * assign them too (`shared/paramsProxy.ts`).
 *
 * The public mirror of these types, with examples for tweak authors, is
 * `TangiTweak.ParamDef` in `src/types/tt-api.d.ts`.
 *
 * @module
 */

import { isShortcut } from "./shortcut";

/** An on/off switch: a checkbox. */
export interface ParamDefBoolean {
    /** Picks this kind of param. A stored value that isn't a boolean falls back to the default. */
    type: "boolean";
    /** The value until the user changes it. Default `false`. */
    default?: boolean;
    /** Shown next to the control and in settings.json. */
    description?: string;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}).
     */
    parse?: (raw: boolean) => unknown;
}
/** A number: a number input. */
export interface ParamDefNumber {
    /** Picks this kind of param. A stored value that isn't a finite number falls back to the default. */
    type: "number";
    /** The value until the user changes it. Default `0`. */
    default?: number;
    /** Shown next to the control and in settings.json. */
    description?: string;
    /** Optional lower bound: the UI clamps typed values. A stored value below it is still valid. */
    min?: number;
    /** Optional upper bound: the UI clamps typed values. A stored value above it is still valid. */
    max?: number;
    /** Step for the number input. Default `1`; use e.g. `0.1` for decimals. */
    step?: number;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}).
     */
    parse?: (raw: number) => unknown;
}
/** Free text: a text input or a textarea. */
export interface ParamDefString {
    /** Picks this kind of param. A stored value that isn't a string falls back to the default. */
    type: "string";
    /** Edit in a textarea instead of a one-line input. */
    multiline?: boolean;
    /** The value until the user changes it. Default `""`. */
    default?: string;
    /** Shown next to the control and in settings.json. */
    description?: string;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}).
     */
    parse?: (raw: string) => unknown;
}
/** One of fixed choices: a dropdown. */
export interface ParamDefEnum {
    /** Picks this kind of param. A stored value not among `choices` falls back to the default. */
    type: "enum";
    /** The allowed values; the param is typed as their union. Without a `choices` array the script fails to compile. */
    choices: string[];
    /** The value until the user changes it. Default: the first choice (`""` when `choices` is empty). */
    default?: string;
    /** Shown next to the control and in settings.json. */
    description?: string;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}).
     */
    parse?: (raw: string) => unknown;
}
/** A list of strings: one entry per line. */
export interface ParamDefStringList {
    /** Picks this kind of param. A stored value that isn't a list of strings falls back to the default. */
    type: "stringList";
    /** The value until the user changes it. Default `[]`. */
    default?: string[];
    /** Shown next to the control and in settings.json. */
    description?: string;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}). It gets a copy of the list.
     */
    parse?: (raw: string[]) => unknown;
}
/** Keys for `ctx.shortcut`: recorded as the user presses them. */
export interface ParamDefShortcut {
    /** Picks this kind of param. A stored value that isn't a shortcut falls back to the default. */
    type: "shortcut";
    /**
     * The keys as `ctx.shortcut` takes them (`"Mod+Shift+K"`) or `""` (the
     * default) for none. A default that isn't a shortcut is a script error.
     */
    default?: string;
    /** Shown next to the control and in settings.json. */
    description?: string;
    /**
     * Turns the raw value into what the script receives: the param's type
     * becomes this function's return type. Never stored or serialized
     * ({@link serializableParamDef}). A throw is a script error naming the
     * param ({@link parseParamValue}).
     */
    parse?: (raw: string) => unknown;
}
/** Every param `type`, in the order the defs above are declared. */
export const PARAM_TYPES = ["boolean", "number", "string", "enum", "stringList", "shortcut"] as const;

/** One adjustable parameter, discriminated by `type`. */
export type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList | ParamDefShortcut;

/** A nested section grouping parameters (or sub-sections) in the UI and settings.json. */
export interface ParamGroup {
    [key: string]: ParamNode;
}
/** One entry of a param tree: a param or a section. */
export type ParamNode = ParamDef | ParamGroup;
/** The defs a tweak passes to `tweak.params`, keyed by name; sections nest. */
export type ParamTree = Record<string, ParamNode>;

/** The raw (stored, edited) value type of a param def: what `parse` receives. */
export type ParamRawValue<D extends ParamDef> = D extends ParamDefBoolean
    ? boolean
    : D extends ParamDefNumber
      ? number
      : D extends ParamDefString
        ? string
        : D extends ParamDefEnum
          ? D["choices"][number]
          : D extends ParamDefStringList
            ? string[]
            : D extends ParamDefShortcut
              ? string
              : never;

/** What the script sees for a param def: `parse`'s return type when the def has one, else its {@link ParamRawValue}. */
export type ParamValue<D extends ParamDef> = D extends {
    /** The def's parser, whose return type `R` is the param's type. */
    parse: (raw: never) => infer R;
} ? R : ParamRawValue<D>;

/**
 * `true` when a {@link ParamsOf} entry is read-only from code: a param with
 * `parse` (code sees the parsed value, not the stored one) or a section
 * (assign to its params instead).
 */
type IsReadonlyParam<V> = V extends ParamDef ? (V extends {
    /** Any parser makes the param read-only. */
    parse: Function;
} ? true : false) : true;
/** The value of one {@link ParamsOf} entry: a param's {@link ParamValue} or a section's own {@link ParamsOf}. */
type ParamEntryValue<V> = V extends ParamDef ? ParamValue<V> : V extends ParamGroup ? ParamsOf<V> : never;

/**
 * Resolved parameter values, typed from the defs and nested sections.
 *
 * Params are assignable from handler code (`shared/paramsProxy.ts`), except
 * params with `parse` and the section objects themselves.
 */
export type ParamsOf<T extends ParamGroup> = {
    -readonly [K in keyof T as IsReadonlyParam<T[K]> extends false ? K : never]: ParamEntryValue<T[K]>;
} & {
    readonly [K in keyof T as IsReadonlyParam<T[K]> extends true ? K : never]: ParamEntryValue<T[K]>;
};

const isPlainObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether a value is a param def: a plain object whose `type` is one of {@link PARAM_TYPES}. */
export function isParamDef(v: unknown): v is ParamDef {
    return isPlainObj(v) && typeof v.type === "string" && (PARAM_TYPES as readonly string[]).includes(v.type);
}

/**
 * Whether a value is a section: a plain object that isn't a param def and has
 * no string `type`. An object with an unknown `type` is neither.
 */
export function isParamGroup(v: unknown): v is ParamGroup {
    return isPlainObj(v) && !isParamDef(v) && typeof v.type !== "string";
}

/**
 * A param's default value: its `default`, else `false`, `0`, `""`, the first
 * choice (`""` without choices), `[]` or `""` (no shortcut), by type.
 *
 * The def's `default` is returned as it is, without
 * {@link isValidParamValue}.
 */
export function paramDefault(def: ParamDef): any {
    if (def.default !== undefined) return def.default;
    switch (def.type) {
        case "boolean":
            return false;
        case "number":
            return 0;
        case "string":
            return "";
        case "enum":
            return def.choices[0] ?? "";
        case "stringList":
            return [];
        case "shortcut":
            return "";
    }
}

/**
 * Merges stored values over the defaults, recursively across sections.
 *
 * A stored value that isn't valid for its def ({@link isValidParamValue}) or
 * is missing falls back to {@link paramDefault}. Stored keys without a def
 * are dropped.
 *
 * @param defs The script's param tree.
 * @param stored The values the user saved, nested like `defs`.
 * @returns The raw value of every param, nested like `defs`.
 */
export function resolveParamValues(defs: ParamTree, stored: Record<string, any> | undefined): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, node] of Object.entries(defs)) {
        if (isParamDef(node)) {
            const v = stored?.[key];
            out[key] = isValidParamValue(node, v) ? v : paramDefault(node);
        } else if (isParamGroup(node)) {
            out[key] = resolveParamValues(node, isPlainObj(stored?.[key]) ? stored[key] : undefined);
        }
    }
    return out;
}

/**
 * Finds a param by its key or `.`-joined section path (`"network.host"`).
 *
 * An exact key wins; otherwise each section whose name (plus `.`) starts the
 * key is searched, so section and param names may contain dots.
 *
 * @param defs The script's param tree.
 * @param key The key or path.
 * @param prefix The path of `defs` itself, for recursion.
 * @returns The param or undefined when there's no such param.
 * @example
 * findParamDef({ network: { host: { type: "string" } } }, "network.host");
 * // → { path: ["network", "host"], def: { type: "string" } }
 */
export function findParamDef(
    defs: ParamTree | undefined,
    key: string,
    prefix: string[] = []
):
    | {
          /** The keys from the tree's root to the param. */
          path: string[];
          /** The param's def. */
          def: ParamDef;
      }
    | undefined {
    if (!defs) return undefined;
    if (Object.prototype.hasOwnProperty.call(defs, key)) {
        const node = defs[key];
        if (isParamDef(node)) return { path: [...prefix, key], def: node };
    }
    for (const [k, node] of Object.entries(defs)) {
        if (isParamGroup(node) && key.startsWith(k + ".")) {
            const hit = findParamDef(node, key.slice(k.length + 1), [...prefix, k]);
            if (hit) return hit;
        }
    }
    return undefined;
}

/**
 * Reads the value at a path in nested param values.
 *
 * @returns The value or undefined when the path is missing or passes through a value that isn't a plain object.
 */
export function getParamAtPath(values: Record<string, any> | undefined, path: readonly string[]): any {
    let cur: any = values;
    for (const seg of path) {
        if (!isPlainObj(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * Sets the value at a path in nested param values, without changing them.
 *
 * Objects along the path are copied; one missing or not a plain object is
 * replaced by a new one.
 *
 * @param values The current values; anything but a plain object counts as `{}`.
 * @param path The keys from the root to the param; empty leaves the values as they are.
 * @param value The new value.
 * @returns The new values.
 * @example
 * setParamAtPath({ on: true }, ["network", "host"], "b.com");
 * // → { on: true, network: { host: "b.com" } }
 */
export function setParamAtPath(values: Record<string, any> | undefined, path: readonly string[], value: any): Record<string, any> {
    const base = isPlainObj(values) ? values : {};
    if (!path.length) return base;
    const [head, ...rest] = path;
    return { ...base, [head]: rest.length === 0 ? value : setParamAtPath(isPlainObj(base[head]) ? base[head] : undefined, rest, value) };
}

/**
 * Whether a value can be a param's raw value: its type matches the def's.
 *
 * `null` and `undefined` never are; numbers must be finite, enum values one
 * of `choices`, string lists all strings and shortcuts `""` or a shortcut.
 * `min` and `max` aren't checked.
 */
export function isValidParamValue(def: ParamDef, v: any): boolean {
    if (v === undefined || v === null) return false;
    switch (def.type) {
        case "boolean":
            return typeof v === "boolean";
        case "number":
            return typeof v === "number" && isFinite(v);
        case "string":
            return typeof v === "string";
        case "enum":
            return typeof v === "string" && def.choices.includes(v);
        case "stringList":
            return Array.isArray(v) && v.every((x) => typeof x === "string");
        case "shortcut":
            return isShortcut(v);
    }
}

/** A def without its `parse` function: what gets stored, messaged and diffed. Returns the def itself when it has none. */
export function serializableParamDef<D extends ParamDef>(def: D): D {
    if (!("parse" in def)) return def;
    const { parse: _parse, ...rest } = def;
    return rest as D;
}

/** A copy of a param tree with {@link serializableParamDef} applied to every param. */
export function serializableParamTree(defs: ParamTree): ParamTree {
    const out: ParamTree = {};
    for (const [k, node] of Object.entries(defs)) {
        out[k] = isParamDef(node) ? serializableParamDef(node) : serializableParamTree(node);
    }
    return out;
}

/**
 * Runs the def's `parse`, if it has one, over a resolved raw value.
 *
 * A list is copied first, so the parser can't change the stored value.
 *
 * @param key The param's `.`-joined path, used in errors.
 * @param def The param's def.
 * @param raw The resolved raw value.
 * @returns What `parse` returns, else `raw`.
 * @throws Error `param "<key>": parse must be a function` when `parse` isn't one.
 * @throws Error `param "<key>": parse failed for value <value>: <message>` when the parser throws (the value as JSON, cut to 200 characters).
 */
export function parseParamValue(key: string, def: ParamDef, raw: any): any {
    const parse = (def as { parse?: unknown }).parse;
    if (parse === undefined) return raw;
    if (typeof parse !== "function") throw new Error(`param "${key}": parse must be a function`);
    try {
        return parse(Array.isArray(raw) ? [...raw] : raw);
    } catch (e: any) {
        let shown = JSON.stringify(raw) ?? String(raw);
        if (shown.length > 200) shown = shown.slice(0, 200) + "…";
        throw new Error(`param "${key}": parse failed for value ${shown}: ${e && typeof e.message === "string" ? e.message : String(e)}`);
    }
}

/**
 * Runs {@link parseParamValue} across every param in a tree.
 *
 * @param defs The param tree.
 * @param raw The resolved raw values, nested like `defs`.
 * @param prefix The `.`-joined path of `defs` itself, for errors.
 * @returns The parsed values, nested like `defs`.
 * @throws Error As {@link parseParamValue} does, for the first param that fails.
 */
export function parseParamTree(defs: ParamTree, raw: Record<string, any> | undefined, prefix = ""): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, node] of Object.entries(defs)) {
        const path = prefix ? `${prefix}.${k}` : k;
        out[k] = isParamDef(node) ? parseParamValue(path, node, raw?.[k]) : parseParamTree(node, isPlainObj(raw?.[k]) ? raw[k] : undefined, path);
    }
    return out;
}
