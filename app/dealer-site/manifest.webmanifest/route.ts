import { dealerManifestResponse } from "@/lib/dealerAssets";

export function GET(): Response {
  return dealerManifestResponse();
}
