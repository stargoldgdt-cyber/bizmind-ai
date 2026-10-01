import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  FileSpreadsheet,
  Gauge,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  Newspaper,
  Package,
  PieChart,
  Plug,
  Receipt,
  Scale,
  ShieldCheck,
  ShoppingCart,
  Store,
  Sparkles,
  Tags,
  Users,
  Waypoints,
  Workflow,
} from "lucide-react"

/**
 * The product's information architecture.
 *
 * THIS FILE IS THE TARGET SHAPE OF BIZMIND, NOT A LIST OF WHAT SHIPPED.
 *
 * Every page the product intends to have is declared here, in the section and
 * order it will always occupy. `enabled` decides whether an owner can see it
 * yet. Two consequences, both deliberate:
 *
 *   - Shipping a page is a one-word change. The menu never reorganises itself
 *     under a returning user, and no future feature needs the sidebar
 *     redesigned to make room for it.
 *
 *   - The architecture survives in code even while a section is empty. Deleting
 *     "Inventory" because its page is unfinished would lose the decision that
 *     it belongs under Business rather than under Data — and that decision is
 *     worth more than the row.
 *
 * WHY UNBUILT PAGES ARE HIDDEN RATHER THAN GREYED
 * -----------------------------------------------
 * A disabled row is indistinguishable from a broken one. An owner who clicks
 * it and gets nothing learns the menu cannot be relied on, and that lesson
 * transfers to the rows that do work.
 *
 * An earlier version showed "P7", "P8", "P13" beside greyed items. Those codes
 * meant nothing outside this repository, and by the time anyone read them they
 * were wrong in both directions — Alerts was labelled P13 while alerts were
 * already working, and Integrations was greyed out while its page rendered
 * perfectly well. A roadmap leaked into a product surface, and then rotted.
 *
 * THE RULE FOR `enabled: true`
 * ----------------------------
 * All three must hold: the route exists, the page works, and the service
 * behind it is real. Not two of three.
 */

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** Visible to owners. See the rule above before setting this true. */
  enabled: boolean
  /**
   * Sub-paths that keep this item highlighted — `/imports/new` belongs to
   * `/imports`. Without it a wizard step orphans the sidebar.
   */
  match?: string[]
  /** Why it is not enabled yet. For maintainers; never rendered. */
  note?: string
}

export type NavSection = {
  heading: string
  items: NavItem[]
}

