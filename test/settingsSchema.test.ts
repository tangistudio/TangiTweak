import { describe, it, expect } from "vitest";
import { SETTINGS_SCHEMA, tweakSettingsSchema } from "../src/shared/settingsSchema";

describe("a tweak's settings.json schema", () => {
    const schema: any = tweakSettingsSchema({
        enabled: { type: "boolean", default: true },
        status: { type: "enum", choices: ["500", "503"], default: "500", description: "Status" },
        delay: { type: "number", min: 0, max: 10 },
        hosts: { type: "stringList" },
        on: { type: "boolean", default: true },
        note: { type: "string", multiline: true },
    });
    const p = schema.properties.params;

    it("types each declared param under params, enabled at the top", () => {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.enabled.type).toBe("boolean");
        expect(p.additionalProperties).toBe(false);
        expect(p.properties.enabled).toBeUndefined();
        expect(p.properties.status).toEqual({ type: "string", enum: ["500", "503"], default: "500", description: "Status" });
        expect(p.properties.delay).toMatchObject({ type: "number", minimum: 0, maximum: 10, default: 0 });
        expect(p.properties.hosts).toMatchObject({ type: "array", items: { type: "string" }, default: [] });
        expect(p.properties.on).toMatchObject({ type: "boolean", default: true });
        expect(p.properties.note).toMatchObject({ type: "string", default: "" });
    });

    it("a tweak without params allows any; the root schema has no scripts", () => {
        expect(tweakSettingsSchema().properties.params.additionalProperties).toBe(true);
        expect((SETTINGS_SCHEMA.properties as any).scripts).toBeUndefined();
        expect(SETTINGS_SCHEMA.properties.dataFolder.default).toBe(".tweak");
    });
});
