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

  const igStatus = useQuery(
    api.socialIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const fbStatus = useQuery(
    api.facebookIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const createInstagramConnectUrl = useMutation(api.socialIntegrations.createConnectUrl);
  const disconnectInstagram = useMutation(api.socialIntegrations.disconnect);
  const setAutoPostEnabled = useMutation(api.socialIntegrations.setAutoPostEnabled);
  const setInstagramAutoReplyConfig = useMutation(api.socialIntegrations.setInstagramAutoReplyConfig);
  const setInstagramLeadCreationConfig = useMutation(api.socialIntegrations.setInstagramLeadCreationConfig);

  const createFacebookConnectUrl = useMutation(api.facebookIntegrations.createConnectUrl);
  const disconnectFacebook = useMutation(api.facebookIntegrations.disconnect);
  const setFacebookAutoReplyConfig = useMutation(api.facebookIntegrations.setFacebookAutoReplyConfig);
  const setFacebookLeadCreationConfig = useMutation(api.facebookIntegrations.setFacebookLeadCreationConfig);

  const [igAutoReplyEnabled, setIgAutoReplyEnabled] = useState(false);
  const [igAutoReplyMessages, setIgAutoReplyMessages] = useState<string[]>([]);
  const [igAutoReplyLoaded, setIgAutoReplyLoaded] = useState(false);
  const [igSavingAutoReply, setIgSavingAutoReply] = useState(false);
  const [igLeadFromComments, setIgLeadFromComments] = useState(true);
  const [igLeadFromDms, setIgLeadFromDms] = useState(true);

  const [fbAutoReplyEnabled, setFbAutoReplyEnabled] = useState(false);
  const [fbAutoReplyMessages, setFbAutoReplyMessages] = useState<string[]>([]);
  const [fbAutoReplyLoaded, setFbAutoReplyLoaded] = useState(false);
  const [fbSavingAutoReply, setFbSavingAutoReply] = useState(false);
  const [fbLeadFromComments, setFbLeadFromComments] = useState(true);
  const [fbLeadFromDms, setFbLeadFromDms] = useState(true);

  // Sync local editable state from the server exactly once, the first time
  // it loads — re-syncing on every reactive update would clobber in-progress edits.
  useEffect(() => {
    if (!igStatus || igAutoReplyLoaded) return;
    setIgAutoReplyEnabled(igStatus.instagramAutoReplyEnabled);
    setIgAutoReplyMessages(igStatus.instagramAutoReplyMessages.length > 0 ? igStatus.instagramAutoReplyMessages : [""]);
    setIgLeadFromComments(igStatus.instagramLeadFromCommentsEnabled);
    setIgLeadFromDms(igStatus.instagramLeadFromDmsEnabled);
    setIgAutoReplyLoaded(true);
  }, [igStatus, igAutoReplyLoaded]);

  useEffect(() => {
    if (!fbStatus || fbAutoReplyLoaded) return;
    setFbAutoReplyEnabled(fbStatus.facebookAutoReplyEnabled);
    setFbAutoReplyMessages(fbStatus.facebookAutoReplyMessages.length > 0 ? fbStatus.facebookAutoReplyMessages : [""]);
    setFbLeadFromComments(fbStatus.facebookLeadFromCommentsEnabled);
    setFbLeadFromDms(fbStatus.facebookLeadFromDmsEnabled);
    setFbAutoReplyLoaded(true);
  }, [fbStatus, fbAutoReplyLoaded]);

  // Surface the OAuth callback's redirect result, then clean the URL.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const errorMessage = searchParams.get("errorMessage");
    if (!connected) return;

    if (connected === "facebook") {
      if (error) {
        toast.error(errorMessage ? `${t("FacebookConnectFailed" as any)} ${errorMessage}` : t("FacebookConnectFailed" as any));
      } else {
        toast.success(t("FacebookConnectedSuccess" as any));
      }
    } else {
      if (error) {
        toast.error(errorMessage ? `${t("InstagramConnectFailed" as any)} ${errorMessage}` : t("InstagramConnectFailed" as any));
      } else {
        toast.success(t("InstagramConnectedSuccess" as any));
      }
    }
    router.replace(`/${activeOrgId}/settings/integrations`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleConnectInstagram = async () => {
    if (!activeOrgId) return;
    try {
      const url = await createInstagramConnectUrl({ orgId: activeOrgId });
      window.location.href = url;
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleDisconnectInstagram = async () => {
    if (!activeOrgId) return;
    try {
      await disconnectInstagram({ orgId: activeOrgId });
      toast.success(t("InstagramDisconnectedSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleConnectFacebook = async () => {
    if (!activeOrgId) return;
    try {
      const url = await createFacebookConnectUrl({ orgId: activeOrgId });
      window.location.href = url;
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleDisconnectFacebook = async () => {
    if (!activeOrgId) return;
    try {
      await disconnectFacebook({ orgId: activeOrgId });
      toast.success(t("FacebookDisconnectedSuccess" as any));
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

  const handleSaveIgAutoReply = async (overrides?: { enabled?: boolean; messages?: string[] }) => {
    if (!activeOrgId) return;
    const enabled = overrides?.enabled ?? igAutoReplyEnabled;
    const messages = overrides?.messages ?? igAutoReplyMessages;
    setIgSavingAutoReply(true);
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
      setIgSavingAutoReply(false);
    }
  };

  const handleSaveFbAutoReply = async (overrides?: { enabled?: boolean; messages?: string[] }) => {
    if (!activeOrgId) return;
    const enabled = overrides?.enabled ?? fbAutoReplyEnabled;
    const messages = overrides?.messages ?? fbAutoReplyMessages;
    setFbSavingAutoReply(true);
    try {
      await setFacebookAutoReplyConfig({
        orgId: activeOrgId,
        enabled,
        messages: messages.filter((m) => m.trim().length > 0),
      });
      toast.success(t("AutoRepliesSaved" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setFbSavingAutoReply(false);
    }
  };

  const handleToggleIgLeadCreation = async (overrides: { leadFromComments?: boolean; leadFromDms?: boolean }) => {
    if (!activeOrgId) return;
    const leadFromCommentsEnabled = overrides.leadFromComments ?? igLeadFromComments;
    const leadFromDmsEnabled = overrides.leadFromDms ?? igLeadFromDms;
    if (overrides.leadFromComments !== undefined) setIgLeadFromComments(overrides.leadFromComments);
    if (overrides.leadFromDms !== undefined) setIgLeadFromDms(overrides.leadFromDms);
    try {
      await setInstagramLeadCreationConfig({ orgId: activeOrgId, leadFromCommentsEnabled, leadFromDmsEnabled });
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const handleToggleFbLeadCreation = async (overrides: { leadFromComments?: boolean; leadFromDms?: boolean }) => {
    if (!activeOrgId) return;
    const leadFromCommentsEnabled = overrides.leadFromComments ?? fbLeadFromComments;
    const leadFromDmsEnabled = overrides.leadFromDms ?? fbLeadFromDms;
    if (overrides.leadFromComments !== undefined) setFbLeadFromComments(overrides.leadFromComments);
    if (overrides.leadFromDms !== undefined) setFbLeadFromDms(overrides.leadFromDms);
    try {
      await setFacebookLeadCreationConfig({ orgId: activeOrgId, leadFromCommentsEnabled, leadFromDmsEnabled });
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    }
  };

  const anyConnected = Boolean(igStatus?.instagramConnected || fbStatus?.facebookConnected);

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
          {/* Shared auto-post toggle — applies to whichever platform(s) are connected */}
          {anyConnected && (
            <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{t("AutoPostInstagram" as any)}</p>
                <p className="text-xs text-muted-foreground">{t("AutoPostInstagramDescription" as any)}</p>
              </div>
              <Switch
                checked={igStatus?.socialAutoPostEnabled ?? false}
                onCheckedChange={handleToggleAutoPost}
              />
            </div>
          )}

          {/* Instagram */}
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 text-white">
                  <Camera className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold flex items-center gap-2">
                    {t("InstagramBusinessAccount" as any)}
                    {igStatus?.instagramConnected && (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-50">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Connected" as any)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {igStatus?.instagramConnected
                      ? `${t("InstagramConnectedAs" as any)} ${igStatus.instagramPageName ?? ""}`
                      : t("InstagramNotConnected" as any)}
                  </p>
                </div>
              </div>

              {igStatus?.instagramConnected ? (
                <Button variant="outline" onClick={handleDisconnectInstagram}>
                  {t("Disconnect" as any)}
                </Button>
              ) : (
                <Button onClick={handleConnectInstagram}>{t("ConnectInstagram" as any)}</Button>
              )}
            </div>

            {igStatus?.instagramConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igLeadFromComments}
                    onCheckedChange={(v) => handleToggleIgLeadCreation({ leadFromComments: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igLeadFromDms}
                    onCheckedChange={(v) => handleToggleIgLeadCreation({ leadFromDms: v })}
                  />
                </div>
              </div>
            )}

            {igStatus?.instagramConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("InstagramAutoReply" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("InstagramAutoReplyDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igAutoReplyEnabled}
                    onCheckedChange={(v) => {
                      setIgAutoReplyEnabled(v);
                      void handleSaveIgAutoReply({ enabled: v });
                    }}
                  />
                </div>

                <div className="space-y-2">
                  {igAutoReplyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Textarea
                        value={message}
                        placeholder={t("InstagramAutoReplyMessagePlaceholder" as any)}
                        onChange={(e) =>
                          setIgAutoReplyMessages(igAutoReplyMessages.map((m, i) => (i === index ? e.target.value : m)))
                        }
                        rows={2}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setIgAutoReplyMessages(igAutoReplyMessages.filter((_, i) => i !== index))}
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
                    onClick={() => setIgAutoReplyMessages([...igAutoReplyMessages, ""])}
                    disabled={igAutoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("AddReply" as any)}
                  </Button>
                  <Button type="button" size="sm" onClick={() => handleSaveIgAutoReply()} disabled={igSavingAutoReply}>
                    {t("SaveAutoReplies" as any)}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Facebook */}
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white font-bold text-sm">
                  f
                </div>
                <div>
                  <p className="font-semibold flex items-center gap-2">
                    {t("FacebookPage" as any)}
                    {fbStatus?.facebookConnected && (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-50">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Connected" as any)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {fbStatus?.facebookConnected
                      ? `${t("FacebookConnectedAs" as any)} ${fbStatus.facebookPageName ?? ""}`
                      : t("FacebookNotConnected" as any)}
                  </p>
                </div>
              </div>

              {fbStatus?.facebookConnected ? (
                <Button variant="outline" onClick={handleDisconnectFacebook}>
                  {t("Disconnect" as any)}
                </Button>
              ) : (
                <Button onClick={handleConnectFacebook}>{t("ConnectFacebook" as any)}</Button>
              )}
            </div>

            {fbStatus?.facebookConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbLeadFromComments}
                    onCheckedChange={(v) => handleToggleFbLeadCreation({ leadFromComments: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbLeadFromDms}
                    onCheckedChange={(v) => handleToggleFbLeadCreation({ leadFromDms: v })}
                  />
                </div>
              </div>
            )}

            {fbStatus?.facebookConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("FacebookAutoReply" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("FacebookAutoReplyDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbAutoReplyEnabled}
                    onCheckedChange={(v) => {
                      setFbAutoReplyEnabled(v);
                      void handleSaveFbAutoReply({ enabled: v });
                    }}
                  />
                </div>

                <div className="space-y-2">
                  {fbAutoReplyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Textarea
                        value={message}
                        placeholder={t("FacebookAutoReplyMessagePlaceholder" as any)}
                        onChange={(e) =>
                          setFbAutoReplyMessages(fbAutoReplyMessages.map((m, i) => (i === index ? e.target.value : m)))
                        }
                        rows={2}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setFbAutoReplyMessages(fbAutoReplyMessages.filter((_, i) => i !== index))}
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
                    onClick={() => setFbAutoReplyMessages([...fbAutoReplyMessages, ""])}
                    disabled={fbAutoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("AddReply" as any)}
                  </Button>
                  <Button type="button" size="sm" onClick={() => handleSaveFbAutoReply()} disabled={fbSavingAutoReply}>
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
