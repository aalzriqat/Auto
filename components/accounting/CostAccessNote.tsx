import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  dir?: "ltr" | "rtl" | "auto";
};

export function CostAccessNote({
  children,
  className = "rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200",
  dir,
}: Readonly<Props>) {
  return <output className={className} dir={dir} style={{ display: "block" }}>{children}</output>;
}
