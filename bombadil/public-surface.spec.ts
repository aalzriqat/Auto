// SCRUM-1005: Bombadil specification for the SIGNED-OUT surface of AutoFlow.
// It sees the rendered page only. It cannot read the ledger or any backend
// state, so nothing here certifies money; see bombadil/README.md.
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
  back,
  clicks,
  forward,
  inputs,
  navigation,
  reload,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";
import { isPublicPagePath, isSameOrigin } from "./publicRoutes.ts";

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
  /^\/sign-(in|up)(\/|$)/.test(state.window.location.pathname),
);

// Deal money elements that only a signed-in, permitted role may ever render.
const DEAL_MONEY_TEST_IDS = [
  "deal-financial-overview",
  "overview-net-profit",
  "overview-sale-price",
  "deal-commissions-row",
];
const dealMoneyElements = extract((state) =>
  DEAL_MONEY_TEST_IDS.reduce(
    (count, id) =>
      count + state.document.querySelectorAll(`[data-testid="${id}"]`).length,
    0,
  ),
);

// Computed in the page so a long body is not copied into every state.
const hasBrokenValueText = extract((state) =>
  /(^|[^\w])(NaN|undefined)([^\w]|$)|\[object Object\]/.test(
    state.document.body?.innerText ?? "",
  ),
);

// --- properties --------------------------------------------------------------

// Protects: Arabic is right-to-left and English left-to-right on every screen
// (components/providers/LanguageProvider.tsx), so the language toggle never
// leaves a mirrored or unmirrored layout behind.
export const htmlDirectionMatchesLanguage = always(() => {
  const { lang, dir } = html.current;
  return (
    (lang === "ar" || lang === "en") && dir === (lang === "ar" ? "rtl" : "ltr")
  );
});

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
export const noBrokenValueText = always(() => !hasBrokenValueText.current);

// --- actions -----------------------------------------------------------------

// Clerk's sign-in and sign-up reject random input with 4xx by design and could
// rate-limit the test instance, so the explorer never goes there or off-origin.
const AUTH_LINK = /\/sign-(in|up)(\/|\?|#|$)/;
const AUTH_LABEL = /\b(sign[ -]?(in|up)|log[ -]?in|get started)\b/i;

function leavesSafeArea(href: string | null, label: string): boolean {
  if (AUTH_LABEL.test(label)) return true;
  if (href === null) return false;
  if (AUTH_LINK.test(href)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return !isSameOrigin(href, origin.current ?? "") && !href.startsWith("#");
  }
  return false;
}

const safeClicks = clicks.filter((action) => {
  if (!isAction(action, "Click")) return true;
  const { href, textContent, accessibleName } = action.Click.fingerprint;
  return !leavesSafeArea(href, `${textContent ?? ""} ${accessibleName ?? ""}`);
});

const offAuth = () => !onAuthPage.current;

// Forward would re-enter a Clerk page that earlier history holds; refuse it then.
const forwardHasAuthEntry = extract((state) =>
  state.navigationHistory.forward.some((entry) =>
    /\/sign-(in|up)(\/|\?|#|$)/.test(new URL(entry.url).pathname),
  ),
);

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
export const exploreBack = back;

// Calibration run 2026-11-26: after a delayed redirect to /sign-in, `back` alone
// stayed on the Clerk page for the rest of the run (89% of 1704 states). This
// escape leaves the auth page by loading the public home page.
const goHome = registerCustomAction("goHome", async (_document, window) => {
  window.location.assign("/");
});
export const leaveAuthPage = actions(() => [goHome()]).when(
  () => onAuthPage.current,
);
