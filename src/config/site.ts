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
  tagline: "Your ERP records what happened. BizMind tells you what to do about it.",

  /** The functional description, for search engines and social cards. */
  description:
    "BizMind AI is the intelligence and automation layer for your business. Connect your sales channels, understand your numbers, and know what to do next.",

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
