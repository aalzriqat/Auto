import { AuthView } from "@clerk/expo/native";
import { useRouter } from "expo-router";

import { Screen } from "../../src/components/Screen";

export default function SignInRoute() {
  const router = useRouter();

  return (
    <Screen>
      <AuthView onDismiss={() => router.replace("/")} />
    </Screen>
  );
}
