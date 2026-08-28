import type { TranslationKey } from "./dictionaries";

export type Translate = (key: TranslationKey) => string;

const LEAD_STAGE_KEYS: Record<string, TranslationKey> = {
  NEW: "StageNew",
  CONTACTED: "StageContacted",
  INTERESTED: "Interested",
  TEST_DRIVE: "StageTestDrive",
  NEGOTIATION: "StageNegotiation",
  RESERVED: "Reserved",
  WON: "StageWon",
  LOST: "StageLost",
};

const VEHICLE_STATUS_KEYS: Record<string, TranslationKey> = {
  AVAILABLE: "Available",
  SOURCING: "StatusSourcing",
  RESERVED: "Reserved",
  SOLD: "Sold",
  IN_INSPECTION: "InInspection",
  IN_REPAIR: "InRepair",
  ARCHIVED: "StatusArchived",
};

const WORKFLOW_STATUS_KEYS: Record<string, TranslationKey> = {
  PENDING: "StatusPending",
  IN_PROGRESS: "StatusInProgress",
  COMPLETED: "StatusCompleted",
  CANCELLED: "StatusCancelled",
  DRAFT: "StatusDraft",
  SENT: "StatusSent",
  ACCEPTED: "StatusAccepted",
  REJECTED: "StatusRejected",
  EXPIRED: "StatusExpired",
  ACTIVE: "StatusActive",
  CONFIRMED: "StatusConfirmed",
  PENDING_APPROVAL: "StatusPendingApproval",
};

function translateKnownStatus(status: string | null | undefined, keys: Record<string, TranslationKey>, t: Translate): string {
  if (!status) return "—";
  const key = keys[status];
  return key ? t(key) : status;
}

export function translateLeadStage(status: string | null | undefined, t: Translate): string {
  return translateKnownStatus(status, LEAD_STAGE_KEYS, t);
}

export function translateVehicleStatus(status: string | null | undefined, t: Translate): string {
  return translateKnownStatus(status, VEHICLE_STATUS_KEYS, t);
}

export function translateWorkflowStatus(status: string | null | undefined, t: Translate): string {
  return translateKnownStatus(status, WORKFLOW_STATUS_KEYS, t);
}
