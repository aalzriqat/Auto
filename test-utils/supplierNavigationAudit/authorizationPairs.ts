import { tenantMembershipPairs } from "./tenantMembershipPairs";
import { impersonationPairs } from "./impersonationPairs";
import { ownerPermissionPairs } from "./ownerPermissionPairs";
import { identityAndOwnershipPairs } from "./identityAndOwnershipPairs";
import { subscriptionPairs } from "./subscriptionPairs";

export const AUTH_CONDITION_PAIRS: readonly (readonly [condition: string, pairs: readonly (readonly [string, string])[]])[] = [
  ...tenantMembershipPairs,
  ...impersonationPairs,
  ...ownerPermissionPairs,
  ...identityAndOwnershipPairs,
  ...subscriptionPairs,
];
