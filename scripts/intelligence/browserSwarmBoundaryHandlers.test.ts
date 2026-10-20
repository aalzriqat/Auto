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
  /** The foreign route never leaves its loading state. */
  routeStuck?: boolean;
  /** The foreign route finishes loading but the page stays on the foreign organization. */
  routeStaysForeign?: boolean;
  // AUTHORIZATION_ABUSE
  renameUnguarded?: boolean;
  promoteUnguarded?: boolean;
  demoteUnguarded?: boolean;
  /** Only the Team screen's request gets past the guard, never a direct backend call. */
  demoteUnguardedForUi?: boolean;
  roleUpdateUnguarded?: boolean;
  rateLimitRename?: boolean;
  seatIsOwner?: boolean;
  /** The Team screen offers no Change Role control on the OWNER row. */
  teamNoControl?: boolean;
  teamUnreachable?: boolean;
  /** The Team screen's role change fails for a reason that is not an authorization refusal. */
  teamError?: "rateLimited" | "validation" | "transport";
  // COMPLETENESS_BOUNDARY
  ui?: "all" | "truncated" | "partial" | "claimUnreadable" | "racy";
  rateLimitCreateOnce?: boolean;
  // LIFECYCLE_REVERSAL
  editAllowed?: boolean;
  deleteAllowed?: boolean;
  doubleReversal?: boolean;
  nonMirror?: boolean;
  mutateOriginal?: boolean;
  /** The canonical reversal the expense screen asks for is refused (rate limited). */
  reversalRefused?: boolean;
  neverPosts?: boolean;
  /** The repeated reversal request fails for a reason that is not "Expense not found". */
  replayError?: "rateLimited" | "forbidden" | "invalid";
  /** The repeated reversal is accepted outright, leaving the ledger untouched. */
  replayAccepted?: boolean;
  /** The repeated reversal is refused as "Expense not found" yet leaves an unlinked reversal behind. */
  strayOnReplay?: boolean;
  /** The seeded expense is posted as something other than a balanced entry of its amount. */
  posting?: "unbalanced" | "zero" | "wrongAmount" | "wrongCurrency";
  /** What the organization's settings say its currency is; "missing" returns no settings at all. */
  settings?: "missing" | "usd";
  uiNoRow?: boolean;
  /** Clicking Delete Permanently does nothing, so the reversal form never appears. */
  uiNoFlip?: boolean;
  /** The Reverse & Delete click closes the dialog without asking the backend. */
  uiReverseNoOp?: boolean;
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
  /** What the browser did, as opposed to the direct backend probes in queryLog. */
  readonly uiLog: string[] = [];
  readonly deletedExpenses = new Set<string>();
  readonly emails = new Map<string, string>([
    ["m-owner", "owner@example.test"],
    ["m-mgr", "manager@example.test"],
  ]);
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
        const rows = [...this.membershipRole.entries()].map(([id, roleId]) => ({
          _id: id,
          roleId,
          userEmail: this.emails.get(id),
        }));
        return this.page(rows, a.paginationOpts as { numItems: number; cursor: string | null });
      }
      case "memberships:updateRole": {
        if (a.viaUi === true && this.faults.teamError) {
          if (this.faults.teamError === "transport") throw new Error("Failed to fetch");
          throw new ConvexError(this.faults.teamError === "rateLimited" ? "Rate limit exceeded. Try again in 3s" : "Invalid role selection.");
        }
        this.member(actor, orgId);
        const touchesOwner =
          this.membershipRole.get(String(a.membershipId)) === "r-owner" || a.newRoleId === "r-owner";
        const unguarded =
          a.newRoleId === "r-owner"
            ? this.faults.promoteUnguarded
            : this.faults.demoteUnguarded || (this.faults.demoteUnguardedForUi && a.viaUi === true);
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
      case "orgSettings:get":
        this.member(actor, orgId);
        if (this.faults.settings === "missing") return null;
        return { orgId, currency: this.faults.settings === "usd" ? "USD" : "JOD" };
      case "expenses:create": {
        const id = this.id("exp");
        this.expenses.set(id, { title: String(a.title), amount: Number(a.amount) });
        if (!this.faults.neverPosts) {
          const eventId = this.id("ev");
          const journalId = this.id("je");
          const { posting } = this.faults;
          const usd = posting === "wrongCurrency";
          const seeded = Math.round(Number(a.amount) * (usd ? 100 : 1000));
          const debit = posting === "zero" ? 0 : posting === "wrongAmount" ? Math.round(seeded / 10) : seeded;
          const credit = posting === "unbalanced" ? seeded - 1000 : debit;
          const currency = usd ? "USD" : "JOD";
          const scale = usd ? 2 : 3;
          this.events.push({ _id: eventId, eventType: "EXPENSE_POSTED", status: "POSTED", journalEntryId: journalId, sourceId: id });
          this.journals.set(journalId, [
            { accountId: "acc-expense", debitMinor: debit, creditMinor: 0, scale, currency },
            { accountId: "acc-cash", debitMinor: 0, creditMinor: credit, scale, currency },
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
        const replay = this.reversalRequests >= 2;
        if (this.faults.reversalRefused && !replay) throw new ConvexError("Rate limit exceeded. Try again in 3s");
        const expenseId = String(a.expenseId);
        if (replay && this.faults.replayError) {
          throw new ConvexError(
            {
              rateLimited: "Rate limit exceeded. Try again in 3s",
              forbidden: "Forbidden: Missing required permissions",
              invalid: "A reason is required to reverse an expense.",
            }[this.faults.replayError],
          );
        }
        if (replay && this.faults.replayAccepted) return null;
        if (replay && this.faults.strayOnReplay) {
          this.events.push({
            _id: this.id("ev"),
            eventType: "JOURNAL_REVERSAL",
            status: "POSTED",
            journalEntryId: this.id("je"),
            sourceId: expenseId,
          });
          throw new ConvexError("Expense not found.");
        }
        // The real mutation soft-deletes the expense once it has reversed it.
        if (this.deletedExpenses.has(expenseId) && !this.faults.doubleReversal) throw new ConvexError("Expense not found.");
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
        if (original.status !== "REVERSED" || this.faults.doubleReversal) reverse();
        this.deletedExpenses.add(expenseId);
        return null;
      }
      case "accountingOutbox:listPending":
        // A never-posting expense is verifiably waiting in the outbox.
        if (!this.faults.neverPosts || a.status !== "PENDING") return [];
        return [...this.expenses.keys()].map((sourceId) => ({
          kind: "POST",
          status: "PENDING",
          sourceType: "expenses",
          sourceId,
          eventType: "EXPENSE_POSTED",
          attempts: 0,
        }));
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

const timeout = (what: string) => new Error(`Timeout 10000ms exceeded waiting for ${what}`);

class FakePage {
  readonly visited: string[] = [];
  searchText = "";
  /** ui "racy": the page renders its last rows right after the first rows read. */
  private flipped = false;
  // Expenses screen: the delete dialog and its reversal form.
  private deleteTarget: string | null = null;
  private needsReversal = false;
  private reason = "";
  // Team screen: the Change Role dialog.
  private roleTarget: string | null = null;
  private pickedRole: string | null = null;
  /** sonner toasts as the product raises them: access refusals are untyped, other failures are errors. */
  private toast: { type: "default" | "error"; title: string; description: string } | null = null;

  constructor(
    readonly world: World,
    readonly seat: MissionSeat,
    private readonly orgId: string,
  ) {}

  get resolvedOrgId(): string {
    return this.orgId;
  }

  private get actor(): Actor {
    return this.world.actorFor(this.seat);
  }

  async goto(url: string): Promise<null> {
    this.visited.push(url);
    return null;
  }

  private get foreignRoute(): string | null {
    const segment = this.visited.at(-1)?.split("/")[1];
    return segment && segment !== this.orgId && this.world.orgs.has(segment) ? segment : null;
  }

  /** A non-member is sent to their own organization once the workspace has loaded. */
  url(): string {
    const { routeStuck, routeStaysForeign, pageRendersCanary } = this.world.faults;
    const stuck = routeStuck || routeStaysForeign || pageRendersCanary;
    return this.foreignRoute && !stuck ? `/${this.orgId}/customers` : (this.visited.at(-1) ?? "/");
  }

  async content(): Promise<string> {
    const foreign = this.foreignRoute;
    if (foreign && this.world.faults.routeStuck) return "<main>Loading your workspace...</main>";
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

  private closeDialogs(): void {
    this.deleteTarget = null;
    this.needsReversal = false;
    this.reason = "";
    this.roleTarget = null;
    this.pickedRole = null;
  }

  private async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.world.uiLog.push(`${this.actor}:${name}`);
    return Promise.resolve().then(() => this.world.call(this.actor, name, args));
  }

  private async clickDelete(): Promise<void> {
    if (this.world.faults.uiNoFlip || this.deleteTarget === null || this.needsReversal) return;
    try {
      await this.run("expenses:remove", { orgId: this.orgId, expenseId: this.deleteTarget });
      this.closeDialogs();
    } catch (error) {
      if (error instanceof ConvexError && /posted expenses cannot be deleted/i.test(String(error.data))) {
        this.needsReversal = true;
      }
    }
  }

  private async clickReverse(): Promise<void> {
    if (this.deleteTarget === null || !this.needsReversal || !this.reason.trim()) return;
    if (this.world.faults.uiReverseNoOp) {
      this.world.uiLog.push("ui:reverse-click-without-request");
      this.closeDialogs();
      return;
    }
    try {
      await this.run("expenses:reverseExpense", { orgId: this.orgId, expenseId: this.deleteTarget, reason: this.reason });
      this.closeDialogs();
    } catch {
      // The product toasts the failure and keeps the dialog open.
    }
  }

  private async clickSaveRole(): Promise<void> {
    if (this.roleTarget === null || this.pickedRole === null) return;
    try {
      await this.run("memberships:updateRole", {
        orgId: this.orgId,
        membershipId: this.roleTarget,
        newRoleId: this.pickedRole,
        viaUi: true,
      });
      this.closeDialogs();
    } catch (error) {
      const text = error instanceof ConvexError ? String(error.data) : (error as Error).message;
      // components/ui/sonner.tsx rewrites an access refusal into a calm, typeless toast.
      this.toast = /only the organization owner/i.test(text)
        ? { type: "default", title: "Access restricted", description: "Only the organization owner can perform this action." }
        : { type: "error", title: text, description: "" };
    }
  }

  private dialog() {
    const open = () => this.deleteTarget !== null || this.roleTarget !== null;
    const button = (name: string) => ({
      click: async () => {
        if (!open()) throw timeout(`the "${name}" button`);
        if (name === "Delete Permanently") await this.clickDelete();
        else if (name === "Reverse & Delete") await this.clickReverse();
        else if (name === "Save") await this.clickSaveRole();
        else throw timeout(`the "${name}" button`);
      },
    });
    return {
      getByRole: (_role: string, options: { name: string }) => button(options.name),
      getByTestId: (testId: string) => ({
        click: async () => {
          this.pickedRole = testId.replace("searchable-option-", "");
        },
      }),
      locator: (selector: string) => {
        if (selector === "#reversal-reason") {
          return {
            waitFor: async () => {
              if (!this.needsReversal) throw timeout("the reversal reason field");
            },
            fill: async (value: string) => {
              this.reason = value;
            },
          };
        }
        return { first: () => ({ click: async () => undefined }) };
      },
      waitFor: async ({ state }: { state: "hidden" | "visible" }) => {
        if ((state === "hidden") === open()) throw timeout(`the dialog to be ${state}`);
      },
      isVisible: async () => open(),
    };
  }

  private expenseRow(id: string) {
    const exists = () => this.world.expenses.has(id) && !this.world.deletedExpenses.has(id) && !this.world.faults.uiNoRow;
    return {
      waitFor: async () => {
        if (!exists()) throw timeout(`the row of expense ${id}`);
      },
      getByRole: () => ({
        last: () => ({
          click: async () => {
            this.deleteTarget = id;
            this.needsReversal = false;
          },
        }),
      }),
    };
  }

  private teamRow(hasText: string) {
    const present = () => !this.world.faults.teamUnreachable && [...this.world.emails.values()].includes(hasText);
    const ownerRow = hasText === this.world.emails.get("m-owner");
    return {
      waitFor: async () => {
        if (!present()) throw timeout(`the team row of ${hasText}`);
      },
      getByRole: () => ({
        isVisible: async () => ownerRow && !this.world.faults.teamNoControl,
        isEnabled: async () => true,
        click: async () => {
          this.roleTarget = "m-owner";
          this.pickedRole = null;
        },
      }),
    };
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
    const row = /^#row-(.+)$/.exec(selector);
    if (row) return this.expenseRow(row[1]!);
    if (selector === "tr") return { filter: ({ hasText }: { hasText: string }) => this.teamRow(hasText) };
    if (selector.includes("sonner")) {
      // Honour the selector: "[data-type='error']" needs a typed error toast, ":not([data-type='success'])" any other.
      const wantsError = selector.includes("[data-type='error']");
      const toast = wantsError && this.toast?.type !== "error" ? null : this.toast;
      return {
        first: () => ({
          isVisible: async () => toast !== null,
          // Like the DOM: textContent runs the title and description together, innerText separates them.
          textContent: async () => (toast ? toast.title + toast.description : null),
          innerText: async () => (toast ? [toast.title, toast.description].filter(Boolean).join("\n") : ""),
        }),
      };
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
  getByRole(role?: string) {
    if (role === "dialog") return this.dialog();
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
    uiSettleMs: 0,
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

  it("records where the foreign route settled and that the canary never rendered", async () => {
    const h = tenant();
    await h.run();
    expect(h.evidence[0].foreignRoute).toMatchObject({ leftForeignOrganization: true, rendersCanary: false });
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
    ["a foreign route that never leaves its loading state", { routeStuck: true }, /never settled/],
    ["a foreign route that finishes loading but stays on the foreign organization", { routeStaysForeign: true }, /never settled/],
  ];
  for (const [name, faults, message] of unjudged) {
    it(`${name} is unjudged, never a pass`, async () => {
      const h = tenant(faults);
      // One run only: a second run on the same world would see state the first left behind.
      const error: unknown = await h.run().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      expect((error as Error).message).toMatch(message);
      expect(h.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE", reason: (error as Error).message });
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
    // Nothing was accepted, so nothing is claimed about the shared preview.
    expect(h.evidence[0]).not.toHaveProperty("sharedPreviewMutated");
  });

  it("also attacks through the Team screen as the manager and the backend refuses it", async () => {
    const h = auth();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.uiLog).toEqual(["manager:memberships:updateRole"]);
    expect(h.evidence[0].teamScreen).toMatchObject({ control: "attempted", answer: "refused" });
    expect(h.world.membershipRole.get("m-owner")).toBe("r-owner");
  });

  it("a Team screen that withholds the control is recorded, and the backend probes still judge", async () => {
    const h = auth({ teamNoControl: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.uiLog).toEqual([]);
    expect(h.evidence[0].teamScreen).toMatchObject({ control: "withheld" });
  });

  it("a demotion of the OWNER that only the Team screen gets through is a breach", async () => {
    const h = auth({ demoteUnguardedForUi: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/Team screen.*demote the OWNER/);
    expect(result.oracle.summary).toMatch(/changed/);
    expect(h.evidence[0]).toMatchObject({ sharedPreviewMutated: expect.stringContaining("not independent") });
  });

  it("a Team screen refusal for the owner-only guard is recorded as the authorization refusal", async () => {
    const h = auth();
    await h.run();
    expect(h.evidence[0].teamScreen).toMatchObject({
      answer: "refused",
      message: expect.stringMatching(/Access restricted\nOnly the organization owner/),
    });
  });

  const teamErrors: [string, NonNullable<Faults["teamError"]>][] = [
    ["a rate limit", "rateLimited"],
    ["a validation failure", "validation"],
    ["a network failure", "transport"],
  ];
  for (const [name, teamError] of teamErrors) {
    it(`a Team screen error toast for ${name} is unjudged, never an authorization refusal`, async () => {
      const h = auth({ teamError });
      const error: unknown = await h.run().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      expect((error as Error).message).toMatch(/not an authorization refusal/);
      expect(h.evidence.at(-1)?.teamScreen).toMatchObject({ answer: "unclassified" });
    });
  }

  it("a Team screen that cannot be driven is unjudged, never a pass", async () => {
    const error: unknown = await auth({ teamUnreachable: true })
      .run()
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((error as Error).message).toMatch(/Team screen/);
  });

  const breaches: [string, Faults, RegExp][] = [
    ["an unguarded rename", { renameUnguarded: true }, /organizations\.update \(rename\) was accepted/],
    ["a self-promotion to OWNER", { promoteUnguarded: true }, /promote self to OWNER\) was accepted/],
    ["a demotion of the OWNER", { demoteUnguarded: true }, /demote the OWNER\) was accepted/],
    ["an own-role permission grant", { roleUpdateUnguarded: true }, /grant own role every permission\) was accepted/],
  ];
  for (const [name, faults, message] of breaches) {
    it(`${name} is a breach, and the state change is reported too`, async () => {
      const h = auth(faults);
      const result = await h.run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(message);
      expect(result.oracle.summary).toMatch(/changed/);
      // The preview is shared by every worker and cannot be restored by the seat that lost authority.
      expect(h.evidence[0]).toMatchObject({ sharedPreviewMutated: expect.stringContaining("not independent") });
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
  it("rewrites nothing, reverses once through the expense screen, and a repeated request adds nothing", async () => {
    const h = lifecycle();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    // The canonical reversal is the expense screen's own; only the repeat is a direct probe.
    expect(h.world.uiLog).toEqual(["owner:expenses:remove", "owner:expenses:reverseExpense"]);
    expect(h.world.reversalRequests).toBe(2);
    expect(h.world.events.filter((event) => event.eventType === "JOURNAL_REVERSAL")).toHaveLength(1);
    expect(h.world.events.find((event) => event.eventType === "EXPENSE_POSTED")!.status).toBe("REVERSED");
    expect(h.evidence[0].reversalVia).toBe("expense screen");
  });

  it("treats the product's 'Expense not found' as the legitimate refusal of a repeated reversal", async () => {
    const h = lifecycle();
    await h.run();
    expect(h.evidence[0].probes).toContainEqual(
      expect.objectContaining({ label: "expenses.reverseExpense (second request)", outcome: "REFUSED", message: "Expense not found." }),
    );
  });

  const breaches: [string, Faults, RegExp][] = [
    ["an edit of a posted expense that is accepted", { editAllowed: true }, /expenses\.update .* was accepted/],
    ["a delete of a posted expense that is accepted", { deleteAllowed: true }, /expenses\.remove .* was accepted/],
    ["a repeated reversal that posts a second reversal", { doubleReversal: true }, /2 reversal events/],
    ["a reversal that does not mirror the original", { nonMirror: true }, /does not mirror the posted journal/],
    ["a reversal that rewrites the original journal", { mutateOriginal: true }, /posted journal lines were rewritten/],
    ["a refused repeat that still leaves an unlinked reversal behind", { strayOnReplay: true }, /not linked to the posted event/],
    ["an unbalanced posting that its exact mirror reverses", { posting: "unbalanced" }, /posted journal is not balanced/],
    ["a zero posting that its exact mirror reverses", { posting: "zero" }, /zero posting/],
    ["a balanced posting of the wrong amount", { posting: "wrongAmount" }, /minor units but the seeded expense is 53000/],
    [
      "a consistent 53 USD posting and mirror in a JOD organization",
      { posting: "wrongCurrency" },
      /posted in USD but the organization's currency is JOD/,
    ],
    [
      "a JOD posting in an organization whose settings say USD",
      { settings: "usd" },
      /posted in JOD but the organization's currency is USD/,
    ],
  ];
  for (const [name, faults, message] of breaches) {
    it(`${name} is a breach`, async () => {
      const result = await lifecycle(faults).run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(message);
    });
  }

  const replayFailures: [string, Faults["replayError"]][] = [
    ["a rate limit", "rateLimited"],
    ["a missing permission", "forbidden"],
    ["a validation failure", "invalid"],
  ];
  for (const [name, replayError] of replayFailures) {
    it(`a repeated reversal refused for ${name} is unjudged, never an unchanged-ledger pass`, async () => {
      const h = lifecycle({ replayError });
      await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      expect(h.evidence.at(-1)).toMatchObject({
        outcome: "INCONCLUSIVE",
        reason: expect.stringContaining("repeated reversal"),
      });
      expect(h.evidence.at(-1)?.probes).toContainEqual(
        expect.objectContaining({ label: "expenses.reverseExpense (second request)", outcome: "UNCLASSIFIED" }),
      );
    });
  }

  it("an organization currency that cannot be read independently is unjudged, never a pass", async () => {
    const h = lifecycle({ settings: "missing" });
    const error: unknown = await h.run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((error as Error).message).toMatch(/organization's currency was not readable/);
  });

  it("reads the organization's currency before the expense exists", async () => {
    const h = lifecycle();
    await h.run();
    expect(h.evidence[0].expectedCurrency).toBe("JOD");
    expect(h.world.queryLog.indexOf("owner:orgSettings:get")).toBeLessThan(h.world.queryLog.indexOf("owner:expenses:create"));
  });

  it("a repeated reversal that is accepted is unjudged: the pass would claim a refusal that never happened", async () => {
    const h = lifecycle({ replayAccepted: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence.at(-1)).toMatchObject({
      outcome: "INCONCLUSIVE",
      reason: expect.stringContaining("accepted rather than refused"),
    });
  });

  it("a repeated reversal that proves a breach still wins over an unjudged replay", async () => {
    const result = await lifecycle({ replayError: "rateLimited", mutateOriginal: true }).run();
    expect(result.oracle.passed).toBe(false);
  });

  const uiBlocked: [string, Faults, RegExp][] = [
    ["an expense row that never appears", { uiNoRow: true }, /expense screen/],
    ["a delete that never offers the reversal form", { uiNoFlip: true }, /expense screen/],
    ["a reversal the screen cannot complete", { reversalRefused: true }, /expense screen/],
  ];
  for (const [name, faults, message] of uiBlocked) {
    it(`${name} is unjudged and never falls back to a direct canonical reversal`, async () => {
      const h = lifecycle(faults);
      const error: unknown = await h.run().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      expect((error as Error).message).toMatch(message);
      expect(h.world.events.filter((event) => event.eventType === "JOURNAL_REVERSAL")).toHaveLength(0);
    });
  }

  it("a screen that claims the reversal happened when the ledger never got one is not a pass", async () => {
    const h = lifecycle({ uiReverseNoOp: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.world.uiLog).toContain("ui:reverse-click-without-request");
  });

  it("an expense that never reaches the ledger is unjudged, never a pass", async () => {
    await expect(lifecycle({ neverPosts: true }).run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("does not extend the posting wait for a queued row: only the navigation mission opts in (SCRUM-851)", async () => {
    const h = lifecycle({ neverPosts: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    // The outbox was inspected and does hold the waiting row, yet the ledger was read only for the base wait.
    expect(h.world.queryLog).toContain("owner:accountingOutbox:listPending");
    expect(h.world.queryLog.filter((line) => line === "owner:accountingLedger:listAccountingEvents").length).toBeLessThanOrEqual(40);
    expect(h.evidence[0]?.ledgerSettleTimeouts).toMatchObject([
      { extendedForQueuedPost: false, outbox: "COMPLETE", queuedPosts: [{ status: "PENDING" }] },
    ]);
  });
});
