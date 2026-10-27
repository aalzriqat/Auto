import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { writeAuditLog } from "./utils/auditLog";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { runWithIdempotency } from "./utils/idempotency";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import {
  codeUnitCompare,
  isValidTaxJurisdiction,
  normalizeNameKey,
  normalizeTaxIdKey,
  normalizeTaxJurisdiction,
} from "./utils/supplierNames";
import {
  CANDIDATE_CAP,
  ensureRegistryState,
  type RegistryInitResult,
  findSupplierCandidates,
  insertSupplier,
  insertSupplierAlias,
  patchSupplier,
  patchSupplierAlias,
  type RegistryLock,
  requireNoLegalIdentityDuplicate,
  requireNoSharedIdentityDependents,
  runGuarded,
  SUPPLIER_ALIAS_NOT_FOUND_MESSAGE,
  SUPPLIER_ERROR,
  SUPPLIER_NOT_FOUND_MESSAGE,
  throwSupplierError,
  withRegistryLock,
  type SupplierCandidate,
} from "./utils/supplierRegistry";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

/**
 * Supplier master API (SCRUM-868 S1). Identity only: no money field, nothing consumes these
 * tables yet, and there is no delete function (invariant I1). A supplier is deactivated, which
 * blocks new use but never breaks an existing reference.
 *
 * Permissions: reads need VIEW_VEHICLES or VIEW_FINANCE and return the picker projection; the
 * full record (contact, tax id) needs VIEW_FINANCE; every write needs MANAGE_FINANCE and leaves an
 * audit row. Every write runs inside `withRegistryLock` (see `utils/supplierRegistry.ts`).
 */

const MAX_NAME = 200;
const MAX_PHONE = 50;
const MAX_EMAIL = 200;
const MAX_ADDRESS = 500;
const MAX_TAX_ID = 64;
const MAX_JURISDICTION = 16;
const MAX_REASON = 500;
const MAX_SEARCH = 200;
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 25;
/** Total alias rows per supplier, retired ones included, so every alias read is bounded. */
const MAX_ALIAS_ROWS = 100;

const contactValidator = v.object({
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  address: v.optional(v.string()),
});

type Contact = NonNullable<Doc<"suppliers">["contact"]>;

// ─── Input cleaning ───────────────────────────────────────────────────────────────────────────

function invalid(message: string): never {
  return throwSupplierError(SUPPLIER_ERROR.INVALID_INPUT, message);
}

/** Trimmed text, or undefined when blank. Too-long text is refused. */
function cleanText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) invalid(`${label} must be at most ${max} characters.`);
  return text;
}

function requireDisplayName(value: string): string {
  const name = cleanText(value, "Display name", MAX_NAME);
  if (!name || !normalizeNameKey(name)) invalid("Display name is required.");
  return name;
}

