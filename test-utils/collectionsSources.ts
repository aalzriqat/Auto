import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSourceRelativeTo } from "./sourceText";

export function readCollectionsSources(baseUrl: string) {
  const directory = fileURLToPath(new URL("./collections/", baseUrl));
  const modules = readdirSync(directory, { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => "./collections/" + name.replaceAll("\\", "/"))
    .sort();
  if (modules.length === 0) throw new Error("Collections implementation sources are unavailable.");

  return ["./collections.ts", ...modules].map((rel) => ({
    rel,
    text: readSourceRelativeTo(baseUrl, rel),
  }));
}
