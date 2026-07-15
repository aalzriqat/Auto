import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { Screen } from "../../../components/Screen";
import { api, type MobileMyMembership, type MobileOrgSummary } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { canAccessNativeModule, getNativeModule, labelFor, type NativeModuleId } from "../nativeModules";
import { DedicatedMarketplaceModule } from "./marketplace";
import { CustomersModule } from "./customers";
import { VehiclesModule } from "./vehicles";
import { LeadsModule } from "./leads";
import { TasksModule } from "./tasks";
import { SalesModule } from "./sales";
import { ExpensesModule } from "./expenses";
import { ReportsModule } from "./reports";
import { TeamModule } from "./team";
import { ApplicationsModule } from "./applications";
import { ApprovalsModule } from "./approvals";
import { CommissionsModule } from "./commissions";
import { NotificationsModule } from "./notifications";
import { MessagesModule } from "./messages";
import { AccountingModule } from "./accounting";
import { SourcingModule } from "./sourcing";
import { FinanceCompaniesModule } from "./financeCompanies";
import { BranchesModule } from "./branches";
import { RolesModule } from "./roles";
import { QuotesModule } from "./quotes";
import { SocialInboxModule } from "./socialInbox";
import { PipelineSettingsModule } from "./pipelineSettings";
import { LeadSourcesModule } from "./leadSources";
import { ValuationCompaniesModule } from "./valuationCompanies";
import { CustomFieldsModule } from "./customFields";
import { CommissionSettingsModule } from "./commissionSettings";
import { IntegrationsModule } from "./integrations";
import { WebsiteModule } from "./website";
import { MarketplaceSettingsModule } from "./marketplaceSettings";
import { FeedbackModule } from "./feedback";
import { BillingModule } from "./billing";
import { SettingsModule } from "./settings";
import { firstAvailableOrg, ModuleHeader, ModuleSwitcherBar } from "./moduleShared";
import { styles } from "./moduleStyles";

function ModuleBody({
  moduleId,
  myMembership,
  org,
}: {
  moduleId: NativeModuleId;
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
}) {
  switch (moduleId) {
    case "marketplace":
      return <DedicatedMarketplaceModule orgId={org._id} />;
    case "vehicles":
      return <VehiclesModule orgId={org._id} permissions={myMembership.permissions} />;
    case "customers":
      return <CustomersModule orgId={org._id} permissions={myMembership.permissions} />;
    case "leads":
      return <LeadsModule orgId={org._id} />;
    case "messages":
      return <MessagesModule orgId={org._id} />;
    case "socialInbox":
      return <SocialInboxModule orgId={org._id} />;
    case "notifications":
      return <NotificationsModule orgId={org._id} />;
    case "tasks":
      return <TasksModule orgId={org._id} />;
    case "sales":
      return <SalesModule myMembership={myMembership} orgId={org._id} />;
    case "expenses":
      return <ExpensesModule orgId={org._id} />;
    case "accounting":
      return <AccountingModule orgId={org._id} />;
    case "sourcing":
      return <SourcingModule orgId={org._id} />;
    case "reports":
      return <ReportsModule orgId={org._id} />;
    case "team":
      return <TeamModule orgId={org._id} />;
    case "applications":
      return <ApplicationsModule orgId={org._id} />;
    case "approvals":
      return <ApprovalsModule orgId={org._id} />;
    case "commissions":
      return <CommissionsModule orgId={org._id} />;
    case "quotes":
      return <QuotesModule orgId={org._id} />;
    case "financeCompanies":
      return <FinanceCompaniesModule orgId={org._id} />;
    case "valuationCompanies":
      return <ValuationCompaniesModule orgId={org._id} />;
    case "branches":
      return <BranchesModule orgId={org._id} />;
    case "roles":
      return <RolesModule orgId={org._id} />;
    case "pipelineSettings":
      return <PipelineSettingsModule orgId={org._id} />;
    case "leadSources":
      return <LeadSourcesModule orgId={org._id} />;
    case "customFields":
      return <CustomFieldsModule orgId={org._id} />;
    case "commissionSettings":
      return <CommissionSettingsModule orgId={org._id} />;
    case "integrations":
      return <IntegrationsModule orgId={org._id} />;
    case "website":
      return <WebsiteModule orgId={org._id} />;
    case "marketplaceSettings":
      return <MarketplaceSettingsModule orgId={org._id} />;
    case "feedback":
      return <FeedbackModule orgId={org._id} />;
    case "billing":
      return <BillingModule orgId={org._id} />;
    case "settings":
      return <SettingsModule myMembership={myMembership} org={org} />;
  }
}

export function WorkspaceModuleScreen({
  moduleId,
  orgId,
}: {
  moduleId: string | null;
  orgId: string | null;
}) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const canQuery = isLoaded && isSignedIn && Boolean(orgId);
  const orgs = useQuery(api.organizations.listMine, canQuery ? {} : "skip");
  const myMembership = useQuery(api.memberships.getMyMembership, canQuery && orgId ? { orgId } : "skip");
  const moduleDefinition = useMemo(() => getNativeModule(moduleId), [moduleId]);
  const selectedOrg = firstAvailableOrg(orgs).find((org) => org._id === orgId) ?? null;

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

  if (!orgId || !isLoaded || !isSignedIn || orgs === undefined || myMembership === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingWorkspace")} />
      </Screen>
    );
  }

  if (
    !selectedOrg ||
    !moduleDefinition ||
    !canAccessNativeModule(moduleDefinition, myMembership.permissions, myMembership.roleName)
  ) {
    return (
      <Screen>
        <View style={styles.unavailable}>
          <Text style={styles.errorTitle}>{t("notFoundTitle")}</Text>
          <Text style={styles.errorBody}>{t("notFoundBody")}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ModuleHeader
        title={labelFor(moduleDefinition.title, locale)}
        subtitle={labelFor(moduleDefinition.subtitle, locale)}
      />
      <ModuleSwitcherBar
        activeModuleId={moduleDefinition.id}
        orgId={selectedOrg._id}
        permissions={myMembership.permissions}
        roleName={myMembership.roleName}
      />
      <ModuleBody moduleId={moduleDefinition.id} myMembership={myMembership} org={selectedOrg} />
    </Screen>
  );
}