function cleanContact(contact: Contact | undefined): Contact | undefined {
  if (!contact) return undefined;
  const phone = cleanText(contact.phone, "Phone", MAX_PHONE);
  const email = cleanText(contact.email, "Email", MAX_EMAIL);
  const address = cleanText(contact.address, "Address", MAX_ADDRESS);
  if (phone === undefined && email === undefined && address === undefined) return undefined;
  return {
    ...(phone !== undefined ? { phone } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(address !== undefined ? { address } : {}),
  };
}

interface TaxIdentity {
  taxId: string | undefined;
  taxIdKey: string | undefined;
  taxJurisdiction: string | undefined;
}

function cleanTaxIdentity(taxId: string | undefined, jurisdiction: string | undefined): TaxIdentity {
  const text = cleanText(taxId, "Tax id", MAX_TAX_ID);
  const rawJurisdiction = cleanText(jurisdiction, "Tax jurisdiction", MAX_JURISDICTION);
  if (text === undefined) {
    if (rawJurisdiction !== undefined) invalid("A tax jurisdiction needs a tax id.");
    return { taxId: undefined, taxIdKey: undefined, taxJurisdiction: undefined };
  }
  const taxIdKey = normalizeTaxIdKey(text);
  if (!taxIdKey) invalid("Tax id must contain letters or digits.");
  const taxJurisdiction = rawJurisdiction === undefined ? undefined : normalizeTaxJurisdiction(rawJurisdiction);
  // Only an assigned ISO 3166 code is a jurisdiction. Free text ("JOR", "Jordan") would make one
  // legal identity several (SCRUM-868 PR 687 M2). The message never echoes the input.
  if (taxJurisdiction !== undefined && !isValidTaxJurisdiction(taxJurisdiction)) {
    invalid("Tax jurisdiction must be an ISO 3166-1 alpha-2 country code such as JO.");
  }
  return { taxId: text, taxIdKey, taxJurisdiction };
}

function requireReason(value: string | undefined, label: string): string {
  const reason = cleanText(value, label, MAX_REASON);
  if (!reason) throwSupplierError(SUPPLIER_ERROR.REASON_REQUIRED, `${label} is required.`);
  return reason;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

// ─── Permissions and projections ──────────────────────────────────────────────────────────────

/** VIEW_VEHICLES or VIEW_FINANCE reads the picker; VIEW_FINANCE reads the full record. */
async function requireSupplierReadAccess(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<{ canViewFull: boolean }> {
  const { role } = await requireTenantAuth(ctx, orgId);
  const owner = isSystemOwnerRole(role);
  const holds = (permission: Permission): boolean => owner || role.permissions.includes(permission);
  const canViewFull = holds(PERMISSIONS.VIEW_FINANCE);
  if (!canViewFull && !holds(PERMISSIONS.VIEW_VEHICLES)) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Missing required permissions: view:vehicles or view:finance");
  }
  return { canViewFull };
}

function pickerRow(supplier: Doc<"suppliers">) {
  return { _id: supplier._id, displayName: supplier.displayName, status: supplier.status };
}

/** Allowlisted full record: internal keys and user ids are never returned. */
function fullRecord(supplier: Doc<"suppliers">, aliases: Doc<"supplierAliases">[]) {
  return {
    _id: supplier._id,
    displayName: supplier.displayName,
    legalName: supplier.legalName,
    status: supplier.status,
    contact: supplier.contact,
    taxId: supplier.taxId,
    taxJurisdiction: supplier.taxJurisdiction,
    sharedLegalIdentityOf: supplier.sharedLegalIdentityOf,
    sharedLegalIdentityReason: supplier.sharedLegalIdentityReason,
    version: supplier.version,
    origin: supplier.origin,
    createdAt: supplier.createdAt,
    updatedAt: supplier.updatedAt,
    deactivatedAt: supplier.deactivatedAt,
    deactivatedReason: supplier.deactivatedReason,
    aliases: aliases.map((alias) => ({ _id: alias._id, alias: alias.alias, status: alias.status, source: alias.source })),
  };
}

/** Audit view: contact details are recorded only as a flag. */
function auditView(supplier: Doc<"suppliers">) {
  return {
    displayName: supplier.displayName,
    legalName: supplier.legalName,
    status: supplier.status,
    taxId: supplier.taxId,
    taxJurisdiction: supplier.taxJurisdiction,
    sharedLegalIdentityOf: supplier.sharedLegalIdentityOf,
    version: supplier.version,
    hasContact: supplier.contact !== undefined,
  };
}

async function loadAliases(ctx: QueryCtx, orgId: Id<"organizations">, supplierId: Id<"suppliers">) {
  return await ctx.db
    .query("supplierAliases")
    .withIndex("by_org_and_supplierId", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId))
    .take(MAX_ALIAS_ROWS);
}

// ─── Duplicate confirmation ───────────────────────────────────────────────────────────────────

/** The caller's list must equal the candidates found inside this transaction, exactly. */
function requireConfirmedCandidates(candidates: SupplierCandidate[], confirmed: Id<"suppliers">[] | undefined): void {
  const wanted = new Set<string>(candidates.map((candidate) => candidate.supplierId));
  const given = new Set<string>(confirmed ?? []);
  const exact = wanted.size === given.size && [...wanted].every((id) => given.has(id));
  if (!exact) {
    throwSupplierError(
      SUPPLIER_ERROR.DUPLICATE_CANDIDATES,
      "Similar suppliers exist. Confirm this is a different supplier from each of them, or use the existing one.",
      { candidates },
    );
  }
}

function checkConfirmList(confirmed: Id<"suppliers">[] | undefined): void {
  if (confirmed && confirmed.length > CANDIDATE_CAP) invalid(`confirmDistinctFrom lists at most ${CANDIDATE_CAP} suppliers.`);
}

/**
 * The target of `sharedLegalIdentityOf` must be a supplier of this org with the same legal identity,
 * and must not itself be linked. Links stay one level deep: a target that is linked would make a
 * chain, and a head that links to its own dependent would make a cycle.
 */
async function requireSharedIdentityTarget(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  targetId: Id<"suppliers">,
  selfId: Id<"suppliers"> | undefined,
  identity: TaxIdentity,
): Promise<void> {
  const target = await requireOwnedRow(ctx, orgId, "suppliers", targetId, SUPPLIER_NOT_FOUND_MESSAGE);
  const sameIdentity =
    identity.taxIdKey !== undefined &&
    identity.taxJurisdiction !== undefined &&
    target.taxIdKey === identity.taxIdKey &&
    target.taxJurisdiction === identity.taxJurisdiction;
  if (target._id === selfId || !sameIdentity) {
    throwSupplierError(
      SUPPLIER_ERROR.SHARED_IDENTITY_MISMATCH,
      "A shared legal identity needs another supplier with the same tax id and jurisdiction.",
    );
  }
  if (target.sharedLegalIdentityOf !== undefined) {
    throwSupplierError(
      SUPPLIER_ERROR.SHARED_IDENTITY_MISMATCH,
      "That supplier shares another supplier's legal identity. Link to the supplier that holds it.",
    );
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(v.union(v.literal("ACTIVE"), v.literal("INACTIVE"))),
  },
  handler: async (ctx, args) =>
    runGuarded(async () => {
      await requireSupplierReadAccess(ctx, args.orgId);
      const result = await ctx.db
        .query("suppliers")
        .withIndex("by_org_and_status", (q) =>
          args.status === undefined ? q.eq("orgId", args.orgId) : q.eq("orgId", args.orgId).eq("status", args.status),
        )
        .paginate(args.paginationOpts);
      return { ...result, page: result.page.map(pickerRow) };
    }),
});

