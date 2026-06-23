import {
  Target,
  Car,
  Wallet,
  ClipboardList,
  Users,
  Share2,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { NotificationCategory } from "./types";

export const CATEGORY_ICONS: Record<NotificationCategory, LucideIcon> = {
  sales: Target,
  inventory: Car,
  finance: Wallet,
  operations: ClipboardList,
  team: Users,
  social: Share2,
  system: Megaphone,
};
