/// <reference types="jest" />

import { nativeRoutes } from "@autoflow/shared";
import { fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";

import NotFoundRoute, { getNotFoundButtonPressedStyle } from "../../app/+not-found";
import RootLayout, { ErrorBoundary } from "../../app/_layout";
import AppLayout from "../../app/(app)/_layout";
import HomeRoute from "../../app/(app)/index";
import MarketplaceRoute from "../../app/(app)/marketplace";
import OrgDashboardRoute from "../../app/(app)/org/[orgId]";
import DealerMarketplaceRoute from "../../app/(app)/org/[orgId]/marketplace";
import WorkspaceModuleRoute from "../../app/(app)/org/[orgId]/module/[moduleId]";
import OrgWorkspaceTabsRoute from "../../app/(app)/org/[orgId]/(tabs)/_layout";
import OrgWorkspaceAdminRoute from "../../app/(app)/org/[orgId]/(tabs)/admin";
import OrgWorkspaceFinanceRoute from "../../app/(app)/org/[orgId]/(tabs)/finance";
import OrgWorkspaceHomeRoute from "../../app/(app)/org/[orgId]/(tabs)/home";
import OrgWorkspaceOperationsRoute from "../../app/(app)/org/[orgId]/(tabs)/operations";
import OrgWorkspacePipelineRoute from "../../app/(app)/org/[orgId]/(tabs)/pipeline";
import AuthLayout from "../../app/(auth)/_layout";
import SignInRoute from "../../app/(auth)/sign-in";

const mockReplace = jest.fn();
let mockParams: Record<string, string | string[] | undefined> = {};

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    Redirect: ({ href }: { href: unknown }) =>
      React.createElement(Text, { testID: "redirect" }, JSON.stringify(href)),
    Stack: ({ screenOptions }: { screenOptions?: Record<string, unknown> }) =>
      React.createElement(Text, { testID: "stack" }, JSON.stringify(screenOptions ?? {})),
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ replace: mockReplace }),
  };
});

jest.mock("@clerk/expo/native", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    AuthView: ({ onDismiss }: { onDismiss: () => void }) =>
      React.createElement(
        Pressable,
        { accessibilityLabel: "dismiss-auth", accessibilityRole: "button", onPress: onDismiss },
        React.createElement(Text, null, "AuthView"),
      ),
  };
});

jest.mock("../providers/AppProviders", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("../providers/AppFontContext", () => ({
  useAppFontState: () => ({ fontLoadError: null, fontsLoaded: true }),
}));

jest.mock("../providers/LocaleProvider", () => ({
  useLocale: () => ({
    isRtl: false,
    locale: "en",
    setLocale: jest.fn(),
    t: (key: string) => key,
    textDirection: "ltr",
  }),
}));

jest.mock("../features/home/HomeScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    HomeScreen: () => React.createElement(Text, { testID: "home-screen" }, "HomeScreen"),
  };
});

jest.mock("../features/marketplace/MarketplaceScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    MarketplaceScreen: () => React.createElement(Text, { testID: "marketplace-screen" }, "MarketplaceScreen"),
  };
});

jest.mock("../features/dashboard/OrgDashboardScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    OrgDashboardScreen: ({ orgId }: { orgId: string | null }) =>
      React.createElement(Text, { testID: "org-dashboard-screen" }, orgId ?? "null"),
  };
});

jest.mock("../features/workspace/WorkspaceTabsLayout", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    WorkspaceTabsLayout: ({ orgId }: { orgId: string | null }) =>
      React.createElement(Text, { testID: "workspace-tabs-layout" }, orgId ?? "null"),
  };
});

jest.mock("../features/workspace/WorkspaceCategoryScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    WorkspaceCategoryScreen: ({ category }: { category: string }) =>
      React.createElement(Text, { testID: `workspace-category-${category}` }, category),
  };
});

jest.mock("../features/marketplace/DealerMarketplaceScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    DealerMarketplaceScreen: ({ orgId }: { orgId: string | null }) =>
      React.createElement(Text, { testID: "dealer-marketplace-screen" }, orgId ?? "null"),
  };
});

jest.mock("../features/workspace/WorkspaceModuleScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    WorkspaceModuleScreen: ({ moduleId, orgId }: { moduleId: string | null; orgId: string | null }) =>
      React.createElement(Text, { testID: "workspace-module-screen" }, `${orgId ?? "null"}:${moduleId ?? "null"}`),
  };
});

