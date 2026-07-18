import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useLocale } from "../../../providers/LocaleProvider";
import { PrimaryButton, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function DedicatedMarketplaceModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const router = useRouter();
  const { locale } = useLocale();

  return (
    <ModuleScroll>
      <View style={styles.emptyState}>
        <Text style={styles.sectionTitle}>
          {locale === "ar" ? "طلبات السوق لها شاشة مخصصة." : "Marketplace requests use a dedicated screen."}
        </Text>
        <Text style={styles.emptyText}>
          {locale === "ar"
            ? "افتح شاشة السوق الأصلية للرد على طلبات المشترين وسيارات البدل."
            : "Open the native marketplace screen to respond to buyer requests and trade-ins."}
        </Text>
        <PrimaryButton
          label={locale === "ar" ? "فتح السوق" : "Open marketplace"}
          onPress={() =>
            router.replace({
              pathname: "/org/[orgId]/marketplace",
              params: { orgId },
            })
          }
        />
      </View>
    </ModuleScroll>
  );
}