export const search = query({
  args: { orgId: v.id("organizations"), query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    runGuarded(async () => {
      await requireSupplierReadAccess(ctx, args.orgId);
      const text = args.query.trim().slice(0, MAX_SEARCH);
      const key = normalizeNameKey(text);
      if (!key) return [];
      const limit = Math.min(Math.max(Math.floor(args.limit ?? SEARCH_DEFAULT), 1), SEARCH_MAX);

      const hits = new Map<Id<"suppliers">, Doc<"suppliers">>();
      const add = (supplier: Doc<"suppliers"> | null): void => {
        if (supplier && supplier.orgId === args.orgId && hits.size < limit) hits.set(supplier._id, supplier);
      };

      const exact = await ctx.db
        .query("suppliers")
        .withIndex("by_org_and_displayNameKey", (q) => q.eq("orgId", args.orgId).eq("displayNameKey", key))
        .take(limit);
      exact.forEach(add);
      const aliasHits = await ctx.db
        .query("supplierAliases")
        .withIndex("by_org_and_aliasKey_and_status", (q) => q.eq("orgId", args.orgId).eq("aliasKey", key).eq("status", "ACTIVE"))
        .take(limit);
      for (const alias of aliasHits) {
        if (hits.size >= limit) break;
        add(await ctx.db.get(alias.supplierId));
      }
      if (hits.size < limit) {
        const matched = await ctx.db
          .query("suppliers")
          .withSearchIndex("search_displayName", (q) => q.search("displayName", text).eq("orgId", args.orgId))
          .take(limit);
        matched.forEach(add);
      }
      return [...hits.values()].map(pickerRow);
    }),
});

export const get = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers") },
  handler: async (ctx, args) =>
    runGuarded(async () => {
      const { canViewFull } = await requireSupplierReadAccess(ctx, args.orgId);
      const supplier = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
      if (!canViewFull) return pickerRow(supplier);
      return fullRecord(supplier, await loadAliases(ctx, args.orgId, supplier._id));
    }),
});

