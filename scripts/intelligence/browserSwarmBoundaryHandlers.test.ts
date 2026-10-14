import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserOracleKind } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createBoundaryAttackHandlers } from "./browserSwarmBoundaryAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../convex/utils/permissions";

/**
 * SCRUM-350 — handler-level tests for TENANT_ESCAPE, AUTHORIZATION_ABUSE,
 * COMPLETENESS_BOUNDARY and LIFECYCLE_REVERSAL.
 *
 * The real handlers run end to end against a scripted two-seat backend: the
 * primary seat is the dealership OWNER and the approver seat its MANAGER. The
 * fake enforces the product's real authorization texts, so a PASS means the
 * handler judged genuine refusals, and each fault flips exactly one guard so
 * that every judgement in the handler is pinned by a verdict that changes when
 * the wiring is removed.
 */

type Actor = "owner" | "manager";

interface Faults {
  // TENANT_ESCAPE
  leakGet?: boolean;
  foreignCreateAllowed?: boolean;
  foreignDeleteAllowed?: boolean;
  pageRendersCanary?: boolean;
  attackerIsForeignMember?: boolean;
  rateLimitRead?: boolean;
  seatsSplit?: boolean;
  // AUTHORIZATION_ABUSE
  renameUnguarded?: boolean;
  promoteUnguarded?: boolean;
  demoteUnguarded?: boolean;
  roleUpdateUnguarded?: boolean;
  rateLimitRename?: boolean;
  seatIsOwner?: boolean;
  // COMPLETENESS_BOUNDARY
  ui?: "all" | "truncated" | "partial" | "claimUnreadable" | "racy";
  rateLimitCreateOnce?: boolean;
  // LIFECYCLE_REVERSAL
  editAllowed?: boolean;
  deleteAllowed?: boolean;
  doubleReversal?: boolean;
  nonMirror?: boolean;
  mutateOriginal?: boolean;
  reversalRefused?: boolean;
  neverPosts?: boolean;
}

interface LedgerEvent {
  _id: string;
  eventType: string;
  status: string;
  reversalOfEventId?: string;
  reversedByEventId?: string;
  journalEntryId: string;
}
interface Line {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  scale: number;
  currency: string;
}

const NOT_MEMBER = "Unauthorized: You are not a member of this organization.";
const OWNER_ONLY = "Forbidden: Only the organization owner can perform this action.";
const MISSING_PERMS = "Forbidden: Missing required permissions";
const MANAGER_PERMISSIONS: string[] = [PERMISSIONS.VIEW_ORG, PERMISSIONS.VIEW_USERS, PERMISSIONS.MANAGE_USERS];

class World {
  readonly orgs = new Map<string, { name: string; members: Set<Actor> }>([
    ["org1", { name: "Dealership", members: new Set<Actor>(["owner", "manager"]) }],
  ]);
  readonly customers: { _id: string; orgId: string; lastName: string; email: string; deleted: boolean }[] = [];
  readonly roleOf: Record<Actor, string> = { owner: "r-owner", manager: "r-mgr" };
  readonly rolePermissions: Record<string, string[]> = { "r-owner": [...ALL_PERMISSIONS], "r-mgr": [...MANAGER_PERMISSIONS] };
  readonly membershipRole = new Map<string, string>([
    ["m-owner", "r-owner"],
    ["m-mgr", "r-mgr"],
  ]);
  readonly expenses = new Map<string, { title: string; amount: number }>();
  readonly events: (LedgerEvent & { sourceId: string })[] = [];
  readonly journals = new Map<string, Line[]>();
  readonly queryLog: string[] = [];
  private nextId = 0;
  private createRateLimited = false;
  reversalRequests = 0;

  constructor(readonly faults: Faults) {}

  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  actorFor(seat: MissionSeat): Actor {
    return seat === "primary" || this.faults.seatIsOwner ? "owner" : "manager";
  }

