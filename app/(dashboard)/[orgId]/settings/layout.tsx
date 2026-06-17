"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RoleGuard permissions={["view:settings"]}>
      {children}
    </RoleGuard>
  );
}
