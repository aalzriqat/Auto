"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertTriangle, CheckCircle2, Loader2, PlugZap } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { getCodedErrorMessage } from "@/lib/errors";

type ConnectionTestResult = FunctionReturnType<typeof api.aiAdmin.testProviderConnection>;
type FailureCode = Extract<ConnectionTestResult, { ok: false }>["code"];

/** One sentence per result code. `satisfies` makes a new server code a compile error here. */
const FAILURE_SENTENCE = {
  AUTH_FAILED: "AiAdminConnection_AUTH_FAILED",
  MODEL_UNAVAILABLE: "AiAdminConnection_MODEL_UNAVAILABLE",
  PROVIDER_UNREACHABLE: "AiAdminConnection_PROVIDER_UNREACHABLE",
  KEY_NOT_SET: "AiAdminConnection_KEY_NOT_SET",
  ENCRYPTION_NOT_CONFIGURED: "AiAdminConnection_ENCRYPTION_NOT_CONFIGURED",
  EGRESS_SUNK: "AiAdminConnection_EGRESS_SUNK",
} as const satisfies Record<FailureCode, TranslationKey>;

type Outcome = { ok: true } | { ok: false; message: string };

/**
 * "Test connection" for the stored Anthropic key. Read-only on the server: the
 * action changes nothing. The result is shown inline in the admin's language.
 */
export function ConnectionTestControl({ keySet }: Readonly<{ keySet: boolean }>) {
  const { t } = useLanguage();
  const testProviderConnection = useAction(api.aiAdmin.testProviderConnection);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function handleTest() {
    if (!keySet || testing) return;
    setTesting(true);
    setOutcome(null);
    try {
      const result = await testProviderConnection({ provider: "anthropic" });
      setOutcome(result.ok ? { ok: true } : { ok: false, message: t(FAILURE_SENTENCE[result.code]) });
    } catch (error: unknown) {
      setOutcome({ ok: false, message: getCodedErrorMessage(error, t) ?? t("AiAdminConnectionTestFailed") });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <Button variant="outline" onClick={() => void handleTest()} disabled={!keySet || testing} aria-busy={testing}>
        {testing ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <PlugZap className="h-4 w-4" aria-hidden="true" />
        )}
        {testing ? t("AiAdminTestingConnection") : t("AiAdminTestConnection")}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {outcome?.ok === true && (
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("AiAdminConnectionOk")}
          </span>
        )}
        {outcome?.ok === false && (
          <span className="inline-flex items-center gap-1.5 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {outcome.message}
          </span>
        )}
      </p>
    </div>
  );
}
