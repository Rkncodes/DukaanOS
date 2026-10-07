import type { IconName } from "./icons";

/**
 * The merchant app's information architecture, in one place. The top bar lists the sections; the sidebar
 * shows the groups of whichever section the current page belongs to. Routes live in router.tsx: every
 * `to` here is a route there.
 */

export type NavItem = {
  to: string;
  label: string;
  icon: IconName;
  /** Not built yet: the page says so instead of offering anything. */
  soon?: boolean;
  /** Other paths that belong to this item (it stays highlighted on them). */
  also?: string[];
};
export type NavGroup = { title: string; items: NavItem[] };
export type NavSection = { id: string; label: string; icon: IconName; to: string; groups: NavGroup[] };

export const SECTIONS: NavSection[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "grid",
    to: "/",
    groups: [{ title: "Dashboard", items: [{ to: "/", label: "Overview", icon: "grid" }] }],
  },
  {
    id: "counter",
    label: "Counter",
    icon: "cart",
    to: "/counter",
    groups: [
      {
        title: "Counter",
        items: [
          { to: "/counter/vision", label: "Vision Counter", icon: "camera", also: ["/counter/photo"] },
          { to: "/counter/barcode", label: "By Code", icon: "barcode" },
          { to: "/counter/parchi", label: "Parchi", icon: "note" },
          { to: "/counter/voice", label: "Voice Billing", icon: "mic" },
          { to: "/counter", label: "Manual Billing", icon: "cart" },
          { to: "/counter/returns", label: "Returns", icon: "return", soon: true },
        ],
      },
      {
        title: "Catalogue",
        items: [
          { to: "/catalogue/products", label: "Products", icon: "box", also: ["/catalogue"] },
          { to: "/catalogue/categories", label: "Categories", icon: "tag" },
          { to: "/catalogue/stock", label: "Stock", icon: "stack" },
          { to: "/catalogue/offers", label: "Offers", icon: "percent", soon: true },
        ],
      },
    ],
  },
  {
    id: "shop",
    label: "Shop",
    icon: "store",
    to: "/shop/orders",
    groups: [
      {
        title: "Shop",
        items: [
          { to: "/shop/orders", label: "Orders", icon: "clipboard", also: ["/shop"] },
          { to: "/shop/storefront", label: "Storefront", icon: "store" },
          { to: "/shop/qr", label: "QR", icon: "qr" },
        ],
      },
    ],
  },
  {
    id: "khata",
    label: "Khata",
    icon: "book",
    to: "/khata",
    groups: [
      {
        title: "Khata",
        items: [
          // A customer's own page (/khata/:customerId) sits under Customers.
          { to: "/khata", label: "Customers", icon: "users" },
          { to: "/khata/ledger", label: "Ledger", icon: "book" },
          { to: "/khata/outstanding", label: "Outstanding", icon: "clock" },
          { to: "/khata/payments", label: "Payments", icon: "wallet" },
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
