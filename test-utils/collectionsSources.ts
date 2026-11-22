import { readdirSync } from "node:fs";
import { readSourceRelativeTo } from "./sourceText";

export function readCollectionsSources() {
  const directory = new URL("../convex/collections/", import.meta.url);
  const modules = readdirSync(directory, { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => "../convex/collections/" + name.replaceAll("\\", "/"))
    .sort();
  if (modules.length === 0) throw new Error("Collections implementation sources are unavailable.");

  return ["../convex/collections.ts", ...modules].map((rel) => ({
    rel,
    text: readSourceRelativeTo(import.meta.url, rel),
  }));
}
