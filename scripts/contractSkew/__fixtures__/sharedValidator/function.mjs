import { mutationGeneric } from "convex/server";
import { args } from "./args.mjs";

export const update = mutationGeneric({ args, handler: () => null });
