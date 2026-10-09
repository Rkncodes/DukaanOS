import type { MessageKey } from "../i18n";
import type { IconName } from "./icons";

/**
 * The merchant app's information architecture, in one place. The top bar lists the sections; the sidebar
 * shows the groups of whichever section the current page belongs to. Routes live in router.tsx: every
 * `to` here is a route there.
 */

export type NavItem = {
  to: string;
  /** The item's name in English, and the key of its name in the chosen language. */
  label: string;
  key: MessageKey;
  icon: IconName;
  /** Not built yet: the page says so instead of offering anything. */
  soon?: boolean;
  /** Other paths that belong to this item (it stays highlighted on them). */
  also?: string[];
};
export type NavGroup = { title: string; titleKey: MessageKey; items: NavItem[] };
export type NavSection = { id: string; label: string; key: MessageKey; icon: IconName; to: string; groups: NavGroup[] };

export const SECTIONS: NavSection[] = [
  {
    id: "dashboard",
    label: "Dashboard", key: "nav.dashboard",
    icon: "grid",
    to: "/",
    groups: [
      {
        title: "Dashboard", titleKey: "nav.dashboard",
        items: [
          { to: "/", label: "Overview", key: "nav.overview", icon: "grid" },
          { to: "/insights", label: "Opportunities", key: "nav.opportunities", icon: "sparkle" },
          { to: "/analytics", label: "Analytics", key: "nav.analytics", icon: "chart" },
        ],
      },
    ],
  },
  {
    id: "counter",
    label: "Counter", key: "nav.counter",
    icon: "cart",
    to: "/counter",
    groups: [
      {
        title: "Counter", titleKey: "nav.counter",
        items: [
          { to: "/counter/vision", label: "Vision Counter", key: "nav.visionCounter", icon: "camera", also: ["/counter/photo"] },
          { to: "/counter/barcode", label: "By Code", key: "nav.byCode", icon: "barcode" },
          { to: "/counter/parchi", label: "Parchi", key: "nav.parchi", icon: "note" },
          { to: "/counter/voice", label: "Voice Billing", key: "nav.voiceBilling", icon: "mic" },
          { to: "/counter", label: "Manual Billing", key: "nav.manualBilling", icon: "cart" },
          { to: "/counter/returns", label: "Returns", key: "nav.returns", icon: "return", soon: true },
        ],
      },
      {
        title: "Catalogue", titleKey: "nav.catalogue",
        items: [
          { to: "/catalogue/products", label: "Products", key: "nav.products", icon: "box", also: ["/catalogue"] },
          { to: "/catalogue/categories", label: "Categories", key: "nav.categories", icon: "tag" },
          { to: "/catalogue/stock", label: "Stock", key: "nav.stock", icon: "stack" },
          { to: "/catalogue/offers", label: "Offers", key: "nav.offers", icon: "percent", soon: true },
        ],
      },
    ],
  },
  {
    id: "shop",
    label: "Shop", key: "nav.shop",
    icon: "store",
    to: "/shop/orders",
    groups: [
      {
        title: "Shop", titleKey: "nav.shop",
        items: [
          { to: "/shop/orders", label: "Orders", key: "nav.orders", icon: "clipboard", also: ["/shop"] },
          { to: "/shop/storefront", label: "Storefront", key: "nav.storefront", icon: "store" },
          { to: "/shop/qr", label: "QR", key: "nav.qr", icon: "qr" },
        ],
      },
    ],
  },
  {
    id: "khata",
    label: "Khata", key: "nav.khata",
    icon: "book",
    to: "/khata",
    groups: [
      {
        title: "Khata", titleKey: "nav.khata",
        items: [
          // A customer's own page (/khata/:customerId) sits under Customers.
          { to: "/khata", label: "Customers", key: "nav.customers", icon: "users" },
          { to: "/khata/ledger", label: "Ledger", key: "nav.ledger", icon: "book" },
          { to: "/khata/outstanding", label: "Outstanding", key: "nav.outstanding", icon: "clock" },
          { to: "/khata/payments", label: "Payments", key: "nav.payments", icon: "wallet" },
        ],
      },
    ],
  },
];

/** The Dashboard is home: the logo leads to it, so it has no item of its own among the top bar's sections. */
export const HOME = SECTIONS[0];
export const TOP_BAR_SECTIONS = SECTIONS.filter((section) => section !== HOME);

/** How much of `pathname` the path `base` covers: its length when it is the page or an ancestor, else -1. */
function cover(pathname: string, base: string): number {
  if (base === "/") return pathname === "/" ? 1 : -1;
  return pathname === base || pathname.startsWith(`${base}/`) ? base.length : -1;
}

/** The section and sidebar item a page belongs to: the item whose path covers the most of it. */
export function locate(pathname: string): { section: NavSection; item: NavItem | null } {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: { section: NavSection; item: NavItem | null; score: number } = { section: SECTIONS[0], item: null, score: -1 };
  for (const section of SECTIONS)
    for (const group of section.groups)
      for (const item of group.items) {
        const score = Math.max(...[item.to, ...(item.also ?? [])].map((base) => cover(path, base)));
        if (score > best.score) best = { section, item, score };
      }
  return { section: best.section, item: best.item };
}
