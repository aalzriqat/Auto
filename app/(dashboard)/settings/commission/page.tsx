"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

interface Tier {
  minProfitAmount: number;
  commissionPct: number;
}

export default function CommissionSettingsPage() {
  const { activeOrgId } = useOrg();
  const settings = useOrgSettings();
  const upsert = useMutation(api.orgSettings.upsert);

  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (settings?.commissionTiers) {
      setTiers([...settings.commissionTiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount));
    }
  }, [settings]);

  const handleAddTier = () => {
    setTiers((prev) => [...prev, { minProfitAmount: 0, commissionPct: 0 }]);
  };

  const handleRemoveTier = (index: number) => {
    setTiers((prev) => prev.filter((_, i) => i !== index));
  };

  const handleChange = (index: number, field: keyof Tier, raw: string) => {
    const value = parseFloat(raw) || 0;
    setTiers((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  };

  const handleSave = async () => {
    if (!activeOrgId) return;
    const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
    setIsSaving(true);
    try {
      await upsert({ orgId: activeOrgId, commissionTiers: sorted });
      setTiers(sorted);
      toast.success("Commission tiers saved.");
    } catch (error: any) {
      toast.error(error.message || "Failed to save commission tiers.");
    } finally {
      setIsSaving(false);
    }
  };

  // Preview: calculate commission for a sample profit
  const calcCommission = (profit: number) => {
    const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
    let pct = 0;
    for (const tier of sorted) {
      if (profit >= tier.minProfitAmount) pct = tier.commissionPct;
    }
    return (profit * pct) / 100;
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Commission Structure</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Define tiered commission rates. The highest tier whose minimum profit is met applies.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Commission Tiers</CardTitle>
              <CardDescription>
                Each tier specifies a minimum profit amount and the commission percentage.
                Tiers are evaluated from highest to lowest — the first one the sale qualifies for wins.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {tiers.length === 0 && (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  No tiers defined. Add one to enable commission tracking.
                </div>
              )}

              {tiers.map((tier, index) => (
                <div key={index} className="flex items-end gap-3 rounded-lg border p-4">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Min Profit (amount)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="100"
                      value={tier.minProfitAmount}
                      onChange={(e) => handleChange(index, "minProfitAmount", e.target.value)}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Commission (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={tier.commissionPct}
                      onChange={(e) => handleChange(index, "commissionPct", e.target.value)}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-500 hover:text-red-600 h-9 w-9 shrink-0"
                    onClick={() => handleRemoveTier(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              <div className="flex gap-3">
                <Button variant="outline" size="sm" onClick={handleAddTier}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Tier
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save Tiers"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Preview calculator */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>Calculate commission for a sample profit.</CardDescription>
            </CardHeader>
            <CardContent>
              <CommissionPreview tiers={tiers} calcFn={calcCommission} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CommissionPreview({ tiers, calcFn }: { tiers: Tier[]; calcFn: (p: number) => number }) {
  const [sampleProfit, setSampleProfit] = useState("1000");
  const profit = parseFloat(sampleProfit) || 0;
  const commission = calcFn(profit);
  const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  const appliedTier = [...sorted].reverse().find((t) => profit >= t.minProfitAmount);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>Profit Amount</Label>
        <Input
          type="number"
          value={sampleProfit}
          onChange={(e) => setSampleProfit(e.target.value)}
        />
      </div>
      <div className="rounded-lg bg-muted/50 p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Applied tier</span>
          <span className="font-medium">
            {appliedTier ? `${appliedTier.commissionPct}% (≥${appliedTier.minProfitAmount.toLocaleString()})` : "None"}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Commission</span>
          <span className="font-bold text-primary">
            {commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>
    </div>
  );
}
