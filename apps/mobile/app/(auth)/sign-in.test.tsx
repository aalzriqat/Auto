/// <reference types="jest" />

import { cleanup, render, waitFor } from "@testing-library/react-native";

/**
 * Covers the custom auth screen, which is the only entry point to an AutoFlow
 * account on mobile — both the dealer sign-in and the buyer/private-seller
 * sign-up the marketplace sell flow depends on. It was previously untested,
 * which also left the package's 100% coverage gate failing (silently, since no
 * CI job runs mobile jest).
 *
 * Clerk's hooks are mocked at the module boundary so the routing decisions can
 * be driven deterministically without a network or a real Clerk instance.
 *
 * SCOPE LIMIT: only the mount-time routing is covered. Interaction tests
 * (pressing sign in / create account and asserting the Clerk calls) could not
 * be landed here: in this jest-expo + React 19 setup, every render after the
 * first `fireEvent.press` in a file produces an empty tree, so any second
 * interactive test fails on queries that demonstrably succeed in isolation.
 * That is a renderer/environment issue, not a defect in the screen. Until it is
 * resolved this file leaves sign-in.tsx short of the package's 100% coverage
 * threshold, so `pnpm test` still exits non-zero on the coverage gate.
 */
const mockReplace = jest.fn();
const mockSetActive = jest.fn();
const mockSetActiveSignUp = jest.fn();
const mockStartSSOFlow = jest.fn();
const mockSignInCreate = jest.fn();
const mockAttemptFirstFactor = jest.fn();
const mockSignUpCreate = jest.fn();
const mockPrepareVerification = jest.fn();
const mockAttemptVerification = jest.fn();

let mockIsSignedIn: boolean;
let mockIsAuthenticated: boolean;
let mockSearchParams: Record<string, string>;

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: mockIsSignedIn }),
  useSSO: () => ({ startSSOFlow: mockStartSSOFlow }),
}));

jest.mock("@clerk/expo/legacy", () => ({
  useSignIn: () => ({
    isLoaded: true,
    setActive: mockSetActive,
    signIn: { create: mockSignInCreate, attemptFirstFactor: mockAttemptFirstFactor },
  }),
  useSignUp: () => ({
    isLoaded: true,
    setActive: mockSetActiveSignUp,
    signUp: {
      create: mockSignUpCreate,
      prepareEmailAddressVerification: mockPrepareVerification,
      attemptEmailAddressVerification: mockAttemptVerification,
    },
  }),
}));

jest.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: mockIsAuthenticated }) }));

import { LocaleProvider } from "../../src/providers/LocaleProvider";
import { ThemeProvider } from "../../src/providers/ThemeProvider";
import SignInRoute from "./sign-in";

// Default locale is Arabic (DEFAULT_LOCALE = "ar"), so assertions use the AR strings.
const AR = {
  signIn: "تسجيل الدخول",
  createAccount: "إنشاء حساب",
  email: "البريد الإلكتروني",
  identifier: "البريد الإلكتروني أو اسم المستخدم",
  password: "كلمة المرور",
  submitSignIn: "تسجيل الدخول",
  code: "رمز التحقق",
  confirm: "تأكيد",
  resend: "إعادة إرسال الرمز",
  google: "المتابعة عبر Google",
  noAccount: "جديد على أوتوفلو؟",
  haveAccount: "لديك حساب بالفعل؟",
  // The mode-switch link's label. In sign-in mode the primary button is
  // "تسجيل الدخول" and the link is "إنشاء حساب"; in sign-up mode they swap, so
  // each label resolves to exactly one control in whichever mode is mounted.
  signInLink: "تسجيل الدخول",
};

/**
 * LocaleProvider resolves the persisted locale asynchronously and renders
 * nothing until it settles, so querying straight after render() hits an empty
 * tree. Wait for a control that only exists once the form is mounted.
 */
async function renderScreen() {
  const screen = await render(
    <ThemeProvider>
      <LocaleProvider>
        <SignInRoute />
      </LocaleProvider>
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText(AR.password)).toBeTruthy());
  return screen;
}

describe("SignInRoute", () => {
  beforeEach(() => {
    // Reset only this suite's mocks. jest.clearAllMocks() would also strip the
    // implementations off jest.setup.ts's expo-secure-store mock, leaving the
    // locale provider awaiting a promise that never resolves — the screen then
    // renders nothing and every query fails with a confusing "unable to find".
    [
      mockReplace,
      mockSetActive,
      mockSetActiveSignUp,
      mockStartSSOFlow,
      mockSignInCreate,
      mockAttemptFirstFactor,
      mockSignUpCreate,
      mockPrepareVerification,
      mockAttemptVerification,
    ].forEach((fn) => fn.mockReset());
    mockIsSignedIn = false;
    mockIsAuthenticated = false;
    mockSearchParams = {};
  });

  // RTL auto-cleanup runs synchronously; these screens finish async auth work
  // after the test body returns, so unmount explicitly and let those settle
  // before the next render mounts a fresh tree.
  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  });

  describe("redirect on an already-active session", () => {
    test("sends a signed-in dealer to the workspace picker", async () => {
      mockIsSignedIn = true;
      mockIsAuthenticated = true;
      await renderScreen();
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/workspaces"));
    });

    test("honours returnTo so the sell flow lands back on the marketplace", async () => {
      mockIsSignedIn = true;
      mockIsAuthenticated = true;
      mockSearchParams = { returnTo: "marketplace" };
      await renderScreen();
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/marketplace"));
    });

    test("stays put when Clerk is signed in but Convex has not accepted the token", async () => {
      // Redirecting on isSignedIn alone bounced the user straight back here
      // from home, trapping them with no way to retry.
      mockIsSignedIn = true;
      mockIsAuthenticated = false;
      await renderScreen();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
