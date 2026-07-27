/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";

/**
 * Same-frame double-tap guard for the auth screen.
 *
 * `busy` is state, so two taps in one frame both read the pre-update value and
 * the `disabled` prop has not re-rendered either — only the synchronous
 * in-flight ref stops the second call. Reproducing that means firing the second
 * press before awaiting the first, which leaves the renderer unable to mount
 * anything afterwards. So this file holds exactly ONE test: any test added
 * below it would fail on queries that pass in isolation.
 */
const mockReplace = jest.fn();
const mockSetActive = jest.fn();
const mockStartSSOFlow = jest.fn();
const mockSignInCreate = jest.fn();
const mockAttemptFirstFactor = jest.fn();
const mockSignUpCreate = jest.fn();
const mockPrepareVerification = jest.fn();
const mockAttemptVerification = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({}),
}));

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: false }),
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
    setActive: jest.fn(),
    signUp: {
      create: mockSignUpCreate,
      prepareEmailAddressVerification: mockPrepareVerification,
      attemptEmailAddressVerification: mockAttemptVerification,
    },
  }),
}));

jest.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: false }) }));

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import SignInRoute from "../../../app/(auth)/sign-in";

// Default locale is Arabic (DEFAULT_LOCALE = "ar").
const AR = {
  createAccount: "إنشاء حساب",
  submitSignUp: "إنشاء الحساب",
  email: "البريد الإلكتروني",
  identifier: "البريد الإلكتروني أو اسم المستخدم",
  password: "كلمة المرور",
  submitSignIn: "تسجيل الدخول",
  code: "رمز التحقق",
  confirm: "تأكيد",
  resend: "إعادة إرسال الرمز",
  google: "المتابعة عبر Google",
  signingIn: "جارٍ تسجيل الدخول…",
  creatingAccount: "جاري إنشاء الحساب…",
  confirming: "جاري التأكيد…",
  changeEmail: "استخدام بريد آخر",
};

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

/** A promise the test releases by hand, so a handler can be held mid-flight. */
function deferred() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: (value?: unknown) => release(value) };
}

async function fillCredentials(screen: Screen) {
  const identifierField = screen.queryByLabelText(AR.identifier) ?? screen.getByLabelText(AR.email);
  await fireEvent.changeText(identifierField, "sami@example.com");
  await fireEvent.changeText(screen.getByLabelText(AR.password), "hunter2hunter2");
}

test("a double-tap in one frame starts only one SSO round-trip", async () => {
  const gate = deferred();
  mockStartSSOFlow.mockReturnValue(gate.promise);
  const screen = await renderScreen();
  const googleButton = screen.getByLabelText(AR.google);

  const first = fireEvent.press(googleButton);
  const second = fireEvent.press(googleButton);
  gate.release({ createdSessionId: null, setActive: undefined });
  await Promise.all([first, second]);

  expect(mockStartSSOFlow).toHaveBeenCalledTimes(1);
});
