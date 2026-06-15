import { BranchesClient } from "./client";

export const metadata = {
  title: "Branches | AutoFlow",
  description: "Manage your physical branches",
};

export default function BranchesPage() {
  return <BranchesClient />;
}
