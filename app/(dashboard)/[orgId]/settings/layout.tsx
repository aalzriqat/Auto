"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RoleGuard ownerOnly>
      {children}
    </RoleGuard>
  );
}
