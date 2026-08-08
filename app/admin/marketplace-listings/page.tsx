"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { PageHeader, EmptyState } from "@/components/admin/ui";
import { ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { getErrorMessage } from "@/lib/errors";
import { safeImageSrc } from "@/lib/imageUrl";

type PendingListingRow = {
  _id: Id<"marketplaceListings">;
  sellerKind: "INDIVIDUAL" | "UNAFFILIATED_DEALER";
  sellerDisplayName: string;
  sellerPhone: string;
  sellerWhatsapp?: string;
  make: string;
  model: string;
  year: number;
  mileage: number;
  price: number;
  currency: string;
  transmission: string;
  fuelType: string;
  city: string;
  description: string;
  condition: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
  imageUrls: string[];
  sellerProfile: { phone: string; city?: string; phoneVerifiedAt?: number } | null;
  createdAt: number;
};

function ListingCard({ listing, onReject }: { readonly listing: PendingListingRow; readonly onReject: () => void }) {
  const setStatus = useMutation(api.marketplaceListings.adminSetListingStatus);
  const [approving, setApproving] = useState(false);

  async function handleApprove() {
    setApproving(true);
    try {
      await setStatus({ listingId: listing._id, status: "LIVE" });
      toast.success("Listing approved and now live.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setApproving(false);
    }
  }

  return (
    <Card className="p-4 space-y-3 shadow-sm">
      {listing.imageUrls.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {listing.imageUrls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${listing._id}-${i}`}
              src={safeImageSrc(url)}
              alt={`${listing.make} ${listing.model}`}
              className="h-20 w-28 rounded-md border border-border object-cover"
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-foreground">
            {listing.year} {listing.make} {listing.model}
          </p>
          <p className="text-sm text-muted-foreground">
            {listing.mileage.toLocaleString()} km · {listing.price.toLocaleString()} {listing.currency} ·{" "}
            {listing.transmission} · {listing.fuelType} · {listing.city}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px] border-border text-foreground">
          {listing.condition}
        </Badge>
      </div>

      <p className="text-sm text-foreground">{listing.description}</p>

      <div className="border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{listing.sellerDisplayName}</span>
          <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
            {listing.sellerKind === "INDIVIDUAL" ? "Individual" : "Unaffiliated dealer"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {listing.sellerPhone}
          {listing.sellerWhatsapp ? ` · WhatsApp: ${listing.sellerWhatsapp}` : ""}
          {listing.sellerProfile?.city ? ` · ${listing.sellerProfile.city}` : ""}
        </p>
        {listing.sellerProfile?.phoneVerifiedAt && (
          <p className="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Phone verified {new Date(listing.sellerProfile.phoneVerifiedAt).toLocaleDateString()}
          </p>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="destructive" onClick={onReject}>
          <XCircle className="h-3.5 w-3.5 me-1" />
          Reject
        </Button>
        <Button size="sm" disabled={approving} onClick={handleApprove}>
          <CheckCircle2 className="h-3.5 w-3.5 me-1" />
          {approving ? "Approving…" : "Approve"}
        </Button>
      </div>
    </Card>
  );
}

export default function AdminMarketplaceListingsPage() {
  const { results, loadMore, status } = usePaginatedQuery(
    api.marketplaceListings.adminListPendingListings,
    {},
    { initialNumItems: 20 }
  );

  const setStatus = useMutation(api.marketplaceListings.adminSetListingStatus);

  const [rejectTarget, setRejectTarget] = useState<{ id: Id<"marketplaceListings">; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  async function confirmReject() {
    if (!rejectTarget || !reason.trim()) return;
    setRejecting(true);
    try {
      await setStatus({ listingId: rejectTarget.id, status: "REJECTED", rejectionReason: reason.trim() });
      toast.success("Listing rejected.");
      setRejectTarget(null);
      setReason("");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setRejecting(false);
    }
  }

  const listings = (results ?? []) as PendingListingRow[];
  const isEmpty = status !== "LoadingFirstPage" && listings.length === 0 && status !== "CanLoadMore";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Listing Verification"
        description="Direct-listing submissions from individuals and unaffiliated dealers, oldest first."
      />

      <div className="space-y-4">
        {status === "LoadingFirstPage" && <p className="text-sm text-muted-foreground">Loading...</p>}

        {isEmpty && (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={ShieldCheck}
              title="No listings pending verification"
              description="New marketplace submissions will appear here for review."
            />
          </div>
        )}

        {listings.map((listing) => (
          <ListingCard
            key={listing._id}
            listing={listing}
            onReject={() =>
              setRejectTarget({ id: listing._id, label: `${listing.year} ${listing.make} ${listing.model}` })
            }
          />
        ))}

        {status === "CanLoadMore" && (
          <Button variant="outline" onClick={() => loadMore(20)}>
            Load more
          </Button>
        )}
      </div>

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.label}?</DialogTitle>
            <DialogDescription>
              This reason is shown to the seller so they can fix and resubmit. It cannot be empty.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={rejecting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReject} disabled={rejecting || !reason.trim()}>
              {rejecting ? "Rejecting…" : "Reject listing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
