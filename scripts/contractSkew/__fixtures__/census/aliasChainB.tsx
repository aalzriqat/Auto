/* eslint-disable */
// @ts-nocheck
/**
 * SCRUM-178 v2 batch 3 (Opus L-b). The tail of a cross-file alias chain: the
 * links live in aliasChainRoot.tsx, which sorts AFTER this file, so the files'
 * source order is also against the chain.
 */
import { useMutation } from "convex/react";
import { x14 } from "./aliasChainRoot";

export function CrossFileChain() {
  const create = useMutation(x14);
  return create({ orgId: "o" });
}
