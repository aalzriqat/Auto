// SCRUM-1005: Bombadil specification for the SIGNED-OUT surface of AutoFlow.
// It sees the rendered page only. It cannot read the ledger or any backend
// state, so nothing here certifies money; see bombadil/README.md.
//
// Only the Bombadil wiring lives here. The rules are in
// scripts/bombadil/surfaceRules.ts and publicRoutes.ts, where unit tests and
// coverage can reach them.
//
// Docs: https://antithesishq.github.io/bombadil/browser/ (specification
// language, defaults, actions). Types: node_modules/@antithesishq/bombadil/dist.
import { always } from "@antithesishq/bombadil";
import { isAction } from "@antithesishq/bombadil/actions";
import {
  actions,
  extract,
  registerCustomAction,
} from "@antithesishq/bombadil/browser";
import {
  clicks,
  forward,
  inputs,
  navigation,
  reload,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";
import { isPublicPagePath } from "../scripts/bombadil/publicRoutes.ts";
import {
  countDealMoneyElements,
  hasBrokenValueText,
  htmlDirectionMatchesLanguage as directionMatchesLanguage,
  isAuthPath,
  leavesSafeArea,
} from "../scripts/bombadil/surfaceRules.ts";

// Protects: a signed-out visitor's browser must not crash on any public page.
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";
// Protects: public pages load without console errors or HTTP error responses.
export {
  noConsoleErrors,
  noHttpErrorCodes,
} from "@antithesishq/bombadil/browser/defaults/properties";

// --- page state read inside the browser on every explored state -------------

const html = extract((state) => ({
  lang: state.document.documentElement.getAttribute("lang") ?? "",
  dir: state.document.documentElement.getAttribute("dir") ?? "",
}));
const pathname = extract((state) => state.window.location.pathname);
const origin = extract((state) => state.window.location.origin);
const onAuthPage = extract((state) =>
  isAuthPath(state.window.location.pathname),
);
const dealMoneyElements = extract((state) =>
  countDealMoneyElements(state.document),
);
// Computed in the page so a long body is not copied into every state.
const brokenValueText = extract((state) =>
  hasBrokenValueText(state.document.body?.innerText ?? ""),
);
// Forward would re-enter a Clerk page that earlier history holds.
const forwardHasAuthEntry = extract((state) =>
  state.navigationHistory.forward.some((entry) =>
    isAuthPath(new URL(entry.url).pathname),
  ),
);

// --- properties --------------------------------------------------------------

// Protects: Arabic is right-to-left and English left-to-right on every screen
// (components/providers/LanguageProvider.tsx).
export const htmlDirectionMatchesLanguage = always(() =>
  directionMatchesLanguage(html.current.lang, html.current.dir),
);
// Protects: deal profit, sale price and commissions are never exposed to a
// visitor who is not signed in (permission rule for the Unified Deal).
export const signedOutVisitorNeverSeesDealMoney = always(
  () => dealMoneyElements.current === 0,
);
// Protects: the public route list of proxy.ts; a signed-out visitor is only ever
// on a public page (protected pages must redirect to sign-in).
export const signedOutVisitorStaysOnPublicRoutes = always(() =>
  isPublicPagePath(pathname.current),
);
// Protects: truthful screens; a missing value must never render as a literal
// "NaN", "undefined" or "[object Object]" where a number or text belongs.
export const noBrokenValueText = always(() => !brokenValueText.current);

// --- actions -----------------------------------------------------------------

const safeClicks = clicks.filter((action) => {
  if (!isAction(action, "Click")) return true;
  const { href, textContent, accessibleName } = action.Click.fingerprint;
  return !leavesSafeArea(
    href,
    `${textContent ?? ""} ${accessibleName ?? ""}`,
    origin.current ?? "",
  );
});
const offAuth = () => !onAuthPage.current;

// On a Clerk page only `back` and the `goHome` escape are allowed; everywhere
// else the safe defaults.
export const exploreClicks = safeClicks.when(offAuth);
export const exploreInputs = inputs.when(offAuth);
export const exploreScroll = scroll.when(offAuth);
export const exploreForward = forward.when(
  () => offAuth() && !forwardHasAuthEntry.current,
);
export const exploreReload = reload.when(offAuth);
export const exploreNavigation = navigation.when(offAuth);
export const exploreWait = waitOnce.when(offAuth);
export { back as exploreBack } from "@antithesishq/bombadil/browser/defaults/actions";

// Calibration run 2026-11-26: after a delayed redirect to /sign-in, `back` alone
// stayed on the Clerk page for the rest of the run (89% of 1704 states). This
// escape leaves the auth page by loading the public home page. Bombadil's
// handler type is Promise<void>, so it returns a resolved promise.
const goHome = registerCustomAction("goHome", (_document, window) => {
  window.location.assign("/");
  return Promise.resolve();
});
export const leaveAuthPage = actions(() => [goHome()]).when(
  () => onAuthPage.current,
);