/**
 * Read-only preview of what `create` would ask the caller to confirm. It always reads every
 * candidate source (names, aliases, tax id): it is the full preview, not the per-field check that
 * `update` runs through `sources`. `excludeSupplierId` must be a supplier of this org.
 */
export const candidatesFor = query({
  args: {
    orgId: v.id("organizations"),
    displayName: v.string(),
    taxId: v.optional(v.string()),
    taxJurisdiction: v.optional(v.string()),
    excludeSupplierId: v.optional(v.id("suppliers")),
  },
  handler: async (ctx, args) =>
    runGuarded(async () => {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      // A caller-supplied id is checked like `get` does: foreign and missing ids get one refusal.
      if (args.excludeSupplierId) {
        await requireOwnedRow(ctx, args.orgId, "suppliers", args.excludeSupplierId, SUPPLIER_NOT_FOUND_MESSAGE);
      }
      const nameKey = normalizeNameKey(requireDisplayName(args.displayName));
      const identity = cleanTaxIdentity(args.taxId, args.taxJurisdiction);
      return findSupplierCandidates(ctx, args.orgId, {
        nameKey,
        taxIdKey: identity.taxIdKey,
        taxJurisdiction: identity.taxJurisdiction,
        excludeSupplierId: args.excludeSupplierId,
      });
    }),
});

// ─── Writes ───────────────────────────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    idempotencyKey: v.string(),
    displayName: v.string(),
    legalName: v.optional(v.string()),
    contact: v.optional(contactValidator),
    taxId: v.optional(v.string()),
    taxJurisdiction: v.optional(v.string()),
    sharedLegalIdentityOf: v.optional(v.id("suppliers")),
    sharedLegalIdentityReason: v.optional(v.string()),
    confirmDistinctFrom: v.optional(v.array(v.id("suppliers"))),
  },
  handler: async (ctx, args): Promise<{ supplierId: Id<"suppliers"> }> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      const displayName = requireDisplayName(args.displayName);
      const nameKey = normalizeNameKey(displayName);
      const legalName = cleanText(args.legalName, "Legal name", MAX_NAME);
      const contact = cleanContact(args.contact);
      const identity = cleanTaxIdentity(args.taxId, args.taxJurisdiction);
      const shareTarget = args.sharedLegalIdentityOf;
      const shareReason = shareTarget ? requireReason(args.sharedLegalIdentityReason, "Shared legal identity reason") : undefined;
      checkConfirmList(args.confirmDistinctFrom);

      const fingerprint = canonical({
        displayName,
        legalName,
        contact,
        taxId: identity.taxId,
        taxJurisdiction: identity.taxJurisdiction,
        shareTarget,
        shareReason,
        confirm: [...(args.confirmDistinctFrom ?? [])].sort(codeUnitCompare),
      });

      return runWithIdempotency(
        ctx,
        {
          orgId: args.orgId,
          operation: "supplier.create",
          actorId: user._id,
          economic: false,
          idempotencyKey: args.idempotencyKey,
          fingerprint,
          onFingerprintConflict: () =>
            throwSupplierError(
              SUPPLIER_ERROR.IDEMPOTENCY_CONFLICT,
              "This idempotency key was already used for a different supplier.",
            ),
        },
        () =>
          withRegistryLock(ctx, args.orgId, async (lock) => {
            if (shareTarget) await requireSharedIdentityTarget(ctx, args.orgId, shareTarget, undefined, identity);
            if (!shareTarget) await requireNoLegalIdentityDuplicate(ctx, args.orgId, identity);
            const candidates = await findSupplierCandidates(ctx, args.orgId, {
              nameKey,
              taxIdKey: identity.taxIdKey,
              taxJurisdiction: identity.taxJurisdiction,
            });
            requireConfirmedCandidates(candidates, args.confirmDistinctFrom);

            const now = Date.now();
            const row: Omit<Doc<"suppliers">, "_id" | "_creationTime"> = {
              orgId: args.orgId,
              displayName,
              displayNameKey: nameKey,
              legalName,
              status: "ACTIVE",
              contact,
              taxId: identity.taxId,
              taxIdKey: identity.taxIdKey,
              taxJurisdiction: identity.taxJurisdiction,
              sharedLegalIdentityOf: shareTarget,
              sharedLegalIdentityReason: shareReason,
              version: 1,
              origin: "MANUAL",
              createdBy: user._id,
              createdAt: now,
              updatedBy: user._id,
              updatedAt: now,
            };
            const supplierId = await insertSupplier(ctx, lock, row);
            await writeAuditLog(ctx, user, {
              action: "supplier.create",
              targetTable: "suppliers",
              targetId: supplierId,
              orgId: args.orgId,
              after: auditView({ _id: supplierId, _creationTime: now, ...row }),
            });
            return { supplierId };
          }),
      );
    }),
});

