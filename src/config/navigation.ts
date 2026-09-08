import {
  BarChart3,
  FileSpreadsheet,
  Bell,
  Boxes,
  LayoutDashboard,
  Plug,
  Receipt,
  Settings,
  ShoppingCart,
  Sparkles,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

/**
 * Product navigation.
 *
 * Items marked `phase` are not built yet. They are shown but disabled, rather
 * than hidden, so the shape of the product is visible from day one — and so a
 * click never leads to a broken page. An owner should never wonder whether a
 * feature is missing or they simply cannot find it.
 */
export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** The phase that delivers this. Omitted when the item already works. */
  phase?: number
}

export type NavSection = {
  heading: string
  items: NavItem[]
}

export const NAVIGATION: NavSection[] = [
  {
    heading: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Ask BizMind", href: "/ask", icon: Sparkles, phase: 8 },
      { label: "Alerts", href: "/alerts", icon: Bell, phase: 13 },
    ],
  },
  {
    heading: "Business",
    items: [
      { label: "Sales", href: "/sales", icon: ShoppingCart, phase: 7 },
      { label: "Products", href: "/products", icon: Boxes, phase: 7 },
      { label: "Customers", href: "/customers", icon: Users, phase: 7 },
      { label: "Expenses", href: "/expenses", icon: Receipt, phase: 7 },
      { label: "Profit", href: "/profit", icon: BarChart3, phase: 7 },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Import data", href: "/imports", icon: FileSpreadsheet },
      { label: "Integrations", href: "/integrations", icon: Plug, phase: 9 },
      { label: "Settings", href: "/settings", icon: Settings, phase: 14 },
    ],
  },
]
