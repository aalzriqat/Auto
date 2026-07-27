/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";

/**
 * Covers the custom auth screen, which is the only entry point to an AutoFlow
 * account on mobile — both the dealer sign-in and the buyer/private-seller
 * sign-up the marketplace sell flow depends on.
 *
 * Clerk's hooks are mocked at the module boundary so each auth outcome
 * (success, extra-verification-required, thrown API error) can be driven
 * deterministically without a network or a real Clerk instance.
 *
 * NOTE: under @testing-library/react-native v14 + React 19, `render` and every
 * `fireEvent` are async and MUST be awaited. Leaving one unawaited lets its
 * state update settle after the test body returns, which corrupts the renderer
 * for the rest of the file — every later render then yields an empty tree and
 * fails on queries that pass in isolation.
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

/**
 * Auth state behind a tiny external store rather than plain variables. Clerk's
 * real hooks are state-backed, so activating a session re-renders the screen
 * and re-runs its redirect effect. A mutated module variable would not, which
 * would let the sign-up redirect test below pass even with the guard it exists
 * to protect removed.
 */
const mockAuth = { isSignedIn: false, isAuthenticated: false };
const mockAuthListeners = new Set<() => void>();
let mockAuthVersion = 0;
const mockSubscribeAuth = (cb: () => void) => {
  mockAuthListeners.add(cb);
  return () => void mockAuthListeners.delete(cb);
};
// Snapshot is a version counter: useSyncExternalStore compares with Object.is,
// so returning the (mutated) state object itself would never look changed.
const mockGetAuthVersion = () => mockAuthVersion;
const mockSetAuth = (next: Partial<typeof mockAuth>) => {
  Object.assign(mockAuth, next);
  mockAuthVersion += 1;
  mockAuthListeners.forEach((cb) => cb());
};

let mockSearchParams: Record<string, string>;

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));