/** The `update` arguments after validation by the Convex argument validators. */
interface UpdateSupplierInput {
  orgId: Id<"organizations">;
  supplierId: Id<"suppliers">;
  expectedVersion: number;
  displayName?: string;
  legalName?: string | null;
  contact?: Contact | null;
  taxId?: string | null;
  taxJurisdiction?: string | null;
  sharedLegalIdentityOf?: Id<"suppliers"> | null;
  sharedLegalIdentityReason?: string;
  reason?: string;
  confirmDistinctFrom?: Id<"suppliers">[];
}

/** null clears the field, undefined keeps the stored value, text is cleaned and may not be blank. */
function resolveLegalName(current: string | undefined, input: string | null | undefined): string | undefined {
  if (input === null) return undefined;
  if (input === undefined) return current;
  return cleanText(input, "Legal name", MAX_NAME) ?? invalid("Legal name cannot be blank; send null to clear it.");
}

function resolveContact(current: Contact | undefined, input: Contact | null | undefined): Contact | undefined {
  if (input === null) return undefined;
  if (input === undefined) return current;
  return cleanContact(input) ?? invalid("Contact cannot be empty; send null to clear it.");
}

function resolveTaxIdentity(
  current: Doc<"suppliers">,
  args: UpdateSupplierInput,
): { identity: TaxIdentity; identityChanged: boolean } {
  const nextTaxId = args.taxId === undefined ? current.taxId : args.taxId;
  const nextJurisdiction = args.taxJurisdiction === undefined ? current.taxJurisdiction : args.taxJurisdiction;
  const identity = cleanTaxIdentity(nextTaxId ?? undefined, nextTaxId === null ? undefined : (nextJurisdiction ?? undefined));
  if (args.taxId === null && typeof args.taxJurisdiction === "string") invalid("A tax jurisdiction needs a tax id.");
  const identityChanged = identity.taxIdKey !== current.taxIdKey || identity.taxJurisdiction !== current.taxJurisdiction;
  return { identity, identityChanged };
}

/**
 * The shared-legal-identity link after the edit. An explicit null removes it; moving the identity
 * without naming a target removes it too (a link to a different identity would be invalid); an
 * explicit target is validated and needs a reason.
 */
async function resolveSharedLink(
  ctx: QueryCtx,
  args: UpdateSupplierInput,
  current: Doc<"suppliers">,
  identity: TaxIdentity,
  identityChanged: boolean,
): Promise<{ sharedOf: Id<"suppliers"> | undefined; sharedReason: string | undefined }> {
  const requested = args.sharedLegalIdentityOf;
  if (requested === null || (requested === undefined && identityChanged)) {
    return { sharedOf: undefined, sharedReason: undefined };
  }
  if (requested === undefined) {
    return { sharedOf: current.sharedLegalIdentityOf, sharedReason: current.sharedLegalIdentityReason };
  }
  const sharedReason = requireReason(args.sharedLegalIdentityReason, "Shared legal identity reason");
  await requireSharedIdentityTarget(ctx, args.orgId, requested, current._id, identity);
  return { sharedOf: requested, sharedReason };
}

