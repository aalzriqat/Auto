"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Camera, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

const MAX_AUTO_REPLY_MESSAGES = 5;

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
  const setInstagramAutoReplyConfig = useMutation(api.socialIntegrations.setInstagramAutoReplyConfig);

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplyMessages, setAutoReplyMessages] = useState<string[]>([]);
  const [autoReplyLoaded, setAutoReplyLoaded] = useState(false);
  const [savingAutoReply, setSavingAutoReply] = useState(false);

  // Sync local editable state from the server exactly once, the first time
  // it loads — re-syncing on every reactive update would clobber in-progress edits.
  useEffect(() => {
    if (!status || autoReplyLoaded) return;
    setAutoReplyEnabled(status.instagramAutoReplyEnabled);
    setAutoReplyMessages(status.instagramAutoReplyMessages.length > 0 ? status.instagramAutoReplyMessages : [""]);
    setAutoReplyLoaded(true);
  }, [status, autoReplyLoaded]);

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

  const handleSaveAutoReply = async (overrides?: { enabled?: boolean; messages?: string[] }) => {
    if (!activeOrgId) return;
    const enabled = overrides?.enabled ?? autoReplyEnabled;
    const messages = overrides?.messages ?? autoReplyMessages;
    setSavingAutoReply(true);
    try {
      await setInstagramAutoReplyConfig({
        orgId: activeOrgId,
        enabled,
        messages: messages.filter((m) => m.trim().length > 0),
      });
      toast.success(t("AutoRepliesSaved" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setSavingAutoReply(false);
    }
  };

  const handleToggleAutoReply = (enabled: boolean) => {
    setAutoReplyEnabled(enabled);
    void handleSaveAutoReply({ enabled });
  };

  const handleAddReplyMessage = () => {
    if (autoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES) return;
    setAutoReplyMessages([...autoReplyMessages, ""]);
  };

  const handleRemoveReplyMessage = (index: number) => {
    setAutoReplyMessages(autoReplyMessages.filter((_, i) => i !== index));
  };

  const handleChangeReplyMessage = (index: number, value: string) => {
    setAutoReplyMessages(autoReplyMessages.map((m, i) => (i === index ? value : m)));
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

            {status?.instagramConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("InstagramAutoReply" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("InstagramAutoReplyDescription" as any)}</p>
                  </div>
                  <Switch checked={autoReplyEnabled} onCheckedChange={handleToggleAutoReply} />
                </div>

                <div className="space-y-2">
                  {autoReplyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Textarea
                        value={message}
                        placeholder={t("InstagramAutoReplyMessagePlaceholder" as any)}
                        onChange={(e) => handleChangeReplyMessage(index, e.target.value)}
                        rows={2}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveReplyMessage(index)}
                        aria-label={t("RemoveReply" as any)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddReplyMessage}
                    disabled={autoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("AddReply" as any)}
                  </Button>
                  <Button type="button" size="sm" onClick={() => handleSaveAutoReply()} disabled={savingAutoReply}>
                    {t("SaveAutoReplies" as any)}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