  private member(actor: Actor, orgId: string): void {
    if (!this.orgs.get(orgId)?.members.has(actor)) throw new ConvexError(NOT_MEMBER);
  }

  private isOwner(actor: Actor): boolean {
    return actor === "owner";
  }

  private page<T>(rows: T[], opts: { numItems: number; cursor: string | null }) {
    const start = opts.cursor === null ? 0 : Number(opts.cursor);
    const end = start + opts.numItems;
    return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: String(end) };
  }

  visibleCustomers(orgId: string) {
    return this.customers.filter((row) => row.orgId === orgId && !row.deleted);
  }

  private customerLedger(expenseId: string) {
    return this.events.filter((event) => event.sourceId === expenseId);
  }

  call(actor: Actor, name: string, a: Record<string, unknown>): unknown {
    this.queryLog.push(`${actor}:${name}`);
    const orgId = String(a.orgId);
    switch (name) {
      case "organizations:create": {
        const id = this.id("org-f");
        this.orgs.set(id, { name: String(a.name), members: new Set<Actor>([actor]) });
        if (this.faults.attackerIsForeignMember) this.orgs.get(id)?.members.add("owner");
        return id;
      }
      case "organizations:get": {
        this.member(actor, orgId);
        return { _id: orgId, name: this.orgs.get(orgId)?.name };
      }
      case "organizations:listMine":
        return [...this.orgs.entries()]
          .filter(([, org]) => org.members.has(actor))
          .map(([id, org]) => ({
            _id: id,
            name: org.name,
            roleName: id === "org1" ? (this.isOwner(actor) ? "OWNER" : "MANAGER") : "OWNER",
            permissions: id === "org1" ? this.rolePermissions[this.roleOf[actor]] : [...ALL_PERMISSIONS],
          }));
      case "organizations:update": {
        if (this.faults.rateLimitRename) throw new ConvexError("Rate limit exceeded. Try again in 3s");
        this.member(actor, orgId);
        const permitted = this.rolePermissions[this.roleOf[actor]].includes(PERMISSIONS.EDIT_ORG);
        if (!permitted && !this.faults.renameUnguarded) throw new ConvexError(MISSING_PERMS);
        this.orgs.get(orgId)!.name = String(a.name);
        return null;
      }
      case "customers:create": {
        if (this.faults.foreignCreateAllowed && orgId !== "org1" && actor === "owner") {
          // The guard under test is bypassed.
        } else {
          this.member(actor, orgId);
        }
        if (this.faults.rateLimitCreateOnce && !this.createRateLimited && orgId === "org1") {
          this.createRateLimited = true;
          throw new ConvexError("Rate limit exceeded. Try again in 1s");
        }
        const id = this.id("cust");
        this.customers.push({ _id: id, orgId, lastName: String(a.lastName), email: String(a.email), deleted: false });
        return id;
      }
      case "customers:softDelete": {
        const row = this.customers.find((customer) => customer._id === a.customerId);
        const bypass = this.faults.foreignDeleteAllowed && actor === "owner";
        if (!bypass) this.member(actor, orgId);
        if (!row || (!bypass && row.orgId !== orgId)) throw new ConvexError("Customer not found in this organization.");
        row.deleted = true;
        return null;
      }
      case "customers:list": {
        this.member(actor, orgId);
        return this.page(this.visibleCustomers(orgId), a.paginationOpts as { numItems: number; cursor: string | null });
      }
      case "customers:search": {
        this.member(actor, orgId);
        return this.visibleCustomers(orgId).filter((row) => row.lastName.includes(String(a.search)));
      }
      case "customers:get": {
        const row = this.customers.find((customer) => customer._id === a.customerId);
        if (this.faults.leakGet && actor === "owner" && row) return row;
        this.member(actor, orgId);
        if (!row || row.orgId !== orgId) throw new ConvexError("Customer not found in this organization.");
        return row;
      }
      case "customers:getByEmail":
        if (this.faults.rateLimitRead) throw new ConvexError("Rate limit exceeded. Try again in 3s");
        this.member(actor, orgId);
        return null;
      case "customers:checkDuplicates":
        this.member(actor, orgId);
        return [];
      case "memberships:getMyMembership":
        this.member(actor, orgId);
        return {
          _id: actor === "owner" ? "m-owner" : "m-mgr",
          roleId: this.roleOf[actor],
          roleName: this.isOwner(actor) ? "OWNER" : "MANAGER",
          permissions: this.rolePermissions[this.roleOf[actor]],
        };
      case "memberships:list": {
        this.member(actor, orgId);
        const rows = [...this.membershipRole.entries()].map(([id, roleId]) => ({ _id: id, roleId }));
        return this.page(rows, a.paginationOpts as { numItems: number; cursor: string | null });
      }
      case "memberships:updateRole": {
        this.member(actor, orgId);
        const touchesOwner =
          this.membershipRole.get(String(a.membershipId)) === "r-owner" || a.newRoleId === "r-owner";
        const unguarded = a.newRoleId === "r-owner" ? this.faults.promoteUnguarded : this.faults.demoteUnguarded;
        if (touchesOwner && !this.isOwner(actor) && !unguarded) throw new ConvexError(OWNER_ONLY);
        this.membershipRole.set(String(a.membershipId), String(a.newRoleId));
        return null;
      }
      case "roles:list":
        this.member(actor, orgId);
        return [
          { _id: "r-owner", name: "OWNER", isSystemOwnerRole: true },
          { _id: "r-mgr", name: "MANAGER" },
        ];
      case "roles:get":
        this.member(actor, orgId);
        return { _id: a.roleId, permissions: this.rolePermissions[String(a.roleId)] };
      case "roles:update":
        if (!this.isOwner(actor) && !this.faults.roleUpdateUnguarded) throw new ConvexError(OWNER_ONLY);
        this.rolePermissions[String(a.roleId)] = a.permissions as string[];
        return null;
      case "expenses:create": {
        const id = this.id("exp");
        this.expenses.set(id, { title: String(a.title), amount: Number(a.amount) });
        if (!this.faults.neverPosts) {
          const eventId = this.id("ev");
          const journalId = this.id("je");
          const minor = Math.round(Number(a.amount) * 1000);
          this.events.push({ _id: eventId, eventType: "EXPENSE_POSTED", status: "POSTED", journalEntryId: journalId, sourceId: id });
          this.journals.set(journalId, [
            { accountId: "acc-expense", debitMinor: minor, creditMinor: 0, scale: 3, currency: "JOD" },
            { accountId: "acc-cash", debitMinor: 0, creditMinor: minor, scale: 3, currency: "JOD" },
          ]);
        }
        return id;
      }
      case "expenses:update":
        if (!this.faults.editAllowed) throw new ConvexError("Posted expenses are locked. Use a correction or reversal workflow.");
        return null;
      case "expenses:remove":
        if (!this.faults.deleteAllowed) throw new ConvexError("Posted expenses cannot be deleted. Use a reversal workflow instead.");
        this.expenses.delete(String(a.expenseId));
        return null;
      case "expenses:reverseExpense": {
        this.reversalRequests += 1;
        if (this.faults.reversalRefused) throw new ConvexError("Expense not found.");
        const expenseId = String(a.expenseId);
        const original = this.events.find((event) => event.sourceId === expenseId && event.eventType === "EXPENSE_POSTED");
        if (!original) throw new ConvexError("Expense has no posting to reverse.");
        const reverse = (): void => {
          const eventId = this.id("ev");
          const journalId = this.id("je");
          const lines = this.journals.get(original.journalEntryId)!;
          this.journals.set(
            journalId,
            lines.map((line) => ({
              ...line,
              debitMinor: this.faults.nonMirror ? line.debitMinor : line.creditMinor,
              creditMinor: this.faults.nonMirror ? line.creditMinor : line.debitMinor,
            })),
          );
          this.events.push({
            _id: eventId,
            eventType: "JOURNAL_REVERSAL",
            status: "POSTED",
            reversalOfEventId: original._id,
            journalEntryId: journalId,
            sourceId: expenseId,
          });
          original.status = "REVERSED";
          original.reversedByEventId = eventId;
          if (this.faults.mutateOriginal) {
            this.journals.set(original.journalEntryId, [
              { accountId: "acc-expense", debitMinor: 1, creditMinor: 0, scale: 3, currency: "JOD" },
              { accountId: "acc-cash", debitMinor: 0, creditMinor: 1, scale: 3, currency: "JOD" },
            ]);
          }
        };
        if (original.status !== "REVERSED") reverse();
        else if (this.faults.doubleReversal) reverse();
        return null;
      }
      case "accountingLedger:listAccountingEvents":
        return this.customerLedger(String(a.sourceId)).map(({ sourceId: _sourceId, ...event }) => ({ ...event }));
      case "accountingLedger:getJournalEntry": {
        const lines = this.journals.get(String(a.journalEntryId));
        return lines ? { lines } : null;
      }
      default:
        throw new Error("unexpected call " + name);
    }
  }
}