/** Candidate sources are read only for the fields the edit changes, so a standing duplicate of the other does not block it. */
async function requireUpdateCandidatesConfirmed(
  ctx: QueryCtx,
  args: UpdateSupplierInput,
  current: Doc<"suppliers">,
  displayNameKey: string,
  identity: TaxIdentity,
  identityChanged: boolean,
): Promise<void> {
  const nameKeyChanged = displayNameKey !== current.displayNameKey;
  if (!nameKeyChanged && !identityChanged) return;
  const candidates = await findSupplierCandidates(ctx, args.orgId, {
    nameKey: displayNameKey,
    taxIdKey: identity.taxIdKey,
    taxJurisdiction: identity.taxJurisdiction,
    excludeSupplierId: current._id,
    sources: { name: nameKeyChanged, taxId: identityChanged },
  });
  requireConfirmedCandidates(candidates, args.confirmDistinctFrom);
}

/** The body of `update`, run inside `withRegistryLock`. */
async function applySupplierUpdate(
  ctx: MutationCtx,
  lock: RegistryLock,
  user: Doc<"users">,
  args: UpdateSupplierInput,
): Promise<{ version: number }> {
  const current = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
  if (current.version !== args.expectedVersion) {
    throwSupplierError(
      SUPPLIER_ERROR.VERSION_CONFLICT,
      "This supplier was changed by someone else. Reload it and try again.",
      { currentVersion: current.version },
    );
  }

  const displayName = args.displayName === undefined ? current.displayName : requireDisplayName(args.displayName);
  const nameChanged = displayName !== current.displayName;
  const reason = nameChanged ? requireReason(args.reason, "A reason for the display-name change") : undefined;
  const displayNameKey = normalizeNameKey(displayName);
  const legalName = resolveLegalName(current.legalName, args.legalName);
  const contact = resolveContact(current.contact, args.contact);
  const { identity, identityChanged } = resolveTaxIdentity(current, args);
  const { sharedOf, sharedReason } = await resolveSharedLink(ctx, args, current, identity, identityChanged);

  const unchanged =
    displayName === current.displayName &&
    legalName === current.legalName &&
    canonical(contact) === canonical(current.contact) &&
    identity.taxId === current.taxId &&
    identity.taxJurisdiction === current.taxJurisdiction &&
    sharedOf === current.sharedLegalIdentityOf &&
    sharedReason === current.sharedLegalIdentityReason;
  if (unchanged) throwSupplierError(SUPPLIER_ERROR.NO_CHANGE, "There is nothing to change.");

  // Without a declared share, the final identity must be unique. That holds when the identity
  // moves and when an existing link is removed (the supplier then stands on its own).
  if (!sharedOf && (identityChanged || current.sharedLegalIdentityOf !== undefined)) {
    await requireNoLegalIdentityDuplicate(ctx, args.orgId, identity, current._id);
  }
  // Other suppliers may point at this one's identity, so it cannot move while they do.
  if (identityChanged) await requireNoSharedIdentityDependents(ctx, args.orgId, current._id);
  await requireUpdateCandidatesConfirmed(ctx, args, current, displayNameKey, identity, identityChanged);

  const snapshotChanged =
    nameChanged ||
    legalName !== current.legalName ||
    identity.taxId !== current.taxId ||
    identity.taxJurisdiction !== current.taxJurisdiction;
  const version = snapshotChanged ? current.version + 1 : current.version;
  const patch = {
    displayName,
    displayNameKey,
    legalName,
    contact,
    taxId: identity.taxId,
    taxIdKey: identity.taxIdKey,
    taxJurisdiction: identity.taxJurisdiction,
    sharedLegalIdentityOf: sharedOf,
    sharedLegalIdentityReason: sharedReason,
    version,
    updatedBy: user._id,
    updatedAt: Date.now(),
  };
  await patchSupplier(ctx, lock, current, patch);
  await writeAuditLog(ctx, user, {
    action: "supplier.update",
    targetTable: "suppliers",
    targetId: current._id,
    orgId: args.orgId,
    before: auditView(current),
    after: { ...auditView({ ...current, ...patch }), reason },
  });
  return { version };
}

