import { RoleGuard } from "@/components/auth/RoleGuard";
import { DealCockpitClient } from "./client";

export const metadata = {
  title: "Finance deal | AutoFlow",
  description: "Track a financed deal end to end",
};

/**
 * Guarded on `view:sales`, matching the applications list this drills into.
 *
 * The money panel needs `view:finance` on top of that, and is withheld by the
 * server rather than by this guard — a salesperson can follow their own deal's
 * progress without seeing what the dealership makes on it, and a guard here
 * could only choose between the whole screen and none of it.
 */
export default function DealCockpitPage() {
  return (
    <RoleGuard permissions={["view:sales"]}>
      <DealCockpitClient />
    </RoleGuard>
  );
}