export const NAVIGATION: NavSection[] = [
  // Reorganised 2026-09-21 around the marketplace product (owner decision):
  // what the business made, where the money goes, then setup. The legacy
  // spreadsheet-import screens are switched off below until Phase 10 removes
  // them; their pages still answer by URL.
  {
    heading: "Overview",
    items: [
      { label: "Dashboard", href: "/overview", icon: LayoutDashboard, enabled: true },
      // GCC Phase 9: questions answered from verified ledger figures.
      { label: "Ask BizMind", href: "/ledger/ask", icon: Sparkles, enabled: true },
      { label: "Alerts", href: "/alerts", icon: Bell, enabled: true },
      {
        label: "Business brief",
        href: "/brief",
        icon: Newspaper,
        enabled: false,
        note: "Phase 12. The dashboard narrative is the brief's foundation; the daily standalone brief is not built.",
      },
    ],
  },
  {
    heading: "Profit",
    items: [
      // GCC Phase 4: the month statement on the marketplace ledger.
      {
        label: "Marketplace P&L",
        href: "/ledger",
        icon: Scale,
        enabled: true,
        match: ["/ledger/lines"],
      },
      // GCC Phase 6: product profit.
      { label: "Product profit", href: "/ledger/products", icon: Package, enabled: true },
      // GCC Phase 7: operating expenses and net profit.
      { label: "Operating expenses", href: "/ledger/expenses", icon: Receipt, enabled: true },
      // GCC Phase 8: expected marketplace payouts; no bank source yet.
      { label: "Payouts and cashflow", href: "/ledger/payouts", icon: Landmark, enabled: true },
      { label: "Reports", href: "/ledger/reports", icon: FileSpreadsheet, enabled: true },
    ],
  },
  {
    heading: "Products",
    items: [
      // SKU matching lives here since 0045 (/catalog/mapping forwards here).
      {
        label: "Products and costs",
        href: "/catalog",
        icon: Tags,
        enabled: true,
        match: ["/catalog/products", "/catalog/mapping"],
      },
    ],
  },
  {
    heading: "Data",
    items: [
      {
        label: "Import data",
        href: "/imports",
        icon: FileSpreadsheet,
        enabled: true,
        match: ["/imports/new", "/imports/settlement"],
      },
      { label: "Marketplace accounts", href: "/marketplaces", icon: Store, enabled: true },
      { label: "Data quality", href: "/ledger/quality", icon: ShieldCheck, enabled: true },
      { label: "Integrations", href: "/integrations", icon: Plug, enabled: true },
    ],
  },
  {
    heading: "Automation",
    items: [
      { label: "Automations", href: "/automations", icon: Workflow, enabled: true },
      { label: "Activity", href: "/activity", icon: Activity, enabled: true },
    ],
  },
  {
    heading: "Settings",
    items: [
      {
        label: "Business & team",
        href: "/settings",
        icon: Building2,
        enabled: true,
        match: ["/settings/team"],
      },
    ],
  },
  {
    // The legacy model: these read the old orders/products/expenses import,
    // never the marketplace ledger, so a marketplace seller sees them empty.
    // Hidden 2026-09-21 (owner decision); GCC Phase 10 retires them.
    heading: "Legacy",
    items: [
      { label: "Legacy dashboard", href: "/dashboard", icon: Gauge, enabled: false, note: "Legacy model; Phase 10." },
      { label: "Ask BizMind (legacy)", href: "/ask", icon: Sparkles, enabled: false, note: "Legacy model; replaced by /ledger/ask." },
      { label: "Sales", href: "/sales", icon: ShoppingCart, enabled: false, note: "Legacy model; Phase 10." },
      { label: "Products (legacy)", href: "/products", icon: Boxes, enabled: false, note: "Legacy model; replaced by /ledger/products." },
      { label: "Profit (legacy)", href: "/profit", icon: BarChart3, enabled: false, note: "Legacy model; replaced by /ledger." },
      { label: "Business health", href: "/health", icon: Gauge, enabled: false, note: "Legacy model; Phase 10." },
      { label: "Channels", href: "/channels", icon: PieChart, enabled: false, note: "Legacy model; the dashboard compares marketplaces." },
      { label: "Data quality (legacy)", href: "/data-quality", icon: ShieldCheck, enabled: false, note: "Legacy model; replaced by /ledger/quality." },
      {
        label: "Customers",
        href: "/customers",
        icon: Users,
        enabled: false,
        note: "Not built. No customer data is stored for marketplace sellers.",
      },
      {
        label: "Expenses (legacy)",
        href: "/expenses",
        icon: Receipt,
        enabled: false,
        note: "Superseded by Operating expenses (GCC Phase 7).",
      },
      {
        label: "Inventory",
        href: "/inventory",
        icon: Waypoints,
        enabled: false,
        note: "The table exists but nothing keeps stock current. A stale stock figure is worse than none.",
      },
      {
        label: "Recommendations",
        href: "/recommendations",
        icon: Sparkles,
        enabled: false,
        note: "Phase 12. Not built. Must never be an LLM inventing actions from unverified figures.",
      },
    ],
  },
]

/**
 * The sections an owner actually sees.
 *
 * A section whose every item is unbuilt is dropped, so no heading stands over
 * empty space.
 */
export function visibleNavigation(): NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.enabled),
  })).filter((section) => section.items.length > 0)
}

/** Whether a pathname belongs to this item, including its sub-pages. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true
  return (item.match ?? []).some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  )
}
