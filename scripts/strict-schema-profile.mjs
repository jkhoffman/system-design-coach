// Deliberately limited to the profile used by the configured, non-fine-tuned models.
// This mock catches serialization regressions; it does not prove live API acceptance.
const keywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "anyOf", "$defs", "$ref", "description", "title", "minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems"]);
export function assertStrictFormat(format) {
  if (format?.type !== "json_schema" || format.strict !== true || format.schema?.type !== "object") throw new Error("Strict object schema required");
  function walk(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid schema node");
    for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (schema.type === "object") {
      if (schema.additionalProperties !== false) throw new Error("Objects must be closed");
      if (JSON.stringify(Object.keys(schema.properties ?? {}).sort()) !== JSON.stringify([...(schema.required ?? [])].sort())) throw new Error("Every property must be required");
    }
    for (const child of Object.values(schema.properties ?? {})) walk(child);
    for (const child of Object.values(schema.$defs ?? {})) walk(child);
    for (const child of schema.anyOf ?? []) walk(child);
    if (schema.items) walk(schema.items);
  }
  walk(format.schema);
}