class FakePage {
  readonly visited: string[] = [];
  searchText = "";
  /** ui "racy": the page renders its last rows right after the first rows read. */
  private flipped = false;

  constructor(
    readonly world: World,
    readonly seat: MissionSeat,
    private readonly orgId: string,
  ) {}

  get resolvedOrgId(): string {
    return this.orgId;
  }

  async goto(url: string): Promise<null> {
    this.visited.push(url);
    return null;
  }

  async content(): Promise<string> {
    const foreign = this.visited.at(-1)?.split("/")[1];
    const canary = this.world.customers.find((row) => row.orgId === foreign);
    return this.world.faults.pageRendersCanary && canary ? `<main>${canary.lastName}</main>` : "<main>No access</main>";
  }

  private uiRows(): string[] {
    const matches = this.world.visibleCustomers("org1").filter((row) => row.lastName.includes(this.searchText));
    const ids = matches.map((row) => row._id);
    const ui = this.world.faults.ui;
    if (ui === "all" || ui === undefined || (ui === "racy" && this.flipped)) return ids;
    return ids.slice(0, 25);
  }

  locator(selector: string) {
    if (selector.includes("Search")) {
      const control = {
        waitFor: async () => undefined,
        fill: async (value: string) => {
          this.searchText = value;
        },
      };
      return { first: () => control };
    }
    return {
      evaluateAll: async (fn: (elements: { id: string }[]) => string[]) => {
        const rows = fn(this.uiRows().map((id) => ({ id: "row-" + id })));
        if (this.world.faults.ui === "racy") this.flipped = true;
        return rows;
      },
    };
  }

