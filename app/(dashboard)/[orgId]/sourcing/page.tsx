import { Suspense } from "react";
import { SourcingClient } from "./client";

export default function SourcingPage() {
  return (
    <Suspense>
      <SourcingClient />
    </Suspense>
  );
}
