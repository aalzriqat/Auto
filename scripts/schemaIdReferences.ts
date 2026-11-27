/**
 * Schema-driven `v.id(...)` reference analyzer, shared by the organization
 * financial reset coverage test (SCRUM-546) and the purge impact census
 * (SCRUM-1023). It walks every table's validator tree (objects, arrays, records,
 * unions) and returns each (table, field path, target table) edge. An unknown
 * validator kind THROWS rather than being skipped, so a future kind can never
 * hide a reference.
 */
import schema from "../convex/schema";

export interface ValidatorLike {
  kind: string;
  isOptional?: string;
  tableName?: string;
  fields?: Record<string, ValidatorLike>;
  element?: ValidatorLike;
  members?: ValidatorLike[];
  key?: ValidatorLike;
  value?: ValidatorLike;
}

export interface Ref {
  table: string;
  path: string;
  target: string;
  /** False only when the reference is mandatory: no optional/nullable wrapper on the path. */
  optional: boolean;
}

/** Collect every v.id() under a validator, tracking optional/nullable wrappers. */
export function collect(
  table: string,
  validator: ValidatorLike,
  path: string,
  optional: boolean,
  out: Ref[]
): void {
  const opt = optional || validator.isOptional === "optional";
  switch (validator.kind) {
    case "id":
      out.push({ table, path, target: validator.tableName as string, optional: opt });
      return;
    case "object":
      for (const [name, child] of Object.entries(validator.fields ?? {})) {
        collect(table, child, path ? `${path}.${name}` : name, opt, out);
      }
      return;
    case "array":
      if (validator.element) collect(table, validator.element, `${path}[]`, opt, out);
      return;
    case "record":
      // Key and value are both visited; like array elements they inherit the parent's optionality.
      if (validator.key) collect(table, validator.key, `${path}{key}`, opt, out);
      if (validator.value) collect(table, validator.value, `${path}{}`, opt, out);
      return;
    case "union": {
      const members = validator.members ?? [];
      const nullable = members.some((m) => m.kind === "null");
      for (const m of members) collect(table, m, path, opt || nullable, out);
      return;
    }
    // Leaf kinds that cannot hold a table id.
    case "float64":
    case "int64":
    case "boolean":
    case "bytes":
    case "string":
    case "null":
    case "any":
    case "literal":
      return;
    default:
      throw new Error(
        `Unhandled validator kind "${validator.kind}" at ${table}.${path}: teach collect() about it so no id reference is skipped`
      );
  }
}

export function allReferences(): Ref[] {
  const tables = schema.tables as unknown as Record<string, { validator: ValidatorLike }>;
  const out: Ref[] = [];
  for (const [name, def] of Object.entries(tables)) {
    collect(name, def.validator, "", false, out);
  }
  return out;
}
