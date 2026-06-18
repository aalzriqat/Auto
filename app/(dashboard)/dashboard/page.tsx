"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";

const CURRENCIES = [
  { code: "JOD", symbol: "د.أ", label: "Jordanian Dinar (JOD)" },
  { code: "SAR", symbol: "ر.س", label: "Saudi Riyal (SAR)" },
  { code: "AED", symbol: "د.إ", label: "UAE Dirham (AED)" },
  { code: "KWD", symbol: "د.ك", label: "Kuwaiti Dinar (KWD)" },
  { code: "EGP", symbol: "ج.م", label: "Egyptian Pound (EGP)" },
  { code: "QAR", symbol: "ر.ق", label: "Qatari Riyal (QAR)" },
];

const STEPS = ["Dealership", "Currency", "Lead Sources", "Pipeline", "Done"];

function Onboarding({ onComplete }: { onComplete: (orgId: string) => void }) {
  const { t } = useLanguage();
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
        orgId: orgId as Id<"organizations">,
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
              <h2 className="text-xl font-bold">{t("WelcomeToAutoFlow")}</h2>
              <p className="text-muted-foreground text-sm">{t("StartByNamingYourDealership")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="orgName">{t("DealershipName")}</Label>
              <Input
                id="orgName"
                placeholder={t("DealershipNamePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateOrg()}
                autoFocus
              />
            </div>
            <Button className="w-full" onClick={handleCreateOrg} disabled={isBusy || !name.trim()}>
              {isBusy ? t("OnboardingCreating") : t("Continue")}
            </Button>
          </div>
        )}

        {/* Step 1: Currency */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">{t("Currency")}</h2>
              <p className="text-muted-foreground text-sm">{t("WhichCurrencyDoYouUse")}</p>
            </div>
            <div className="space-y-2">
              <Label>{t("Currency")}</Label>
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
              {isBusy ? t("OnboardingSaving") : t("Continue")}
            </Button>
          </div>
        )}

        {/* Step 2: Lead sources */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">{t("LeadSources")}</h2>
              <p className="text-muted-foreground text-sm">{t("WillLoadDefaultLeadSources")}</p>
            </div>
            <Button className="w-full" onClick={handleSeedLeadSources} disabled={isBusy}>
              {isBusy ? t("OnboardingLoading") : t("LoadDefaultLeadSources")}
            </Button>
            <button
              className="w-full text-sm text-muted-foreground underline underline-offset-2"
              onClick={() => setStep(3)}
            >
              {t("Skip")}
            </button>
          </div>
        )}

        {/* Step 3: Pipeline */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">{t("Pipeline")}</h2>
              <p className="text-muted-foreground text-sm">{t("WillCreateDefaultPipeline")}</p>
            </div>
            <Button className="w-full" onClick={handleSeedPipeline} disabled={isBusy}>
              {isBusy ? t("OnboardingLoading") : t("LoadDefaultPipeline")}
            </Button>
            <button
              className="w-full text-sm text-muted-foreground underline underline-offset-2"
              onClick={() => setStep(4)}
            >
              {t("Skip")}
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
              <h2 className="text-xl font-bold">{t("YoureAllSet")}</h2>
              <p className="text-muted-foreground text-sm">{t("YourDealershipIsReady")}</p>
            </div>
            <Button className="w-full" onClick={() => onComplete(orgId!)}>
              {t("GoToDashboard")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-muted/30 flex-col gap-4">
      <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      <p className="text-sm text-muted-foreground">Loading your workspace...</p>
    </div>
  );
}

// Entry point reached right after sign-in (Clerk's fallback redirect URL).
// There is no orgId in the URL yet here, so this page figures out where the
// user actually belongs: their first org, or onboarding if they have none.
export default function DashboardEntryPage() {
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const orgs = useQuery(api.organizations.listMine, isAuthenticated ? undefined : "skip");
  // Support agents have zero org memberships by design — route them to the
  // agent console instead of the dealership-onboarding wizard below.
  const isSupportAgent = useQuery(api.supportAgentAuth.isSupportAgent, isAuthenticated ? {} : "skip");

  const [isOnboarding, setIsOnboarding] = useState(false);

  useEffect(() => {
    if (orgs && orgs.length === 0 && isSupportAgent === false && !isOnboarding) {
      setIsOnboarding(true);
    }
  }, [orgs, isSupportAgent, isOnboarding]);

  useEffect(() => {
    if (orgs && orgs.length > 0 && !isOnboarding) {
      router.replace(`/${orgs[0]!._id}/dashboard`);
    } else if (orgs && orgs.length === 0 && isSupportAgent === true) {
      router.replace("/support");
    }
  }, [orgs, isSupportAgent, router, isOnboarding]);

  if (orgs === undefined || (orgs.length === 0 && isSupportAgent === undefined)) {
    return <Spinner />;
  }

  if (orgs.length === 0 && isSupportAgent === true) {
    return <Spinner />;
  }

  if (isOnboarding || orgs.length === 0) {
    return <Onboarding onComplete={(newOrgId) => router.replace(`/${newOrgId}/dashboard`)} />;
  }

  // orgs.length > 0 — redirect is in flight via the effect above.
  return <Spinner />;
}
