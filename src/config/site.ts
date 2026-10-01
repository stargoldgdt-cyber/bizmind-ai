/**
 * Product-level constants.
 *
 * Anything that describes BizMind as a product — its name, its positioning,
 * its public URLs — lives here so copy is never duplicated across components.
 */

export const siteConfig = {
  name: "BizMind AI",
  shortName: "BizMind",

  /** The one-line promise. Used in the hero and in page metadata. */
  tagline: "Know what every marketplace really pays you.",

  /** The functional description, for search engines and social cards. */
  description:
    "BizMind AI shows Amazon and noon sellers in the GCC their true profit per marketplace, per product and per month, worked out line by line from the marketplaces' own settlement reports.",

  /** The product loop, shown in marketing and used to structure the app. */
  pillars: [
    "Connect",
    "Understand",
    "Analyze",
    "Alert",
    "Recommend",
    "Automate",
  ] as const,
} as const

export type SiteConfig = typeof siteConfig
