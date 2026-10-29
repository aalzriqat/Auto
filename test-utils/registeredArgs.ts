/**
 * Validates a call's arguments against a Convex registered function's own `exportArgs()` validator tree,
 * the way the Convex runtime does before a handler runs: every non-optional field present, no field the
 * validator does not declare, and each value of the declared type. Used by the accounting rehearsal's
 * in-memory fake backend (SCRUM-869 F2) so a case cannot pass a payload the real mutation would refuse.
 *
 * Scope: structure only. An `id` is checked to be a string, not to belong to its table, and number ranges
 * beyond "finite or NaN" are the handler's concern. Anything the tree describes with a type this file does
 * not know is reported as a problem rather than accepted.
 */
type Field = { fieldType: Node; optional: boolean };
type Node =
  | { type: "null" | "number" | "bigint" | "boolean" | "string" | "bytes" | "any" }
  | { type: "id"; tableName: string }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "array"; value: Node }
  | { type: "object"; value: Record<string, Field> }
  | { type: "record"; keys: Field; values: Field }
  | { type: "union"; value: Node[] };

/** The JSON a registered function exports for its arguments, or null if it is not a registered function. */
export function exportedArgsOf(registered: unknown): Node | null {
  const exporter = (registered as { exportArgs?: () => string } | undefined)?.exportArgs;
  if (typeof exporter !== "function") return null;
  return JSON.parse(exporter.call(registered)) as Node;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(node: Node, value: unknown, at: string, problems: string[]): void {
  switch (node.type) {
    case "any":
      return;
    case "null":
      if (value !== null) problems.push(`${at}: expected null, got ${describe(value)}`);
      return;
    case "number":
      if (typeof value !== "number") problems.push(`${at}: expected a number, got ${describe(value)}`);
      return;
    case "bigint":
      if (typeof value !== "bigint") problems.push(`${at}: expected a bigint, got ${describe(value)}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${at}: expected a boolean, got ${describe(value)}`);
      return;
    case "string":
    case "id":
      if (typeof value !== "string") problems.push(`${at}: expected a string, got ${describe(value)}`);
      return;
    case "bytes":
      if (!(value instanceof ArrayBuffer)) problems.push(`${at}: expected bytes, got ${describe(value)}`);
      return;
    case "literal":
      if (value !== node.value) problems.push(`${at}: expected the literal ${JSON.stringify(node.value)}, got ${JSON.stringify(value)}`);
      return;
    case "array":
      if (!Array.isArray(value)) {
        problems.push(`${at}: expected an array, got ${describe(value)}`);
        return;
      }
      value.forEach((item, index) => check(node.value, item, `${at}[${index}]`, problems));
      return;
    case "union": {
      const attempts = node.value.map((member) => {
        const own: string[] = [];
        check(member, value, at, own);
        return own;
      });
      if (!attempts.some((own) => own.length === 0)) problems.push(`${at}: matches none of the union members (${attempts.map((own) => own[0]).join(" | ")})`);
      return;
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        problems.push(`${at}: expected a record, got ${describe(value)}`);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        check(node.keys.fieldType, key, `${at} key ${JSON.stringify(key)}`, problems);
        if (item !== undefined || !node.values.optional) check(node.values.fieldType, item, `${at}.${key}`, problems);
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        problems.push(`${at}: expected an object, got ${describe(value)}`);
        return;
      }
      const given = value as Record<string, unknown>;
      for (const [name, field] of Object.entries(node.value)) {
        if (given[name] === undefined) {
          if (!field.optional) problems.push(`${at}: missing the required field \`${name}\``);
          continue;
        }
        check(field.fieldType, given[name], `${at === "args" ? "" : `${at}.`}${name}`, problems);
      }
      for (const name of Object.keys(given)) {
        if (given[name] !== undefined && !(name in node.value)) problems.push(`${at}: extra field \`${name}\` that is not in the validator`);
      }
      return;
    }
    default:
      problems.push(`${at}: validator type ${JSON.stringify((node as { type: string }).type)} is not understood by this checker`);
  }
}

/** The problems found, one sentence each; an empty list means the call would pass the validator. */
export function registeredArgsProblems(registered: unknown, args: unknown): string[] | null {
  const tree = exportedArgsOf(registered);
  if (tree === null) return null;
  const problems: string[] = [];
  check(tree, args, "args", problems);
  return problems;
}
