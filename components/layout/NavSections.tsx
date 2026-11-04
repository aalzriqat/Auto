"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { ChevronDown } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { cn } from "@/lib/utils";
import {
  isNavPathActive,
  visibleFooterNavItems,
  visibleNavGroups,
  type NavItem,
  type VisibleNavGroup,
} from "@/lib/navigation";

/**
 * The grouped navigation shared by the desktop sidebar and the mobile drawer
 * (SCRUM-890). Both surfaces render this one component, so they cannot drift
 * apart in what they show.
 *
 * - Section captions are fixed headings; only Settings collapses, as a WAI-ARIA
 *   APG disclosure (a button with aria-expanded controlling a list).
 * - Logical properties only, so the layout mirrors for Arabic (RTL).
 * - Captions use no uppercase and no letter-spacing: both break Arabic joining
 *   (W3C Arabic Layout Requirements).
 */

export type NavDensity = "desktop" | "drawer";

/** localStorage key remembering whether the user left Settings open ("1") or closed ("0"). */
export const SETTINGS_DISCLOSURE_KEY = "autoflow:nav:settings-open";

function readStoredDisclosure(): boolean | null {
  try {
    const stored = localStorage.getItem(SETTINGS_DISCLOSURE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage can be blocked or throw (private windows, site data off); the
    // default behaviour still works without it.
  }
  return null;
}

function storeDisclosure(open: boolean): void {
  try {
    localStorage.setItem(SETTINGS_DISCLOSURE_KEY, open ? "1" : "0");
  } catch {
    // See readStoredDisclosure.
  }
}

const ROW_HEIGHT: Record<NavDensity, string> = { desktop: "h-9", drawer: "h-11" };

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

interface NavRowProps {
  item: NavItem;
  orgId: string;
  pathname: string;
  density: NavDensity;
  badge?: number | null;
  onNavigate?: () => void;
}

function NavRow({ item, orgId, pathname, density, badge, onNavigate }: NavRowProps) {
  const { t } = useLanguage();
  const active = isNavPathActive(pathname, `/${orgId}${item.href}`);
  return (
    <li>
      <Link
        href={`/${orgId}${item.href}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
          ROW_HEIGHT[density],
          FOCUS_RING,
          active ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        )}
      >
        <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-slate-500")} aria-hidden="true" />
        <span className="flex-1 truncate">{t(item.name)}</span>
        {badge != null && badge > 0 && (
          <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
}

interface NavSectionProps extends Omit<NavRowProps, "item" | "badge"> {
  section: VisibleNavGroup;
  badges?: Readonly<Record<string, number | null | undefined>>;
}

function NavSection({ section, orgId, pathname, density, badges, onNavigate }: NavSectionProps) {
  const { t } = useLanguage();
  const captionId = useId();
  const listId = useId();
  const { group, items } = section;
  const hasActive = items.some((item) => isNavPathActive(pathname, `/${orgId}${item.href}`));
  // A section with a single visible item (a manager sees only Team) has nothing
  // worth hiding, so it renders as a plain captioned list.
  const collapsible = group.collapsible === true && items.length > 1;
  // Starting from the route keeps server and client markup identical and avoids
  // a flash of the closed state on a Settings page.
  const [open, setOpen] = useState(hasActive);

  useEffect(() => {
    if (!collapsible) return;
    const stored = readStoredDisclosure();
    // The user's own choice wins, except that landing inside the section opens it.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- storage is client-only, so it can only be read after mount
    if (stored !== null) setOpen(stored || hasActive);
    // Mount-only on purpose: later route changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsible]);

  useEffect(() => {
    // Navigating into the section (a link, the command search) reveals the current page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (collapsible && hasActive) setOpen(true);
  }, [collapsible, hasActive]);

  const caption = group.captionKey ? t(group.captionKey) : null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    storeDisclosure(next);
  };

  return (
    <div className={cn(caption && "mt-3")}>
      {caption && !collapsible && (
        <p id={captionId} className="px-3 pb-1 text-xs font-semibold text-slate-500">
          {caption}
        </p>
      )}
      {caption && collapsible && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-lg px-3 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900",
            ROW_HEIGHT[density],
            FOCUS_RING
          )}
        >
          <span id={captionId}>{caption}</span>
          <span className="flex items-center gap-2">
            {!open && hasActive && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
            <ChevronDown
              className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")}
              aria-hidden="true"
            />
          </span>
        </button>
      )}
      {/* `hidden` (not unmounting) keeps the links in the document for tests and
          audits while taking them out of the tab order and the accessibility tree. */}
      <ul
        id={listId}
        aria-labelledby={caption ? captionId : undefined}
        hidden={collapsible && !open}
        className="flex flex-col gap-0.5"
      >
        {items.map((item) => (
          <NavRow
            key={item.name}
            item={item}
            orgId={orgId}
            pathname={pathname}
            density={density}
            badge={badges?.[item.name]}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </div>
  );
}

interface NavSectionsProps {
  permissions: readonly string[];
  isOwner: boolean;
  density: NavDensity;
  /** Count badges by nav item name (Approvals); the caller owns who may see which count. */
  badges?: Readonly<Record<string, number | null | undefined>>;
  /** Called after a link is chosen, so the drawer can close. */
  onNavigate?: () => void;
}

export function NavSections({ permissions, isOwner, density, badges, onNavigate }: NavSectionsProps) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // On a long list (a phone drawer, a short laptop screen) bring the current
    // page into view instead of leaving it below the fold.
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest" });
  }, [pathname]);

  if (!activeOrgId) return null;
  const sections = visibleNavGroups(permissions, isOwner);
  return (
    <nav ref={navRef} aria-label={t("NavMainLabel")}>
      {sections.map((section) => (
        <NavSection
          key={section.group.id}
          section={section}
          orgId={activeOrgId}
          pathname={pathname}
          density={density}
          badges={badges}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

interface PlanCardProps {
  permissions: readonly string[];
  isOwner: boolean;
  density: NavDensity;
  onNavigate?: () => void;
}

/**
 * The owner's plan card: the one entry to Billing (it is no longer a list row).
 * Renders for whoever may see the footer Billing item, the same OWNER gate as before.
 */
export function PlanCard({ permissions, isOwner, density, onNavigate }: PlanCardProps) {
  const { t, isRtl } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const billing = visibleFooterNavItems(permissions, isOwner)[0];
  const subscription = useQuery(
    api.subscriptions.getMySubscription,
    activeOrgId && billing ? { orgId: activeOrgId } : "skip"
  );
  if (!activeOrgId || !billing) return null;
  const href = `/${activeOrgId}${billing.href}`;
  const active = isNavPathActive(pathname, href);
  return (
    <div data-nav-surface="plan-card">
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block rounded-xl border border-slate-100 bg-slate-50 p-4 transition-colors hover:bg-slate-100",
          density === "drawer" && "min-h-11",
          FOCUS_RING,
          active && "border-primary/30 bg-primary/10"
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-slate-600">{t("AutoFlowPro")}</p>
          <Badge variant="secondary" className="h-4 px-2 py-0 text-[10px] font-semibold">
            {(isRtl ? subscription?.planDetails?.nameAr : subscription?.planDetails?.name) ?? (isRtl ? "مجاني" : "Free")}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-slate-500">{t("BillingManagePlan")}</p>
      </Link>
    </div>
  );
}
