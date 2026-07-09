const VISITOR_ID_KEY = "autoflow_visitor_id";
const SESSION_ID_KEY = "autoflow_session_id";

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost). A
// dealer's custom domain can be reached over plain HTTP before its
// certificate is provisioned, so fall back to crypto.getRandomValues (which
// remains available) instead of letting tracking throw. Mirrors
// app/dealer-site/[[...slug]]/page.tsx's randomId().
function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getOrCreateVisitorId(): string {
  if (typeof window === "undefined") return "";
  let visitorId = window.localStorage.getItem(VISITOR_ID_KEY);
  if (!visitorId) {
    visitorId = randomId();
    window.localStorage.setItem(VISITOR_ID_KEY, visitorId);
  }
  return visitorId;
}

export function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  let sessionId = window.sessionStorage.getItem(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = randomId();
    window.sessionStorage.setItem(SESSION_ID_KEY, sessionId);
  }
  return sessionId;
}
