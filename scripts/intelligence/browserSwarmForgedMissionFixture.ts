import type { BrowserAttackMission } from "./browserAttackSwarm";

/**
 * Test fixture: a mission no handler judges. MONEY_BOUNDARY has a handler, but only for ECONOMIC_AUTHORITY and
 * STATE_TRANSITION, so this UI_BACKEND_AUTHORITY mission must be refused. Every active invariant's mandatory
 * missions are executable now, so the gate and run-assembly refusal branches can only be reached by adding it.
 */
export const FORGED_UNEXECUTABLE_MONEY_MISSION: BrowserAttackMission = {
  id: "jev::MONEY_BOUNDARY",
  family: "MONEY_BOUNDARY",
  source: "JEV",
  invariantIds: ["ACC-3"],
  invariantSeverity: "CRITICAL",
  oracle: "UI_BACKEND_AUTHORITY",
  timeoutMs: 45_000,
  estimatedCostUnits: 5,
  evidence: ["TRACE"],
  jevProbability: 0.9,
};

export const FORGED_MISSION_REFUSAL = /no executable handler.*MONEY_BOUNDARY with oracle UI_BACKEND_AUTHORITY \(ACC-3\)/i;