jest.mock("@clerk/expo", () => ({
  useAuth: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("react").useSyncExternalStore(mockSubscribeAuth, mockGetAuthVersion);
    return { isSignedIn: mockAuth.isSignedIn };
  },
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

jest.mock("convex/react", () => ({
  useConvexAuth: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("react").useSyncExternalStore(mockSubscribeAuth, mockGetAuthVersion);
    return { isAuthenticated: mockAuth.isAuthenticated };
  },
}));

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import SignInRoute from "../../../app/(auth)/sign-in";

// Default locale is Arabic (DEFAULT_LOCALE = "ar"), so assertions use the AR strings.
const AR = {
  // The footer link that switches into sign-up mode (signUpSwitchToSignUp)...
  createAccount: "إنشاء حساب",
  // ...distinct from the sign-up submit button (signUpSubmit). Near-identical
  // in Arabic, one definite article apart, so keep them separate here.
  submitSignUp: "إنشاء الحساب",
  email: "البريد الإلكتروني",
  identifier: "البريد الإلكتروني أو اسم المستخدم",
  password: "كلمة المرور",
  submitSignIn: "تسجيل الدخول",
  code: "رمز التحقق",
  confirm: "تأكيد",
  resend: "إعادة إرسال الرمز",
  changeEmail: "استخدام بريد آخر",
  google: "المتابعة عبر Google",
  // The mode-switch link. In sign-in mode the primary button is "تسجيل الدخول"
  // and the link is "إنشاء حساب"; in sign-up mode they swap, so each label
  // resolves to exactly one control in whichever mode is mounted.
  switchToSignIn: "تسجيل الدخول",
};

/**
 * LocaleProvider resolves the persisted locale asynchronously and renders
 * nothing until it settles, so wait for a control that only exists once the
 * form is mounted before handing the screen to a test.
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

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/**
 * Fills the shared email/password pair. The identifier field's label differs
 * between modes ("Email or username" signing in, "Email" signing up), so
 * resolve whichever is currently mounted.
 */
async function fillCredentials(
  screen: Screen,
  { identifier = "sami@example.com", password = "hunter2hunter2" } = {},
) {
  const identifierField = screen.queryByLabelText(AR.identifier) ?? screen.getByLabelText(AR.email);
  await fireEvent.changeText(identifierField, identifier);
  await fireEvent.changeText(screen.getByLabelText(AR.password), password);
}

/** Switches the form into sign-up mode via the footer toggle. */
async function openSignUp(screen: Screen) {
  await fireEvent.press(screen.getByLabelText(AR.createAccount));
  await waitFor(() => expect(screen.getByLabelText(AR.email)).toBeTruthy());
}

/** Registers, then waits for the email-code step to replace the credential form. */
async function reachVerifyStep(screen: Screen) {
  await openSignUp(screen);
  await fillCredentials(screen);
  await fireEvent.press(screen.getByLabelText(AR.submitSignUp));
  await waitFor(() => expect(screen.getByLabelText(AR.confirm)).toBeTruthy());
}

describe("SignInRoute", () => {
  beforeEach(() => {
    // Reset only this suite's mocks. jest.clearAllMocks() would also strip the
    // implementations off jest.setup.ts's expo-secure-store mock, leaving the
    // locale provider awaiting a promise that never resolves.
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
    mockAuth.isSignedIn = false;
    mockAuth.isAuthenticated = false;
    mockAuthVersion += 1;
    mockSearchParams = {};
  });

  describe("redirect on an already-active session", () => {
    test("sends a signed-in dealer to the workspace picker", async () => {
      mockSetAuth({ isSignedIn: true, isAuthenticated: true });
      await renderScreen();
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/workspaces"));
    });

    test("honours returnTo so the sell flow lands back on the marketplace", async () => {
      mockSetAuth({ isSignedIn: true, isAuthenticated: true });
      mockSearchParams = { returnTo: "marketplace" };
      await renderScreen();
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/marketplace"));
    });

    test("stays put when Clerk is signed in but Convex has not accepted the token", async () => {
      // Redirecting on isSignedIn alone bounced the user straight back here
      // from home, trapping them with no way to retry.
      mockSetAuth({ isSignedIn: true, isAuthenticated: false });
      await renderScreen();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe("password sign-in", () => {
    test("activates the session and leaves the screen on success", async () => {
      mockAttemptFirstFactor.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
      const screen = await renderScreen();
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      await waitFor(() => expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_1" }));
      expect(mockSignInCreate).toHaveBeenCalledWith({ identifier: "sami@example.com" });
      expect(mockReplace).toHaveBeenCalledWith("/workspaces");
    });

    test("returns to the marketplace after signing in from the sell flow", async () => {
      mockSearchParams = { returnTo: "marketplace" };
      mockAttemptFirstFactor.mockResolvedValue({ status: "complete", createdSessionId: "sess_2" });
      const screen = await renderScreen();
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/marketplace"));
    });

    test("explains rather than silently failing when 2FA is required", async () => {
      mockAttemptFirstFactor.mockResolvedValue({ status: "needs_second_factor" });
      const screen = await renderScreen();
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      await waitFor(() => expect(screen.getByText(/خطوة إضافية|الويب/)).toBeTruthy());
      expect(mockSetActive).not.toHaveBeenCalled();
    });

    test("surfaces the Clerk error message when the attempt throws", async () => {
      mockSignInCreate.mockRejectedValue({ errors: [{ message: "Couldn't find your account." }] });
      const screen = await renderScreen();
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      await waitFor(() => expect(screen.getByText("Couldn't find your account.")).toBeTruthy());
    });

    test("falls back to a generic message when the error carries none", async () => {
      mockSignInCreate.mockRejectedValue(new Error("opaque"));
      const screen = await renderScreen();
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      await waitFor(() => expect(screen.getByText(/تعذّر|حاول/)).toBeTruthy());
    });

    test("does nothing without both an identifier and a password", async () => {
      const screen = await renderScreen();

      await fireEvent.press(screen.getByLabelText(AR.submitSignIn));

      expect(mockSignInCreate).not.toHaveBeenCalled();
    });

  });

  describe("Google SSO", () => {
    test("activates the returned session", async () => {
      mockStartSSOFlow.mockResolvedValue({ createdSessionId: "sess_g", setActive: mockSetActive });
      const screen = await renderScreen();

      await fireEvent.press(screen.getByLabelText(AR.google));

      await waitFor(() => expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_g" }));
      expect(mockReplace).toHaveBeenCalledWith("/workspaces");
    });

    test("treats a closed browser tab as a no-op, not an error", async () => {
      mockStartSSOFlow.mockResolvedValue({ createdSessionId: null, setActive: undefined });
      const screen = await renderScreen();

      await fireEvent.press(screen.getByLabelText(AR.google));

      await waitFor(() => expect(mockStartSSOFlow).toHaveBeenCalled());
      expect(mockReplace).not.toHaveBeenCalled();
    });

    test("surfaces a thrown SSO error", async () => {
      mockStartSSOFlow.mockRejectedValue({ errors: [{ message: "SSO unavailable." }] });
      const screen = await renderScreen();

      await fireEvent.press(screen.getByLabelText(AR.google));

      await waitFor(() => expect(screen.getByText("SSO unavailable.")).toBeTruthy());
    });

  });

  describe("sign-up", () => {
    test("registers the account and moves to the email-code step", async () => {
      const screen = await renderScreen();
      await openSignUp(screen);
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignUp));

      await waitFor(() =>
        expect(mockSignUpCreate).toHaveBeenCalledWith({
          emailAddress: "sami@example.com",
          password: "hunter2hunter2",
        }),
      );
      expect(mockPrepareVerification).toHaveBeenCalledWith({ strategy: "email_code" });
      expect(screen.getByLabelText(AR.confirm)).toBeTruthy();
    });

    test("completes verification and sends the new buyer to the marketplace", async () => {
      // A self-registered account has no org, so the workspace picker would
      // show nothing but an empty state.
      mockAttemptVerification.mockResolvedValue({ status: "complete", createdSessionId: "sess_new" });
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.changeText(screen.getByLabelText(AR.code), "123456");
      await fireEvent.press(screen.getByLabelText(AR.confirm));

      await waitFor(() => expect(mockSetActiveSignUp).toHaveBeenCalledWith({ session: "sess_new" }));
      expect(mockAttemptVerification).toHaveBeenCalledWith({ code: "123456" });
      expect(mockReplace).toHaveBeenCalledWith("/marketplace");
    });

    test("keeps a new buyer on the marketplace once the session goes live", async () => {
      // Activating the session flips Clerk's isSignedIn, which fires the
      // mount-time redirect effect. That effect defaults to the dealer
      // workspace picker, so without the sign-up flag it overrides the
      // navigation and strands a brand-new account on an empty state.
      mockAttemptVerification.mockResolvedValue({ status: "complete", createdSessionId: "sess_live" });
      mockSetActiveSignUp.mockImplementation(async () => {
        mockSetAuth({ isSignedIn: true, isAuthenticated: true });
      });
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.changeText(screen.getByLabelText(AR.code), "123456");
      await fireEvent.press(screen.getByLabelText(AR.confirm));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/marketplace"));
      expect(mockReplace).not.toHaveBeenCalledWith("/workspaces");
    });

    test("explains an incomplete verification instead of doing nothing", async () => {
      mockAttemptVerification.mockResolvedValue({ status: "missing_requirements" });
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.changeText(screen.getByLabelText(AR.code), "000000");
      await fireEvent.press(screen.getByLabelText(AR.confirm));

      await waitFor(() => expect(screen.getByText(/خطوات إضافية|الموقع/)).toBeTruthy());
      expect(mockSetActiveSignUp).not.toHaveBeenCalled();
    });

    test("surfaces a registration error (e.g. address already taken)", async () => {
      mockSignUpCreate.mockRejectedValue({ errors: [{ message: "That email is taken." }] });
      const screen = await renderScreen();
      await openSignUp(screen);
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignUp));

      await waitFor(() => expect(screen.getByText("That email is taken.")).toBeTruthy());
    });

    test("falls back to a generic message when the registration error carries none", async () => {
      mockSignUpCreate.mockRejectedValue(new Error("opaque"));
      const screen = await renderScreen();
      await openSignUp(screen);
      await fillCredentials(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignUp));

      await waitFor(() => expect(screen.getByText(/تعذّر إنشاء الحساب/)).toBeTruthy());
    });

    test("surfaces a verification error", async () => {
      mockAttemptVerification.mockRejectedValue({ errors: [{ message: "Incorrect code." }] });
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.changeText(screen.getByLabelText(AR.code), "999999");
      await fireEvent.press(screen.getByLabelText(AR.confirm));

      await waitFor(() => expect(screen.getByText("Incorrect code.")).toBeTruthy());
    });

    test("does nothing without both an email and a password", async () => {
      const screen = await renderScreen();
      await openSignUp(screen);

      await fireEvent.press(screen.getByLabelText(AR.submitSignUp));

      expect(mockSignUpCreate).not.toHaveBeenCalled();
    });

    test("does not submit an empty verification code", async () => {
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.press(screen.getByLabelText(AR.confirm));

      expect(mockAttemptVerification).not.toHaveBeenCalled();
    });


    test("resends the code on request", async () => {
      const screen = await renderScreen();
      await reachVerifyStep(screen);
      mockPrepareVerification.mockClear();

      await fireEvent.press(screen.getByLabelText(AR.resend));

      await waitFor(() => expect(mockPrepareVerification).toHaveBeenCalledWith({ strategy: "email_code" }));
    });

    test("surfaces an error when resending the code fails", async () => {
      const screen = await renderScreen();
      await reachVerifyStep(screen);
      mockPrepareVerification.mockRejectedValue({ errors: [{ message: "Too many attempts." }] });

      await fireEvent.press(screen.getByLabelText(AR.resend));

      await waitFor(() => expect(screen.getByText("Too many attempts.")).toBeTruthy());
    });

    test("lets a mistyped email be corrected instead of dead-ending on the code step", async () => {
      // No code ever arrives for a typo'd address, and without a way back the
      // credential form is unreachable short of killing the app.
      const screen = await renderScreen();
      await reachVerifyStep(screen);

      await fireEvent.press(screen.getByLabelText(AR.changeEmail));

      await waitFor(() => expect(screen.getByLabelText(AR.email)).toBeTruthy());
      expect(screen.queryByLabelText(AR.confirm)).toBeNull();
    });

    test("clears a stale error and returns to the sign-in form on switch", async () => {
      mockSignUpCreate.mockRejectedValue({ errors: [{ message: "That email is taken." }] });
      const screen = await renderScreen();
      await openSignUp(screen);
      await fillCredentials(screen);
      await fireEvent.press(screen.getByLabelText(AR.submitSignUp));
      await waitFor(() => expect(screen.getByText("That email is taken.")).toBeTruthy());

      await fireEvent.press(screen.getByLabelText(AR.switchToSignIn));

      await waitFor(() => expect(screen.queryByText("That email is taken.")).toBeNull());
      expect(screen.getByLabelText(AR.identifier)).toBeTruthy();
    });
  });
});