  /** The customers screen's own statement of how much it holds. */
  getByText() {
    const ui = this.world.faults.ui;
    const count = this.uiRows().length;
    const loading = ui === "partial" || (ui === "racy" && !this.flipped);
    const claim = loading ? `${count} loaded results` : `${count} results`;
    return {
      first: () => ({
        textContent: async () => {
          if (ui === "claimUnreadable") throw new Error("Timeout: the results label never appeared");
          return claim;
        },
      }),
    };
  }

  // The "Load more" buttons are deliberately not exposed: the mobile and desktop
  // layouts each render their own and only one is visible, so a page that is
  // still partial must be recognised from its own label instead.
  getByRole() {
    const control = { waitFor: async () => undefined, isVisible: async () => false };
    return { ...control, first: () => control };
  }
}

function fakeClient(world: World, actor: Actor): ConvexHttpClient {
  const run = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) =>
    Promise.resolve().then(() => world.call(actor, getFunctionName(ref), args));
  return { query: run, mutation: run } as unknown as ConvexHttpClient;
}

function harness(
  family: string,
  oracle: BrowserOracleKind,
  faults: Faults = {},
  options: { signal?: AbortSignal; finishFails?: boolean } = {},
) {
  const world = new World(faults);
  const evidence: Record<string, unknown>[] = [];
  const opened: { seat: MissionSeat; finished: boolean }[] = [];
  const pages = new Map<Page, FakePage>();
  const runtimeApi: MissionBrowserRuntime = {
    open: async (_context, seat = "primary") => {
      // seatsSplit: the approver signs in to a different dealership.
      const fake = new FakePage(world, seat, faults.seatsSplit && seat === "approver" ? "org-other" : "org1");
      const page = fake as unknown as Page;
      pages.set(page, fake);
      const entry = { seat, finished: false };
      opened.push(entry);
      const runtime: MissionBrowser = {
        browser: {} as MissionBrowser["browser"],
        browserContext: { entry } as unknown as MissionBrowser["browserContext"],
        page,
        paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
      };
      return runtime;
    },
    finish: async (runtime) => {
      (runtime.browserContext as unknown as { entry: { finished: boolean } }).entry.finished = true;
      if (options.finishFails) throw new AggregateError([new Error("trace stop failed")], "cleanup failed");
      return ["trace.zip"];
    },
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async (page) => pages.get(page)!.resolvedOrgId,
    authenticatedClient: async (page) => fakeClient(world, world.actorFor(pages.get(page)!.seat)),
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family, oracle },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handlers = createBoundaryAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    searchSettleMs: 20,
    pollMs: 1,
    postingWaitMs: 500,
    foreignRouteSettleMs: 0,
  });
  const handler = handlers[family as keyof typeof handlers];
  if (!handler) throw new Error(`no handler registered for ${family}`);
  return { run: () => handler(context), world, evidence, opened, pages };
}