describe("mobile Expo routes", () => {
  beforeEach(() => {
    mockParams = {};
    mockReplace.mockReset();
  });

  test("renders the root layout and route error boundary", async () => {
    const retry = jest.fn();
    const root = await render(<RootLayout />);

    expect(root.getByTestId("stack").props.children).toContain("\"headerShown\":false");

    const boundary = await render(<ErrorBoundary error={new Error("Route exploded")} retry={retry} />);
    expect(boundary.getByText("Route exploded")).toBeTruthy();
    await fireEvent.press(boundary.getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("renders stack-only layouts with their navigation options", async () => {
    const auth = await render(<AuthLayout />);
    expect(auth.getByTestId("stack").props.children).toContain("\"presentation\":\"modal\"");

    const app = await render(<AppLayout />);
    expect(app.getByTestId("stack").props.children).toContain("\"headerShown\":false");
  });

  test("renders top-level app routes", async () => {
    expect((await render(<HomeRoute />)).getByTestId("home-screen").props.children).toBe("HomeScreen");
    expect((await render(<MarketplaceRoute />)).getByTestId("marketplace-screen").props.children).toBe(
      "MarketplaceScreen",
    );
  });

  test("navigates home from the not-found route", async () => {
    const { getByText } = await render(<NotFoundRoute />);
    const homeText = getByText("home");

    expect(getNotFoundButtonPressedStyle(false)).toBeNull();
    expect(getNotFoundButtonPressedStyle(true)).not.toBeNull();
    await fireEvent(homeText, "pressIn");
    await fireEvent(homeText, "pressOut");
    await fireEvent.press(homeText);

    expect(mockReplace).toHaveBeenCalledWith(nativeRoutes.home);
  });

  test("dismisses auth back to the home route", async () => {
    const { getByLabelText } = await render(<SignInRoute />);

    await fireEvent.press(getByLabelText("dismiss-auth"));

    expect(mockReplace).toHaveBeenCalledWith("/");
  });

  test("redirects old org route params into the home tab", async () => {
    mockParams = { orgId: "org-string" };
    expect((await render(<OrgDashboardRoute />)).getByTestId("redirect").props.children).toContain(
      nativeRoutes.orgHome,
    );
    expect((await render(<OrgDashboardRoute />)).getByTestId("redirect").props.children).toContain(
      "org-string",
    );

    mockParams = { orgId: ["org-array"] };
    expect((await render(<OrgDashboardRoute />)).getByTestId("redirect").props.children).toContain(
      "org-array",
    );

    mockParams = { orgId: [] };
    expect((await render(<OrgDashboardRoute />)).getByTestId("redirect").props.children).toBe(
      JSON.stringify(nativeRoutes.home),
    );

    mockParams = {};
    expect((await render(<OrgDashboardRoute />)).getByTestId("redirect").props.children).toBe(
      JSON.stringify(nativeRoutes.home),
    );
  });

  test("normalizes org tab layout and home tab route params", async () => {
    mockParams = { orgId: "org-string" };
    expect((await render(<OrgWorkspaceTabsRoute />)).getByTestId("workspace-tabs-layout").props.children).toBe(
      "org-string",
    );
    expect((await render(<OrgWorkspaceHomeRoute />)).getByTestId("org-dashboard-screen").props.children).toBe(
      "org-string",
    );

    mockParams = { orgId: ["org-array"] };
    expect((await render(<OrgWorkspaceTabsRoute />)).getByTestId("workspace-tabs-layout").props.children).toBe(
      "org-array",
    );
    expect((await render(<OrgWorkspaceHomeRoute />)).getByTestId("org-dashboard-screen").props.children).toBe(
      "org-array",
    );

    mockParams = { orgId: [] };
    expect((await render(<OrgWorkspaceTabsRoute />)).getByTestId("workspace-tabs-layout").props.children).toBe(
      "null",
    );
    expect((await render(<OrgWorkspaceHomeRoute />)).getByTestId("org-dashboard-screen").props.children).toBe("null");

    mockParams = {};
    expect((await render(<OrgWorkspaceTabsRoute />)).getByTestId("workspace-tabs-layout").props.children).toBe(
      "null",
    );
    expect((await render(<OrgWorkspaceHomeRoute />)).getByTestId("org-dashboard-screen").props.children).toBe("null");
  });

  test("renders workspace category tab routes", async () => {
    expect((await render(<OrgWorkspaceOperationsRoute />)).getByTestId("workspace-category-operations").props.children).toBe(
      "operations",
    );
    expect((await render(<OrgWorkspacePipelineRoute />)).getByTestId("workspace-category-pipeline").props.children).toBe(
      "pipeline",
    );
    expect((await render(<OrgWorkspaceFinanceRoute />)).getByTestId("workspace-category-finance").props.children).toBe(
      "finance",
    );
    expect((await render(<OrgWorkspaceAdminRoute />)).getByTestId("workspace-category-admin").props.children).toBe(
      "admin",
    );
  });

  test("normalizes dealer marketplace route params", async () => {
    mockParams = { orgId: "dealer-org" };
    expect((await render(<DealerMarketplaceRoute />)).getByTestId("dealer-marketplace-screen").props.children).toBe(
      "dealer-org",
    );

    mockParams = { orgId: ["dealer-array"] };
    expect((await render(<DealerMarketplaceRoute />)).getByTestId("dealer-marketplace-screen").props.children).toBe(
      "dealer-array",
    );

    mockParams = { orgId: [] };
    expect((await render(<DealerMarketplaceRoute />)).getByTestId("dealer-marketplace-screen").props.children).toBe(
      "null",
    );

    mockParams = {};
    expect((await render(<DealerMarketplaceRoute />)).getByTestId("dealer-marketplace-screen").props.children).toBe(
      "null",
    );
  });

  test("normalizes workspace module route params", async () => {
    mockParams = { moduleId: ["vehicles"], orgId: "org-1" };
    expect((await render(<WorkspaceModuleRoute />)).getByTestId("workspace-module-screen").props.children).toBe(
      "org-1:vehicles",
    );

    mockParams = { moduleId: [], orgId: [] };
    expect((await render(<WorkspaceModuleRoute />)).getByTestId("workspace-module-screen").props.children).toBe(
      "null:null",
    );

    mockParams = {};
    expect((await render(<WorkspaceModuleRoute />)).getByTestId("workspace-module-screen").props.children).toBe(
      "null:null",
    );
  });
});
