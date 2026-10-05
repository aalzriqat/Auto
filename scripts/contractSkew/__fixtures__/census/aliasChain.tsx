/* eslint-disable */
// @ts-nocheck
/**
 * SCRUM-178 v2 batch 3 (Opus L-b). Alias chains longer than the old 12-pass cap.
 * Each link is declared BEFORE the link it copies, so one source-order pass can
 * follow only a single hop and the chain needs one pass per link.
 */
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

// A 14-link chain ending in an invoked mutation: must be accounted (TRANSMISSION).
const t14 = t13;
const t13 = t12;
const t12 = t11;
const t11 = t10;
const t10 = t9;
const t9 = t8;
const t8 = t7;
const t7 = t6;
const t6 = t5;
const t5 = t4;
const t4 = t3;
const t3 = t2;
const t2 = t1;
const t1 = api.vehicles.create;

export function LongChainTransmits() {
  const create = useMutation(t14);
  return create({ orgId: "o" });
}

// The same 14 links ending in a hand-off: must be UNRESOLVED, never silent.
const e14 = e13;
const e13 = e12;
const e12 = e11;
const e11 = e10;
const e10 = e9;
const e9 = e8;
const e8 = e7;
const e7 = e6;
const e6 = e5;
const e5 = e4;
const e4 = e3;
const e3 = e2;
const e2 = e1;
const e1 = api.vehicles.remove;

export function LongChainEscapes() {
  return e14;
}
