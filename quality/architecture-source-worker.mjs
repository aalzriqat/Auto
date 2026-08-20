import {
  architectureGraph,
  cruiseArchitecture,
  runtimeCycleSnapshot,
} from "./architecture.mjs";

const entryPoints = process.argv[2] ? JSON.parse(process.argv[2]) : undefined;
const cruiseResult = await cruiseArchitecture({
  rootDir: process.cwd(),
  ...(entryPoints ? { entryPoints } : {}),
});
const snapshot = runtimeCycleSnapshot(architectureGraph(cruiseResult));
process.stdout.write(JSON.stringify(snapshot));
