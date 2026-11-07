import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../../components/providers/LanguageProvider";
import { SupplierCreateDialog } from "../../../components/suppliers/management/SupplierCreateDialog";
import { SupplierDetailScreen } from "../../../components/suppliers/management/SupplierDetailScreen";
import type { Id } from "../../../convex/_generated/dataModel";
import { NavigationGuardProvider } from "nextjs-nav-guard";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

/** Router-consumer stand-in: a history event reaching it unmounts the editor, just as an App Router route change does. */
function RouteFixture({ path, setPath }: Readonly<{ path: string; setPath: (path: string) => void }>) {
  const [open, setOpen] = useState(true);
  const [mode] = useState(() => new URLSearchParams(location.search).get("mode") ?? "edit");
  useEffect(() => {
    history.replaceState(history.state, "", "/suppliers");
    history.pushState(history.state, "", `/suppliers/demo?mode=${mode}`);
    const onPopState = () => setPath(location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mode, setPath]);
  if (path === "/suppliers") return <p>Supplier list reached</p>;
  if (path === "/org/suppliers/created" || path === "/org/suppliers/existing") return <p>Supplier statement reached</p>;
  const orgId = "org" as Id<"organizations">;
  return mode === "create" ? <SupplierCreateDialog orgId={orgId} open={open} onOpenChange={setOpen} /> : <SupplierDetailScreen orgId={orgId} supplierId={"supplier" as Id<"suppliers">} />;
}

function RouterFixture() {
  const [path, setPath] = useState(location.pathname);
  const router = useMemo<AppRouterInstance>(() => ({
    bfcacheId: "supplier-navigation-fixture",
    back: () => history.back(), forward: () => history.forward(), refresh: () => undefined, prefetch: () => undefined,
    push: href => { history.pushState(history.state, "", href); setPath(new URL(href, location.href).pathname); },
    replace: href => { history.replaceState(history.state, "", href); setPath(new URL(href, location.href).pathname); },
  }), []);
  return <AppRouterContext.Provider value={router}><NavigationGuardProvider><LanguageProvider><RouteFixture path={path} setPath={setPath} /></LanguageProvider></NavigationGuardProvider></AppRouterContext.Provider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<RouterFixture />);
