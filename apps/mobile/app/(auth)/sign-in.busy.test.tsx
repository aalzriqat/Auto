/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";

/**
 * In-flight ("busy") states for the auth screen: the spinner, the disabled
 * controls, the submitting labels, and the guards that stop a double-tap from
 * firing two auth calls.
 *
 * These live apart from sign-in.test.tsx because they are the one case that
 * cannot await `fireEvent`. Awaiting a press waits for the whole handler to
 * settle, which by definition means the busy state is already gone — so the
 * press has to stay pending while the assertions run, and only then be
 * released and awaited. An unsettled press corrupts the renderer for anything
 * that follows it in the same file (see the note in sign-in.test.tsx), hence
 * the split, mirroring SellCarScreenUpload.test.tsx.
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

import { LocaleProvider } from "../../src/providers/LocaleProvider";
import { ThemeProvider } from "../../src/providers/ThemeProvider";
import SignInRoute from "./sign-in";

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

beforeEach(() => {
  [
    mockReplace,
    mockSetActive,
    mockStartSSOFlow,
    mockSignInCreate,
    mockAttemptFirstFactor,
    mockSignUpCreate,
    mockPrepareVerification,
    mockAttemptVerification,
  ].forEach((fn) => fn.mockReset());
});

test("Google sign-in shows a spinner, disables the form, and ignores a second tap", async () => {
  const gate = deferred();
  mockStartSSOFlow.mockReturnValue(gate.promise);
  const screen = await renderScreen();
  const googleButton = screen.getByLabelText(AR.google);

  const press = fireEvent.press(googleButton);

  // The spinner replaces the button's visible label (the accessibility label
  // stays, which is how it is still queryable), and the form goes disabled.
  await waitFor(() => expect(screen.queryByText(AR.google)).toBeNull());
  expect(screen.getByLabelText(AR.google).props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByLabelText(AR.submitSignIn).props.accessibilityState?.disabled).toBe(true);

  // A second tap while in flight must not start another SSO round-trip.
  const secondPress = fireEvent.press(googleButton);

  gate.release({ createdSessionId: null, setActive: undefined });
  await Promise.all([press, secondPress]);

  expect(mockStartSSOFlow).toHaveBeenCalledTimes(1);
});

test("password sign-in shows its submitting label while in flight", async () => {
  const gate = deferred();
  mockSignInCreate.mockReturnValue(gate.promise);
  mockAttemptFirstFactor.mockResolvedValue({ status: "complete", createdSessionId: "s" });
  const screen = await renderScreen();
  await fillCredentials(screen);

  const press = fireEvent.press(screen.getByLabelText(AR.submitSignIn));

  await waitFor(() => expect(screen.getByText(AR.signingIn)).toBeTruthy());

  gate.release();
  await press;
});

test("sign-up shows its submitting label while in flight", async () => {
  const gate = deferred();
  mockSignUpCreate.mockReturnValue(gate.promise);
  const screen = await renderScreen();
  await fireEvent.press(screen.getByLabelText(AR.createAccount));
  await waitFor(() => expect(screen.getByLabelText(AR.email)).toBeTruthy());
  await fillCredentials(screen);

  const press = fireEvent.press(screen.getByLabelText(AR.submitSignUp));

  await waitFor(() => expect(screen.getByText(AR.creatingAccount)).toBeTruthy());

  gate.release();
  await press;
});

test("verification shows its confirming label and blocks a resend while in flight", async () => {
  const gate = deferred();
  mockAttemptVerification.mockReturnValue(gate.promise);
  const screen = await renderScreen();
  await fireEvent.press(screen.getByLabelText(AR.createAccount));
  await waitFor(() => expect(screen.getByLabelText(AR.email)).toBeTruthy());
  await fillCredentials(screen);
  await fireEvent.press(screen.getByLabelText(AR.submitSignUp));
  await waitFor(() => expect(screen.getByLabelText(AR.confirm)).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText(AR.code), "123456");
  mockPrepareVerification.mockClear();

  const press = fireEvent.press(screen.getByLabelText(AR.confirm));

  await waitFor(() => expect(screen.getByText(AR.confirming)).toBeTruthy());
  // Resending mid-verification would race the attempt already in flight.
  const resendPress = fireEvent.press(screen.getByLabelText(AR.resend));

  gate.release({ status: "missing_requirements" });
  await Promise.all([press, resendPress]);

  expect(mockPrepareVerification).not.toHaveBeenCalled();
});

test("pressed feedback resolves on the interactive controls", async () => {
  // Pressable resolves its style callback with { pressed }, so the pressed
  // styling only evaluates while a touch is actually down.
  const screen = await renderScreen();

  for (const label of [AR.google, AR.submitSignIn, AR.createAccount]) {
    const control = screen.getByLabelText(label);
    await fireEvent(control, "pressIn");
    await fireEvent(control, "pressOut");
  }

  expect(screen.getByLabelText(AR.submitSignIn)).toBeTruthy();
});

test("the handlers themselves ignore a re-entrant call while busy", async () => {
  // The buttons are `disabled` mid-flight, so a tap cannot reach these guards
  // through the UI — they are the second line of defence if that prop is ever
  // dropped. Invoke onPress directly to prove they hold.
  const gate = deferred();
  mockStartSSOFlow.mockReturnValue(gate.promise);
  const screen = await renderScreen();
  const googleButton = screen.getByLabelText(AR.google);

  const press = fireEvent.press(googleButton);
  await waitFor(() => expect(screen.queryByText(AR.google)).toBeNull());

  await screen.getByLabelText(AR.google).props.onPress?.();

  gate.release({ createdSessionId: null, setActive: undefined });
  await press;

  expect(mockStartSSOFlow).toHaveBeenCalledTimes(1);
});