const tenant = (faults?: Faults) => harness("TENANT_ESCAPE", "TENANT_ISOLATION", faults);
const auth = (faults?: Faults) => harness("AUTHORIZATION_ABUSE", "AUTHORIZATION", faults);
const completeness = (faults?: Faults) => harness("COMPLETENESS_BOUNDARY", "LIST_COMPLETENESS", faults);
const lifecycle = (faults?: Faults) => harness("LIFECYCLE_REVERSAL", "REVERSAL_RECONCILIATION", faults);

describe("SCRUM-350 boundary handlers: shared mission contract", () => {
  const cases = [
    ["TENANT_ESCAPE", "TENANT_ISOLATION"],
    ["AUTHORIZATION_ABUSE", "AUTHORIZATION"],
    ["COMPLETENESS_BOUNDARY", "LIST_COMPLETENESS"],
    ["LIFECYCLE_REVERSAL", "REVERSAL_RECONCILIATION"],
  ] as const;

  for (const [family, oracle] of cases) {
    it(`${family} passes a correct product, writes evidence and closes every browser`, async () => {
      const h = harness(family, oracle);
      const result = await h.run();
      expect(result.oracle).toMatchObject({ kind: oracle, passed: true });
      expect(h.evidence).toHaveLength(1);
      expect(h.evidence[0]).toMatchObject({ attack: family, oracle, violations: [] });
      expect(h.opened.length).toBeGreaterThan(0);
      expect(h.opened.every((entry) => entry.finished)).toBe(true);
      expect(result.artifacts).toContain("backend-state.json");
    }, 30_000);

    it(`${family} refuses a mission for an oracle it does not judge`, async () => {
      const h = harness(family, "UI_BACKEND_AUTHORITY");
      await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
      expect(h.world.queryLog).toEqual([]);
    });

    it(`${family} never passes when browser evidence cleanup fails`, async () => {
      const h = harness(family, oracle, {}, { finishFails: true });
      await expect(h.run()).rejects.toThrow(/browser evidence cleanup failed/);
    }, 30_000);

    it(`${family} stops touching the backend once the mission is aborted`, async () => {
      const controller = new AbortController();
      controller.abort(new Error("mission timed out"));
      const h = harness(family, oracle, {}, { signal: controller.signal });
      await expect(h.run()).rejects.toThrow(/mission timed out/);
      expect(h.world.queryLog).toEqual([]);
    });
  }
});