/** Nullable fields: undefined keeps the stored value, null clears it. */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    supplierId: v.id("suppliers"),
    expectedVersion: v.number(),
    displayName: v.optional(v.string()),
    legalName: v.optional(v.union(v.string(), v.null())),
    contact: v.optional(v.union(contactValidator, v.null())),
    taxId: v.optional(v.union(v.string(), v.null())),
    taxJurisdiction: v.optional(v.union(v.string(), v.null())),
    sharedLegalIdentityOf: v.optional(v.union(v.id("suppliers"), v.null())),
    sharedLegalIdentityReason: v.optional(v.string()),
    reason: v.optional(v.string()),
    confirmDistinctFrom: v.optional(v.array(v.id("suppliers"))),
  },
  handler: async (ctx, args): Promise<{ version: number }> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      checkConfirmList(args.confirmDistinctFrom);

      return withRegistryLock(ctx, args.orgId, (lock) => applySupplierUpdate(ctx, lock, user, args));
    }),
});

export const deactivate = mutation({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers"), reason: v.string() },
  handler: async (ctx, args): Promise<null> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      const reason = requireReason(args.reason, "A deactivation reason");
      return withRegistryLock(ctx, args.orgId, async (lock) => {
        const current = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
        if (current.status === "INACTIVE") {
          throwSupplierError(SUPPLIER_ERROR.ALREADY_INACTIVE, "This supplier is already inactive.");
        }
        const now = Date.now();
        await patchSupplier(ctx, lock, current, {
          status: "INACTIVE",
          deactivatedBy: user._id,
          deactivatedAt: now,
          deactivatedReason: reason,
          updatedBy: user._id,
          updatedAt: now,
        });
        await writeAuditLog(ctx, user, {
          action: "supplier.deactivate",
          targetTable: "suppliers",
          targetId: current._id,
          orgId: args.orgId,
          before: { status: current.status },
          after: { status: "INACTIVE", reason },
        });
        return null;
      });
    }),
});

export const reactivate = mutation({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers") },
  handler: async (ctx, args): Promise<null> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      return withRegistryLock(ctx, args.orgId, async (lock) => {
        const current = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
        if (current.status === "ACTIVE") {
          throwSupplierError(SUPPLIER_ERROR.ALREADY_ACTIVE, "This supplier is already active.");
        }
        await patchSupplier(ctx, lock, current, {
          status: "ACTIVE",
          deactivatedBy: undefined,
          deactivatedAt: undefined,
          deactivatedReason: undefined,
          updatedBy: user._id,
          updatedAt: Date.now(),
        });
        await writeAuditLog(ctx, user, {
          action: "supplier.reactivate",
          targetTable: "suppliers",
          targetId: current._id,
          orgId: args.orgId,
          before: { status: current.status },
          after: { status: "ACTIVE" },
        });
        return null;
      });
    }),
});

