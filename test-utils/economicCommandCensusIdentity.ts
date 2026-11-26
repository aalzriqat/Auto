import fs from "node:fs";
import path from "node:path";
import { directImportedHandlers } from "../scripts/convexDelegatedHandlers";
import { hasCommandIdentity, type Bucket, type SymbolRecord } from "../scripts/economicCommandCensus";
import { readFinanceDealCostCommands } from "../scripts/financeDealCostCommandSources";

export function commandsMissingIdentity(
  convexRoot: string,
  classification: Readonly<Record<string, { bucket: Bucket }>>,
  symbols: ReadonlyMap<string, SymbolRecord>,
): string[] {
  // A command must carry identity in its registered body or exact direct handler.
  // Commands with a documented alternative are named explicitly.
  const ALTERNATE_MECHANISM = new Set(["vehicles.importBulk"]);
  const financeCommands = readFinanceDealCostCommands(path.join(convexRoot, "financeDealCosts.ts"));
  const liars: string[] = [];
  for (const [id, entry] of Object.entries(classification)) {
    if (entry.bucket !== "IDENTITY_GUARDED") continue;
    if (ALTERNATE_MECHANISM.has(id)) continue;
    const sym = symbols.get(id);
    if (!sym) { liars.push(id); continue; }
    const forwarded = id.startsWith("financeDealCosts.") ? financeCommands.get(sym.name)?.body : undefined;
    const file = path.join(convexRoot, sym.file + ".ts");
    const body = forwarded ?? directImportedHandlers(file, fs.readFileSync(file, "utf8")).get(sym.name);
    if (!hasCommandIdentity(body?.getText() ?? sym.body)) liars.push(id);
  }
  return liars;
}