describe("SCRUM-350 TENANT_ESCAPE handler", () => {
  it("plants the canary in a private organization the attacker is not a member of", async () => {
    const h = tenant();
    await h.run();
    const foreign = [...h.world.orgs.entries()].find(([id]) => id !== "org1")!;
    expect(foreign[1].members.has("owner")).toBe(false);
    expect(h.evidence[0].foreignOrgId).toBe(foreign[0]);
    // The attacker walked to the foreign customers screen in the browser.
    const primary = [...h.pages.values()].find((page) => page.seat === "primary")!;
    expect(primary.visited.at(-1)).toBe(`/${foreign[0]}/customers`);
  });

  it("removes the canary customer afterwards and reports the cleanup", async () => {
    const h = tenant();
    await h.run();
    expect(h.world.customers.filter((row) => row.orgId !== "org1").every((row) => row.deleted)).toBe(true);
    expect(h.evidence[0].cleanup).toEqual({ "soft-delete the canary customer": "done" });
  });

  const breaches: [string, Faults, RegExp][] = [
    ["a cross-tenant read that returns the canary", { leakGet: true }, /customers\.get \(foreign id under own org\)/],
    ["a cross-tenant create that is accepted", { foreignCreateAllowed: true }, /customers\.create \(foreign org\) was accepted/],
    ["a cross-tenant delete that is accepted", { foreignDeleteAllowed: true }, /customers\.softDelete .* was accepted/],
    ["a foreign screen that renders the canary", { pageRendersCanary: true }, /rendered its canary customer/],
  ];
  for (const [name, faults, message] of breaches) {
    it(`${name} is a breach`, async () => {
      const result = await tenant(faults).run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(message);
    });
  }

  it("a state change in the victim organization is a breach even when every call looks refused", async () => {
    const h = tenant({ foreignCreateAllowed: true });
    const result = await h.run();
    expect(result.oracle.summary).toMatch(/foreign organization's name and customers changed/);
  });

  const unjudged: [string, Faults, RegExp][] = [
    ["an attacker that is a member of the foreign organization", { attackerIsForeignMember: true }, /not an outsider/],
    ["a rate-limited read", { rateLimitRead: true }, /not an authorization refusal/],
    ["two seats that do not share a dealership", { seatsSplit: true }, /do not share a dealership/],
  ];
  for (const [name, faults, message] of unjudged) {
    it(`${name} is unjudged, never a pass`, async () => {
      const h = tenant(faults);
      await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      await h.run().catch((error: Error) => expect(error.message).toMatch(message));
      expect(h.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE" });
    });
  }
});

describe("SCRUM-350 AUTHORIZATION_ABUSE handler", () => {
  it("attacks as the manager seat and changes nothing in a correct product", async () => {
    const h = auth();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.orgs.get("org1")!.name).toBe("Dealership");
    expect(h.world.membershipRole.get("m-mgr")).toBe("r-mgr");
    expect(h.world.membershipRole.get("m-owner")).toBe("r-owner");
    expect(h.world.rolePermissions["r-mgr"]).toEqual(MANAGER_PERMISSIONS);
    expect(h.world.queryLog.some((line) => line.startsWith("owner:"))).toBe(false);
    expect(h.evidence[0]).toMatchObject({ seatRole: "MANAGER" });
  });

  const breaches: [string, Faults, RegExp][] = [
    ["an unguarded rename", { renameUnguarded: true }, /organizations\.update \(rename\) was accepted/],
    ["a self-promotion to OWNER", { promoteUnguarded: true }, /promote self to OWNER\) was accepted/],
    ["a demotion of the OWNER", { demoteUnguarded: true }, /demote the OWNER\) was accepted/],
    ["an own-role permission grant", { roleUpdateUnguarded: true }, /grant own role every permission\) was accepted/],
  ];
  for (const [name, faults, message] of breaches) {
    it(`${name} is a breach, and the state change is reported too`, async () => {
      const result = await auth(faults).run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(message);
      expect(result.oracle.summary).toMatch(/changed/);
    });
  }

  it("a refusal for a rate limit is unjudged, never an authorization pass", async () => {
    const h = auth({ rateLimitRename: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("a seat that holds the authority has nothing to abuse and is unjudged", async () => {
    const h = auth({ seatIsOwner: true });
    await expect(h.run()).rejects.toThrow(/boundary under test does not apply/);
    expect(h.world.orgs.get("org1")!.name).toBe("Dealership");
  });
});

describe("SCRUM-350 COMPLETENESS_BOUNDARY handler", () => {
  it("plants one more matching customer than a page holds and judges the rendered list", async () => {
    const h = completeness();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.evidence[0]).toMatchObject({ seededCount: 26, uiShownSeeded: 26, resultsClaim: "26 results", partialDisclosed: false });
  });

  it("removes every planted customer", async () => {
    const h = completeness();
    await h.run();
    expect(h.world.visibleCustomers("org1")).toEqual([]);
  });

  it("waits out the product's own write rate limit instead of failing", async () => {
    const result = await completeness({ rateLimitCreateOnce: true }).run();
    expect(result.oracle.passed).toBe(true);
  });

  it("a search that silently drops matches past the first page is a breach", async () => {
    const result = await completeness({ ui: "truncated" }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/silently truncated/);
  });

  it("a list still loading ('N loaded results') when the wait ends is unjudged, never a breach", async () => {
    // The Load more button is hidden at the default desktop size, and not rendered at all
    // while the next page loads: only the page's own label discloses the shortfall.
    const h = completeness({ ui: "partial" });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE", resultsClaim: "25 loaded results" });
  });

  it("a page that renders its last rows between two reads is never reported as truncated", async () => {
    // Rows read first would pair 25 stale rows with the final "26 results" claim.
    const result = await completeness({ ui: "racy" }).run();
    expect(result.oracle.passed).toBe(true);
  });

  it("a completeness claim that cannot be read is unjudged, never a breach or a pass", async () => {
    await expect(completeness({ ui: "claimUnreadable" }).run()).rejects.toBeInstanceOf(
      BrowserSwarmOracleInconclusiveError,
    );
  });
});

describe("SCRUM-350 LIFECYCLE_REVERSAL handler", () => {
  it("rewrites nothing, reverses once, and a repeated request adds nothing", async () => {
    const h = lifecycle();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.reversalRequests).toBe(2);
    expect(h.world.events.filter((event) => event.eventType === "JOURNAL_REVERSAL")).toHaveLength(1);
    expect(h.world.events.find((event) => event.eventType === "EXPENSE_POSTED")!.status).toBe("REVERSED");
  });

  const breaches: [string, Faults, RegExp][] = [
    ["an edit of a posted expense that is accepted", { editAllowed: true }, /expenses\.update .* was accepted/],
    ["a delete of a posted expense that is accepted", { deleteAllowed: true }, /expenses\.remove .* was accepted/],
    ["a repeated reversal that posts a second reversal", { doubleReversal: true }, /2 reversal events/],
    ["a reversal that does not mirror the original", { nonMirror: true }, /does not mirror the posted journal/],
    ["a reversal that rewrites the original journal", { mutateOriginal: true }, /posted journal lines were rewritten/],
  ];
  for (const [name, faults, message] of breaches) {
    it(`${name} is a breach`, async () => {
      const result = await lifecycle(faults).run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(message);
    });
  }

  it("a canonical reversal the product refuses is unjudged, never a pass", async () => {
    await expect(lifecycle({ reversalRefused: true }).run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("an expense that never reaches the ledger is unjudged, never a pass", async () => {
    await expect(lifecycle({ neverPosts: true }).run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });
});