export const addAlias = mutation({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers"), alias: v.string() },
  handler: async (ctx, args): Promise<{ aliasId: Id<"supplierAliases"> }> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      const alias = cleanText(args.alias, "Alias", MAX_NAME) ?? invalid("Alias is required.");
      const aliasKey = normalizeNameKey(alias);
      if (!aliasKey) invalid("Alias is required.");
      return withRegistryLock(ctx, args.orgId, async (lock) => {
        const supplier = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
        const rows = await loadAliases(ctx, args.orgId, supplier._id);
        if (rows.some((row) => row.status === "ACTIVE" && row.aliasKey === aliasKey)) {
          throwSupplierError(SUPPLIER_ERROR.ALIAS_EXISTS, "This supplier already has that alias.");
        }
        if (rows.length >= MAX_ALIAS_ROWS) {
          throwSupplierError(SUPPLIER_ERROR.ALIAS_LIMIT, `A supplier can have at most ${MAX_ALIAS_ROWS} aliases, retired ones included.`);
        }
        const aliasId = await insertSupplierAlias(ctx, lock, {
          orgId: args.orgId,
          supplierId: supplier._id,
          alias,
          aliasKey,
          source: "MANUAL",
          status: "ACTIVE",
          createdBy: user._id,
          createdAt: Date.now(),
        });
        await writeAuditLog(ctx, user, {
          action: "supplier.alias.add",
          targetTable: "supplierAliases",
          targetId: aliasId,
          orgId: args.orgId,
          after: { supplierId: supplier._id, alias, status: "ACTIVE" },
        });
        return { aliasId };
      });
    }),
});

export const retireAlias = mutation({
  args: { orgId: v.id("organizations"), aliasId: v.id("supplierAliases") },
  handler: async (ctx, args): Promise<null> =>
    runGuarded(async () => {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
      return withRegistryLock(ctx, args.orgId, async (lock) => {
        const alias = await requireOwnedRow(ctx, args.orgId, "supplierAliases", args.aliasId, SUPPLIER_ALIAS_NOT_FOUND_MESSAGE);
        if (alias.status === "RETIRED") {
          throwSupplierError(SUPPLIER_ERROR.ALIAS_ALREADY_RETIRED, "This alias is already retired.");
        }
        await patchSupplierAlias(ctx, lock, alias, { status: "RETIRED" });
        await writeAuditLog(ctx, user, {
          action: "supplier.alias.retire",
          targetTable: "supplierAliases",
          targetId: alias._id,
          orgId: args.orgId,
          before: { supplierId: alias.supplierId, alias: alias.alias, status: alias.status },
          after: { status: "RETIRED" },
        });
        return null;
      });
    }),
});

// ─── Registry bootstrap and backfill (internal) ───────────────────────────────────────────────

/** Creates the organization's registry document if it has none. Idempotent. */
export const initialiseRegistry = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<RegistryInitResult> =>
    runGuarded(async () => {
      const result = await ensureRegistryState(ctx, args.orgId);
      if (result.skipped === "ORG_MISSING") throw new ConvexError("Organization not found.");
      return result;
    }),
});

const BACKFILL_DEFAULT_BATCH = 50;
const BACKFILL_MAX_BATCH = 100;

type BackfillResult = { migrated: number; isDone: boolean; continueCursor: string | null };

/**
 * One-shot backfill for organizations that existed before the registry: one paginated read of
 * `organizations` per invocation, and one `ensureRegistryState` per organization. Idempotent, so
 * it resumes after interruption from the cursor it returns. Run it once per deployment after this
 * slice is deployed (it is not wired into the rollout script).
 */
export const backfillRegistry = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    continueAutomatically: v.optional(v.boolean()),
  },
  // Explicit: a self-scheduling function that infers its own return type makes the inference cyclic.
  handler: async (ctx, args): Promise<BackfillResult> =>
    runGuarded(async () => {
      const numItems = Math.min(Math.max(Math.floor(args.batchSize ?? BACKFILL_DEFAULT_BATCH), 1), BACKFILL_MAX_BATCH);
      const page = await ctx.db.query("organizations").paginate({ numItems, cursor: args.cursor ?? null });
      let migrated = 0;
      for (const org of page.page) {
        if ((await ensureRegistryState(ctx, org._id)).created) migrated += 1;
      }
      const result: BackfillResult = {
        migrated,
        isDone: page.isDone,
        continueCursor: page.isDone ? null : page.continueCursor,
      };
      if (!result.isDone && args.continueAutomatically !== false) {
        await ctx.scheduler.runAfter(0, internal.suppliers.backfillRegistry, {
          cursor: result.continueCursor,
          batchSize: args.batchSize,
        });
      }
      return result;
    }),
});
