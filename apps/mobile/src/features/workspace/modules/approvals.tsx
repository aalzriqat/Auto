import { useMutation, useQuery } from "convex/react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileApprovalRequest } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { dateLabel, useGenericError, PrimaryButton, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function ApprovalsModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const approvals = useQuery(api.approvals.listPendingApprovals, { orgId });
  const respond = useMutation(api.approvals.respondToApproval);

  async function answer(request: MobileApprovalRequest, status: "APPROVED" | "REJECTED") {
    try {
      await respond({ orgId, requestId: request._id, status });
    } catch (error) {
      reportError("Mobile approval response failed", error);
    }
  }

  if (approvals === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      {approvals.length ? approvals.map((request) => (
        <RecordCard key={request._id}>
          <Text style={styles.recordTitle}>{request.vehicleMakeModel}</Text>
          <Text style={styles.recordMeta}>{request.vehicleVin} · {request.salespersonName}</Text>
          <Text style={styles.recordMeta}>{dateLabel(request.createdAt, locale)}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "قبول" : "Approve"} tone="muted" onPress={() => answer(request, "APPROVED")} />
            <PrimaryButton label={locale === "ar" ? "رفض" : "Reject"} tone="danger" onPress={() => answer(request, "REJECTED")} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد موافقات معلقة." : "No pending approvals."} />}
    </ModuleScroll>
  );
}

