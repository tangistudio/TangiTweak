/**
 * JSON schemas for settings.json — used by Monaco's built-in JSON worker in
 * the Editor — and for a tweak's own data folder settings.json.
 */
import { LOG_LEVELS, DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, TEXT_TYPES_DESC, DEFAULT_BODY_CAP, BODY_CAP_MIN, BODY_CAP_MAX } from "./settingsJson";
import { DATA_FOLDER_DESC, DEFAULT_DATA_FOLDER } from "./tweakData";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";
import { isParamDef, paramDefault, type ParamNode, type ParamTree } from "./scriptDef";

export const SETTINGS_SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "TangiTweak settings",
    description: "Extension settings (settings.json). Omitted keys use their defaults. A tweak's enable switch and params are in its data folder's settings.json.",
    type: "object",
    additionalProperties: false,
    properties: {
        $schema: {
            type: "string",
            description: "Optional JSON Schema URI",
        },
        logLevel: {
            type: "string",
            enum: [...LOG_LEVELS],
            default: DEFAULT_LOG_LEVEL,
            description: "Minimum log level shown in the panel",
        },
        logCap: {
            type: "integer",
            minimum: 100,
            maximum: 10000,
            default: DEFAULT_LOG_CAP,
            description: "Log lines kept in the panel",
        },
        textTypes: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            default: [...DEFAULT_TEXT_TYPES],
            description: `${TEXT_TYPES_DESC} Replaces the defaults (see docs/scripting.md#binary-bodies)`,
        },
        bodyCap: {
            type: "integer",
            minimum: BODY_CAP_MIN,
            maximum: BODY_CAP_MAX,
            default: DEFAULT_BODY_CAP,
            description: "Network view: kB of each request/response body kept; longer bodies are cut",
        },
        dataFolder: {
            type: "string",
            pattern: "^[A-Za-z0-9._-]+$",
            default: DEFAULT_DATA_FOLDER,
            description: `${DATA_FOLDER_DESC}. Changing it renames the folder in every tweak`,
        },
    },
};

function paramSchema(d: ParamNode): Record<string, any> {
    if (!isParamDef(d)) {
        const properties: Record<string, any> = {};
        for (const [k, sub] of Object.entries(d)) properties[k] = paramSchema(sub);
        return { type: "object", properties, additionalProperties: false };
    }
    const base: Record<string, any> = { default: paramDefault(d) };
    if (d.description) base.description = d.description;
    switch (d.type) {
        case "boolean":
            return { type: "boolean", ...base };
        case "number":
            return { type: "number", ...base, ...(d.min !== undefined && { minimum: d.min }), ...(d.max !== undefined && { maximum: d.max }) };
        case "string":
            return { type: "string", ...base };
        case "enum":
            return { type: "string", enum: d.choices, ...base };
        case "stringList":
            return { type: "array", items: { type: "string" }, ...base };
        case "shortcut":
            return { type: "string", ...base, description: `${d.description ? d.description + " — " : ""}keys, e.g. "Mod+Shift+K" (Mod = Cmd on macOS, Ctrl elsewhere); "" for none` };
    }
}

/** the schema of a tweak's data folder settings.json: its enable switch and its declared params, typed */
export function tweakSettingsSchema(defs: ParamTree = {}): Record<string, any> {
    const params: Record<string, any> = {};
    for (const [k, d] of Object.entries(defs)) if (k !== "enabled") params[k] = paramSchema(d);
    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "A tweak's settings",
        description: "This tweak's enable switch, its layer and the params that differ from their defaults. Omitted params use their defaults.",
        type: "object",
        additionalProperties: false,
        properties: {
            $schema: { type: "string" },
            enabled: { type: "boolean", default: true, description: "Run this tweak" },
            layer: { enum: ["base", "site", "override"], description: "Where this tweak's handlers run in the stack: base first, override last. Omit it for automatic: base for routes on any host, site for named hosts" },
            params: { type: "object", description: "Values of the params from tweak.params", properties: params, additionalProperties: !Object.keys(defs).length },
        },
    };
}

/** pretty-printed, trailing newline — the exact bytes written to the synced folder */
