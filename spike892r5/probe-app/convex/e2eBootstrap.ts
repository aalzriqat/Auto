// Spike stand-in for the real marker mutation, so the repo's own `mark` runs
// unchanged against the probe deployment. It writes nothing.
import { mutationGeneric } from "convex/server";

export const markPreviewDeployment = mutationGeneric({ args: {}, handler: async () => null });