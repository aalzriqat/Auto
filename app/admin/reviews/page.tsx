"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { Building2, UserMinus, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader, EmptyState } from "@/components/admin/ui";

type View = "deletions" | "offboarding";

type DeletionStatus = "PENDING_REVIEW" | "REJECTED" | "APPROVED" | "RUNNING" | "COMPLETED" | "FAILED";

const DELETION_BADGE: Record<DeletionStatus, string> = {
  PENDING_REVIEW: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  RUNNING: "border-primary/40 bg-primary/10 text-primary",
  APPROVED: "border-primary/40 bg-primary/10 text-primary",
  COMPLETED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  REJECTED: "border-border bg-muted text-muted-foreground",
  FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
};

function StatusPill({ status }: { status: DeletionStatus }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", DELETION_BADGE[status])}>
      {status.replace("_", " ")}
    </span>
  );
}

// ─── Org deletion requests ──────────────────────────────────────────────────

function DeletionRequestsView() {
  const { results, loadMore, status } = usePaginatedQuery(
    api.adminOrgs.listDeletionRequests,
    {},
    { initialNumItems: 30 }
  );

  const approve = useMutation(api.adminOrgs.approveDeletionRequest);
  const reject = useMutation(api.adminOrgs.rejectDeletionRequest);

  const [action, setAction] = useState<{ id: Id<"organizationDeletionRequests">; orgName: string; kind: "approve" | "reject" } | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === "approve") {
        await approve({ requestId: action.id, reviewNotes: notes.trim() || undefined });
        toast.success(`Deletion approved — ${action.orgName} is being erased.`);
      } else {
        await reject({ requestId: action.id, reviewNotes: notes.trim() || undefined });
        toast.success(`Deletion rejected — ${action.orgName} keeps its data.`);
      }
      setAction(null);
      setNotes("");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const pending = results.filter((r) => r.status === "PENDING_REVIEW").length;

  return (
    <div className="space-y-3">
      {pending > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {pending} deletion request{pending === 1 ? "" : "s"} awaiting your review.
        </div>
      )}

      {results.length === 0 && (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={Building2} title="No deletion requests." description="Dealer-initiated org deletions will appear here for approval." />
        </div>
      )}

      {results.map((req) => {
        const isPending = req.status === "PENDING_REVIEW";
        const deleted = req.deletedCounts ? Object.values(req.deletedCounts).reduce((a, b) => a + (b as number), 0) : 0;
        return (
          <div key={req._id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-foreground">{req.orgName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Requested {new Date(req.requestedAt).toLocaleString()}
                </p>
              </div>
              <StatusPill status={req.status as DeletionStatus} />
            </div>

            {req.reason && (
              <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                <span className="text-muted-foreground">Reason: </span>
                {req.reason}
              </p>
            )}

            {req.status === "RUNNING" && (
              <p className="mt-2 text-xs text-muted-foreground">Erasing… {deleted} records deleted so far.</p>
            )}
            {req.reviewNotes && (
              <p className="mt-2 text-xs text-muted-foreground">Review notes: {req.reviewNotes}</p>
            )}

            {isPending && (
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 sm:flex-none"
                  onClick={() => { setAction({ id: req._id, orgName: req.orgName, kind: "reject" }); setNotes(""); }}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="flex-1 sm:flex-none"
                  onClick={() => { setAction({ id: req._id, orgName: req.orgName, kind: "approve" }); setNotes(""); }}
                >
                  Approve deletion
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(30)}>Load more</Button>
      )}

      <Dialog open={!!action} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "approve" ? "Approve deletion of " : "Reject deletion of "}
              {action?.orgName}?
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "approve"
                ? "This permanently erases every record for this organization across all tables. This cannot be undone."
                : "The organization keeps its data and is unsuspended. The dealer can request deletion again later."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Review notes (optional, shown in audit log)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} disabled={busy}>Cancel</Button>
            <Button
              variant={action?.kind === "approve" ? "destructive" : "default"}
              onClick={confirm}
              disabled={busy}
            >
              {busy ? "Working…" : action?.kind === "approve" ? "Approve deletion" : "Reject request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── User offboarding reviews ───────────────────────────────────────────────

function OffboardingView() {
  const reviews = useQuery(api.adminUsers.listOffboardingReviews, {});
  const resolve = useMutation(api.adminUsers.resolveOffboardingReview);

  const [target, setTarget] = useState<{ id: Id<"userOffboardingReviews">; email: string } | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!target) return;
    setBusy(true);
    try {
      await resolve({ reviewId: target.id, notes: notes.trim() || undefined });
      toast.success("Offboarding review resolved.");
      setTarget(null);
      setNotes("");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (reviews === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const pending = reviews.filter((r) => r.status === "PENDING_REVIEW").length;

  return (
    <div className="space-y-3">
      {pending > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {pending} offboarding review{pending === 1 ? "" : "s"} need attention — a sole org owner left.
        </div>
      )}

      {reviews.length === 0 && (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={UserMinus}
            title="No offboarding reviews."
            description="When the last owner of an org is deleted, a safety review lands here."
          />
        </div>
      )}

      {reviews.map((r) => {
        const isPending = r.status === "PENDING_REVIEW";
        return (
          <div key={r._id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{r.userEmail}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.source === "clerk_user_deleted" ? "Account deleted" : "Admin requested"} ·{" "}
                  {new Date(r.createdAt).toLocaleString()}
                </p>
              </div>
              {isPending ? (
                <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">Pending</Badge>
              ) : (
                <Badge variant="secondary">Resolved</Badge>
              )}
            </div>

            <p className="mt-2 text-sm text-foreground">
              Was sole owner of {r.ownerOrgs.length} org{r.ownerOrgs.length === 1 ? "" : "s"} · {r.membershipCount} membership{r.membershipCount === 1 ? "" : "s"}
            </p>
            {r.ownerOrgs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {r.ownerOrgs.map((o) => (
                  <Badge key={o.orgId} variant="outline">{o.orgName}</Badge>
                ))}
              </div>
            )}
            {r.notes && <p className="mt-2 text-xs text-muted-foreground">Notes: {r.notes}</p>}

            {isPending && (
              <div className="mt-3">
                <Button size="sm" onClick={() => { setTarget({ id: r._id, email: r.userEmail }); setNotes(""); }}>
                  Mark reviewed
                </Button>
              </div>
            )}
          </div>
        );
      })}

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve offboarding review</DialogTitle>
            <DialogDescription>
              Confirm you&apos;ve handled ownership reassignment for {target?.email}&apos;s orphaned organizations.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="What did you do? (optional, shown in audit log)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
            <Button onClick={confirm} disabled={busy}>{busy ? "Saving…" : "Mark reviewed"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminReviewsPage() {
  const [view, setView] = useState<View>("deletions");

  return (
    <div>
      <PageHeader title="Reviews" description="Approval queues for org deletions and user offboarding." />

      <div className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
        <Button size="sm" variant={view === "deletions" ? "default" : "outline"} onClick={() => setView("deletions")}>
          <Building2 className="me-1.5 h-4 w-4" />
          Org Deletions
        </Button>
        <Button size="sm" variant={view === "offboarding" ? "default" : "outline"} onClick={() => setView("offboarding")}>
          <UserMinus className="me-1.5 h-4 w-4" />
          User Offboarding
        </Button>
      </div>

      {view === "deletions" ? <DeletionRequestsView /> : <OffboardingView />}
    </div>
  );
}
