/** Strip Zod annotations that are not part of our model-facing strict schema profile. */
export function modelSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map(modelSchema) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "default" && key !== "$schema")
    .map(([key, child]) => [key, modelSchema(child)])) as T;
}
