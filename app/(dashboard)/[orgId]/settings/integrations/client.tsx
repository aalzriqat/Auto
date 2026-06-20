"use client";

import { useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Camera, CheckCircle2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

export function IntegrationsClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();

  const status = useQuery(
    api.socialIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const createConnectUrl = useMutation(api.socialIntegrations.createConnectUrl);
  const disconnect = useMutation(api.socialIntegrations.disconnect);
  const setAutoPostEnabled = useMutation(api.socialIntegrations.setAutoPostEnabled);

  // Surface the OAuth callback's redirect result, then clean the URL.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (!connected) return;

    if (error) {
      toast.error(t("InstagramConnectFailed" as any));
    } else {
      toast.success(t("InstagramConnectedSuccess" as any));
    }
    router.replace(`/${activeOrgId}/settings/integrations`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleConnect = async () => {
    if (!activeOrgId) return;
    try {
      const url = await createConnectUrl({ orgId: activeOrgId });
      window.location.href = url;
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleDisconnect = async () => {
    if (!activeOrgId) return;
    try {
      await disconnect({ orgId: activeOrgId });
      toast.success(t("InstagramDisconnectedSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleToggleAutoPost = async (enabled: boolean) => {
    if (!activeOrgId) return;
    try {
      await setAutoPostEnabled({ orgId: activeOrgId, enabled });
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            {t("Integrations" as any)}
          </CardTitle>
          <CardDescription>{t("IntegrationsDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 text-white">
                  <Camera className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold flex items-center gap-2">
                    {t("InstagramBusinessAccount" as any)}
                    {status?.instagramConnected && (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-50">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Connected" as any)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {status?.instagramConnected
                      ? `${t("InstagramConnectedAs" as any)} ${status.instagramPageName ?? ""}`
                      : t("InstagramNotConnected" as any)}
                  </p>
                </div>
              </div>

              {status?.instagramConnected ? (
                <Button variant="outline" onClick={handleDisconnect}>
                  {t("Disconnect" as any)}
                </Button>
              ) : (
                <Button onClick={handleConnect}>
                  {t("ConnectInstagram" as any)}
                </Button>
              )}
            </div>

            {status?.instagramConnected && (
              <div className="flex items-center justify-between border-t border-border pt-4">
                <div>
                  <p className="text-sm font-medium">{t("AutoPostInstagram" as any)}</p>
                  <p className="text-xs text-muted-foreground">{t("AutoPostInstagramDescription" as any)}</p>
                </div>
                <Switch
                  checked={status.socialAutoPostEnabled}
                  onCheckedChange={handleToggleAutoPost}
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
