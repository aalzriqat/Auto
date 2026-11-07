import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../components/providers/LanguageProvider";
import { SupplierCreateDialog } from "../components/suppliers/management/SupplierCreateDialog";
import { SupplierDetailScreen } from "../components/suppliers/management/SupplierDetailScreen";
import type { Id } from "../convex/_generated/dataModel";

/** Router-consumer stand-in: a history event reaching it unmounts the editor, just as an App Router route change does. */
function RouteFixture() {
  const [path, setPath] = useState(location.pathname);
  const [open, setOpen] = useState(true);
  const [mode] = useState(() => new URLSearchParams(location.search).get("mode") ?? "edit");
  useEffect(() => {
    history.replaceState(history.state, "", "/suppliers");
    history.pushState(history.state, "", `/suppliers/demo?mode=${mode}`);
    const onPopState = () => setPath(location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mode]);
  if (path === "/suppliers") return <p>Supplier list reached</p>;
  const orgId = "org" as Id<"organizations">;
  return mode === "create" ? <SupplierCreateDialog orgId={orgId} open={open} onOpenChange={setOpen} /> : <SupplierDetailScreen orgId={orgId} supplierId={"supplier" as Id<"suppliers">} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<LanguageProvider><RouteFixture /></LanguageProvider>);
