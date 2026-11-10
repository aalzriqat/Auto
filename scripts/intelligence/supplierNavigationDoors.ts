/**
 * SCRUM-941 round 3: declared lookup/gate x state x viewer rows for supplierNavigation.ts.
 * The census compares its call sites with these doors, then binds every row to an active
 * literal test title. Update this table and public-query tests together when adding a door.
 * Missing documents need no separate ownership row: readCached returns null both with
 * and without owned, so removing ownership cannot separate those outcomes. Existing
 * financed-application missing rows are retained. openingBalanceDrafts has no isDeleted.
 * Application and expense lookup rows reuse rounds 1/2 tests without adding duplicates.
 */
interface Door {
  name: string;
  kind: "owned" | "permission" | "status";
  site: string;
  rows: readonly { state: string; viewer: string; title: string }[];
}

export const SUPPLIER_NAVIGATION_DOORS: readonly Door[] = [
  { name: "sale lookup", kind: "owned", site: "saleSource: sales", rows: [
    { state: "foreign cash", viewer: "with sales", title: "foreign sale enrichment discloses no source, sale id or deal number" },
    { state: "deleted cash", viewer: "with sales", title: "deleted sale enrichment discloses no source, sale id or deal number" },
    { state: "local cash", viewer: "with sales", title: "sale and expense sources use existing record screens and supplier economic role" },
    { state: "local financed", viewer: "with sales", title: "financed supplier sale links to its same-organization application for a sales viewer" },
    { state: "local financed", viewer: "without sales", title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
    { state: "foreign cash", viewer: "without sales", title: "foreign cash sale enrichment discloses no source for a viewer without sales" },
    { state: "deleted cash", viewer: "without sales", title: "deleted cash sale enrichment discloses no source for a viewer without sales" },
    { state: "foreign financed", viewer: "without sales", title: "foreign financed sale enrichment discloses no source for a viewer without sales" },
    { state: "foreign financed", viewer: "with sales", title: "foreign financed sale enrichment discloses no source for a viewer with sales" },
    { state: "deleted financed", viewer: "without sales", title: "deleted financed sale enrichment discloses no source for a viewer without sales" },
    { state: "deleted financed", viewer: "with sales", title: "deleted financed sale enrichment discloses no source for a viewer with sales" },
    { state: "local cash", viewer: "without sales", title: "cash supplier sale keeps its label without a link for a viewer without sales" },
  ] },
  { name: "sales link gate", kind: "permission", site: "saleSource: VIEW_SALES (cash and financed)", rows: [
    { state: "local cash", viewer: "with sales", title: "sale and expense sources use existing record screens and supplier economic role" },
    { state: "local financed", viewer: "with sales", title: "financed supplier sale links to its same-organization application for a sales viewer" },
    { state: "local financed", viewer: "without sales", title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
    { state: "local cash", viewer: "without sales", title: "cash supplier sale keeps its label without a link for a viewer without sales" },
  ] },
  { name: "application lookup", kind: "owned", site: "saleSource: applications", rows: [
    { state: "local", viewer: "with sales", title: "financed supplier sale links to its same-organization application for a sales viewer" },
    { state: "local", viewer: "without sales", title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
    { state: "foreign", viewer: "with sales", title: "financed supplier sale with a foreign application exposes only the local sale without a link" },
    { state: "missing (hard-deleted)", viewer: "with sales", title: "financed supplier sale with a deleted application exposes only the local sale without a link" },
    { state: "foreign", viewer: "without sales", title: "financed supplier sale with a foreign application exposes only the local sale for a viewer without sales" },
    { state: "missing (hard-deleted)", viewer: "without sales", title: "financed supplier sale with a deleted application exposes only the local sale for a viewer without sales" },
  ] },
  { name: "opening lookup", kind: "owned", site: "sourceFor: openings", rows: [
    { state: "foreign POSTED", viewer: "with finance", title: "foreign opening draft enrichment discloses no source or draft id" },
    { state: "local POSTED", viewer: "with finance", title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
    { state: "foreign POSTED", viewer: "without finance", title: "foreign opening draft discloses no source for a viewer without finance management" },
    { state: "local POSTED", viewer: "without finance", title: "posted opening keeps its label without a link for a viewer without finance management" },
  ] },
  { name: "opening status gate", kind: "status", site: "sourceFor: POSTED", rows: [
    { state: "POSTED", viewer: "with finance", title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
    { state: "PENDING_APPROVAL", viewer: "with finance", title: "pending opening draft yields no source even for a finance manager" },
    { state: "POSTED", viewer: "without finance", title: "posted opening keeps its label without a link for a viewer without finance management" },
  ] },
  { name: "opening link gate", kind: "permission", site: "sourceFor: MANAGE_FINANCE", rows: [
    { state: "local POSTED", viewer: "with finance", title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
    { state: "local POSTED", viewer: "without finance", title: "posted opening keeps its label without a link for a viewer without finance management" },
  ] },
  { name: "expense lookup", kind: "owned", site: "sourceFor: expenses", rows: [
    { state: "foreign", viewer: "any (no expense gate)", title: "foreign expense enrichment discloses no source, expense id or title" },
    { state: "deleted", viewer: "any (no expense gate)", title: "deleted expense enrichment discloses no source, expense id or title" },
    { state: "local", viewer: "any (no expense gate)", title: "sale and expense sources use existing record screens and supplier economic role" },
  ] },
  { name: "expense vehicle lookup", kind: "owned", site: "sourceFor: expense vehicles", rows: [
    { state: "local", viewer: "with vehicles", title: "sale and expense sources use existing record screens and supplier economic role" },
    { state: "foreign", viewer: "without vehicles", title: "expense keeps its source but hides a foreign vehicle for a viewer without vehicles" },
    { state: "foreign", viewer: "with vehicles", title: "expense keeps its source but hides a foreign vehicle for a viewer with vehicles" },
    { state: "deleted", viewer: "without vehicles", title: "expense keeps its source but hides a deleted vehicle for a viewer without vehicles" },
    { state: "deleted", viewer: "with vehicles", title: "expense keeps its source but hides a deleted vehicle for a viewer with vehicles" },
    { state: "local", viewer: "without vehicles", title: "expense vehicle keeps its label without a link for a viewer without vehicles" },
  ] },
  { name: "native or sale vehicle lookup", kind: "owned", site: "sourceFor: native/sale vehicles", rows: [
    { state: "local native", viewer: "with vehicles", title: "statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows" },
    { state: "local native", viewer: "without vehicles", title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
    { state: "foreign native", viewer: "without vehicles", title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
    { state: "deleted native", viewer: "without vehicles", title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
    { state: "local sale label", viewer: "with vehicles", title: "sale and expense sources use existing record screens and supplier economic role" },
    { state: "local sale label", viewer: "without vehicles", title: "financed supplier sale links to its same-organization application for a sales viewer" },
    { state: "foreign native", viewer: "with vehicles", title: "foreign native vehicle yields no source for a vehicle viewer" },
    { state: "foreign sale label", viewer: "without vehicles", title: "local sale label hides its foreign vehicle for a viewer without vehicles" },
    { state: "foreign sale label", viewer: "with vehicles", title: "local sale label hides its foreign vehicle for a viewer with vehicles" },
    { state: "deleted native", viewer: "with vehicles", title: "deleted native vehicle yields no source for a vehicle viewer" },
    { state: "deleted sale label", viewer: "without vehicles", title: "local sale label hides its deleted vehicle for a viewer without vehicles" },
    { state: "deleted sale label", viewer: "with vehicles", title: "local sale label hides its deleted vehicle for a viewer with vehicles" },
  ] },
  { name: "vehicle link gate", kind: "permission", site: "supplierVehicleHref: VIEW_VEHICLES (native and expense)", rows: [
    { state: "local native", viewer: "with vehicles", title: "statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows" },
    { state: "local native", viewer: "without vehicles", title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
    { state: "local expense vehicle", viewer: "with vehicles", title: "sale and expense sources use existing record screens and supplier economic role" },
    { state: "local expense vehicle", viewer: "without vehicles", title: "expense vehicle keeps its label without a link for a viewer without vehicles" },
  ] },
];
