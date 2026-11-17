// Checks a value against the JSON Schema subset openapi.ts uses: type
// (including ["x", "null"]), enum, const, properties, required,
// additionalProperties, items, oneOf and $ref. Returns the problems found,
// each with the path to the bad value.
type Schema = Record<string, unknown>;

export function schemaProblems(value: unknown, schema: Schema, root: Schema, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const target = (root.components as { schemas: Record<string, Schema> }).schemas[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return schemaProblems(value, target, root, path);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((s) => schemaProblems(value, s, root, path).length === 0);
    return matches.length === 1 ? [] : [`${path}: matches ${matches.length} of oneOf, not exactly 1`];
  }
  const types = schema.type === undefined ? [] : ([] as unknown[]).concat(schema.type);
  if (types.length > 0 && !types.some((t) => isType(value, t as string))) {
    return [`${path}: ${JSON.stringify(value)} is not ${types.join(" or ")}`];
  }
  if (value === null) return [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum}`];
  if ("const" in schema && schema.const !== value) return [`${path}: ${JSON.stringify(value)} is not ${schema.const}`];

  const problems: string[] = [];
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => problems.push(...schemaProblems(v, schema.items as Schema, root, `${path}[${i}]`)));
  }
  if (isType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) problems.push(`${path}.${key}: missing`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) problems.push(...schemaProblems(v, props[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not in the schema`);
      else if (typeof schema.additionalProperties === "object") {
        problems.push(...schemaProblems(v, schema.additionalProperties as Schema, root, `${path}.${key}`));
      }
    }
  }
  return problems;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return typeof value === type;
  }
}
