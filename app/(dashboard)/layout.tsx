"use client";

import { TopNav } from "@/components/layout/TopNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { OrgProvider, useOrg } from "@/components/providers/OrgProvider";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { hexToHslString } from "@/lib/colorUtils";
import { useQuery } from "convex/react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check } from "lucide-react";

const CURRENCIES = [
  { code: "JOD", symbol: "د.أ", label: "Jordanian Dinar (JOD)" },
  { code: "SAR", symbol: "ر.س", label: "Saudi Riyal (SAR)" },
  { code: "AED", symbol: "د.إ", label: "UAE Dirham (AED)" },
  { code: "KWD", symbol: "د.ك", label: "Kuwaiti Dinar (KWD)" },
  { code: "EGP", symbol: "ج.م", label: "Egyptian Pound (EGP)" },
  { code: "QAR", symbol: "ر.ق", label: "Qatari Riyal (QAR)" },
];

const STEPS = ["Dealership", "Currency", "Lead Sources", "Pipeline", "Done"];

function Onboarding() {
  const { setActiveOrgId } = useOrg();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("JOD");

  const createOrg = useMutation(api.organizations.create);
  const upsertSettings = useMutation(api.orgSettings.upsert);
  const seedLeadSources = useMutation(api.orgLeadSources.seed);
  const seedPipeline = useMutation(api.orgPipelineStages.seed);

  const [isBusy, setIsBusy] = useState(false);

  // Step 0: create org + move forward
  const handleCreateOrg = async () => {
    if (!name.trim()) return;
    setIsBusy(true);
    try {
      const newId = await createOrg({ name: name.trim() });
      setOrgId(newId as string);
      setActiveOrgId(newId);
      setStep(1);
    } catch (err: any) {
      toast.error(err.message || "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  // Step 1: save currency
  const handleSaveCurrency = async () => {
    if (!orgId) return;
    setIsBusy(true);
    try {
      const cur = CURRENCIES.find((c) => c.code === currency)!;
      await upsertSettings({
        orgId: orgId as any,
        currency: cur.code,
        currencySymbol: cur.symbol,
      });
      setStep(2);
    } catch (err: any) {
      toast.error(err.message || "Failed to save currency");
    } finally {
      setIsBusy(false);
    }
  };

  // Step 2: seed lead sources
  const handleSeedLeadSources = async () => {
    if (!orgId) return;
    setIsBusy(true);
    try {
      await seedLeadSources({ orgId: orgId as any });
      setStep(3);
    } catch (err: any) {
      toast.error(err.message || "Failed to seed lead sources");
    } finally {
      setIsBusy(false);
    }
  };

  // Step 3: seed pipeline
  const handleSeedPipeline = async () => {
    if (!orgId) return;
    setIsBusy(true);
    try {
      await seedPipeline({ orgId: orgId as any });
      setStep(4);
    } catch (err: any) {
      toast.error(err.message || "Failed to seed pipeline");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-muted/50 p-4">
      <div className="max-w-lg w-full bg-background p-8 rounded-xl border shadow-sm space-y-6">
        {/* Step indicator */}
        <div className="flex items-center justify-between">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  i < step
                    ? "bg-primary text-primary-foreground"
                    : i === step
                    ? "bg-primary/20 text-primary border-2 border-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 w-8 mx-1 ${i < step ? "bg-primary" : "bg-muted"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 0: Dealership name */}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Welcome to AutoFlow</h2>
              <p className="text-muted-foreground text-sm">Start by naming your dealership.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="orgName">Dealership Name</Label>
              <Input
                id="orgName"
                placeholder="e.g. Al Mada Motors"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateOrg()}
                autoFocus
              />
            </div>
            <Button className="w-full" onClick={handleCreateOrg} disabled={isBusy || !name.trim()}>
              {isBusy ? "Creating..." : "Continue →"}
            </Button>
          </div>
        )}

        {/* Step 1: Currency */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Currency</h2>
              <p className="text-muted-foreground text-sm">Which currency does your dealership use?</p>
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" onClick={handleSaveCurrency} disabled={isBusy}>
              {isBusy ? "Saving..." : "Continue →"}
            </Button>
          </div>
        )}

        {/* Step 2: Lead sources */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Lead Sources</h2>
              <p className="text-muted-foreground text-sm">
                We'll load default lead sources (Walk-in, Website, Facebook, etc.).
                You can customize them later in Settings.
              </p>
            </div>
            <Button className="w-full" onClick={handleSeedLeadSources} disabled={isBusy}>
              {isBusy ? "Loading..." : "Load Default Lead Sources →"}
            </Button>
            <button
              className="w-full text-sm text-muted-foreground underline underline-offset-2"
              onClick={() => setStep(3)}
            >
              Skip
            </button>
          </div>
        )}

        {/* Step 3: Pipeline */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Sales Pipeline</h2>
              <p className="text-muted-foreground text-sm">
                We'll create default pipeline stages (New → Contacted → Interested → …).
                You can rename and reorder them in Settings.
              </p>
            </div>
            <Button className="w-full" onClick={handleSeedPipeline} disabled={isBusy}>
              {isBusy ? "Loading..." : "Load Default Pipeline →"}
            </Button>
            <button
              className="w-full text-sm text-muted-foreground underline underline-offset-2"
              onClick={() => setStep(4)}
            >
              Skip
            </button>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <div className="space-y-4 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Check className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">You're all set!</h2>
              <p className="text-muted-foreground text-sm">
                Your dealership is ready. Head to Settings anytime to customize further.
              </p>
            </div>
            <Button className="w-full" onClick={() => window.location.reload()}>
              Go to Dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardWrapper({ children }: { children: React.ReactNode }) {
  const { activeOrgId, isLoading } = useOrg();
  const orgSettings = useOrgSettings();

  const brandStyle = useMemo(() => {
    const hsl = orgSettings?.primaryColor
      ? hexToHslString(orgSettings.primaryColor)
      : null;
    if (!hsl) return undefined;
    return { "--primary": `hsl(${hsl})` } as React.CSSProperties;
  }, [orgSettings?.primaryColor]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-muted/30 flex-col gap-4">
        <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Loading your workspace...</p>
      </div>
    );
  }

  if (!activeOrgId) {
    return <Onboarding />;
  }

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-zinc-950/40"
      style={brandStyle}
    >
      <Sidebar />
      <div className="flex flex-col flex-1 w-full overflow-hidden">
        <TopNav />
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 relative">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgProvider>
      <DashboardWrapper>{children}</DashboardWrapper>
    </OrgProvider>
  );
}
