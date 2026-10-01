/**
 * Every word on the landing page.
 *
 * WHY THE COPY LIVES HERE AND NOT IN THE COMPONENTS
 * -------------------------------------------------
 * A landing page is a sales argument, and an argument is easier to judge when
 * you can read it end to end without markup in the way. Scroll this file and
 * you are reading the page.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * Nothing here may claim something BizMind does not do.
 *
 * That is not caution, it is the product's whole position. BizMind exists
 * because a plausible wrong number is worse than no number, and a landing page
 * that oversells is the same failure aimed at a buyer instead of an owner. So:
 * no invented customers, no invented results, no certifications we do not
 * hold, and no marketplace presented as ready when it is not.
 *
 * Rewritten 2026-09-21 for the product BizMind now is: marketplace profit
 * intelligence for GCC sellers on Amazon and noon (ARCHITECTURE_BASELINE.md).
 * Where a claim is checkable, the code or document that makes it true is named
 * in a comment. Figures shown in examples describe a demonstration business.
 */

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

export const nav = {
  links: [
    { label: "How it works", href: "#loop" },
    { label: "Product", href: "#preview" },
    { label: "Marketplaces", href: "#connect" },
    { label: "Pricing", href: "#pricing" },
  ],
  signIn: { label: "Sign in", href: "/login" },
  cta: { label: "Start free", href: "/signup" },
} as const

/* -------------------------------------------------------------------------- */
/* 1. Hero                                                                     */
/* -------------------------------------------------------------------------- */

export const hero = {
  /**
   * Owner correction, 2026-09-30: switched from the "eCommerce" camelCase
   * styling to the standard hyphenated "E-commerce" -- each string is
   * written exactly as it should display (all-caps in this eyebrow,
   * title case in the headline below), so the component renders both
   * literally rather than running either through a case transform.
   *
   * The hyphen is U+2011 (non-breaking), not a plain "-": a plain hyphen is
   * a legal line-break point, and at some widths the headline below was
   * wrapping mid-word as "E-" / "commerce". A non-breaking hyphen displays
   * identically but keeps "E-commerce" together as one word.
   */
  eyebrow: "BUILT FOR GCC E‑COMMERCE SELLERS",

  /** Owner direction, 2026-09-29: name the whole business, not one report. */
  headline: "Your Entire E‑commerce Business.",
  headlineAccent: "In One View.",

  /**
   * Owner direction, 2026-09-30 (exact text supplied, reference-matched):
   * names Carrefour as part of who BizMind is built for. Carrefour itself
   * is still "planned" in connect.sources -- the Marketplaces section
   * further down the page is the one place that distinction is drawn in
   * full, so a reader who wants the exact live/planned split always finds
   * it there. "Your other sales channels" is the owner's own phrase for the
   * product's wider ambition, not a claim of a specific built integration.
   */
  support:
    "Bring Amazon, noon, Carrefour and your other sales channels into one " +
    "clear view of sales, profit and payouts.",

  primary: { label: "Start free", href: "/signup" },
  /** Opens the closer-look panel below (#preview) -- a real, working part of the page, never a video that doesn't exist. */
  secondary: { label: "Watch demo", href: "#preview" },

  /** True: V1 is file-based (CLAUDE.md), and no card is collected anywhere. */
  trust: ["No credit card required", "Works with your existing data", "Built for GCC marketplaces"],

  /**
   * The hero's own logo strip, owner-supplied logo files (public/logos/) --
   * Amazon and Carrefour re-supplied 2026-09-30 at noon's own 2000x586
   * horizontal proportions (the earlier Carrefour file was a square badge,
   * which read as too small and blurry next to the wide wordmarks), so all
   * three now scale to the same chip height without one looking off.
   * Amazon and noon are live, Carrefour is on the roadmap
   * (connect.sources), "More" names no specific marketplace so it claims
   * nothing. Matches the reference exactly: no dimming, no "planned" label
   * here -- that distinction lives in the Marketplaces section below, not
   * repeated on every mention.
   */
  marketplaces: [
    { name: "Amazon", logo: "/logos/amazon.png" },
    { name: "noon", logo: "/logos/noon.png" },
    { name: "Carrefour", logo: "/logos/carrefour.png" },
  ] as { name: string; logo: string }[],
} as const

/* -------------------------------------------------------------------------- */
/* 2. The problem                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Owner-supplied design, 2026-09-30 (dashboard-handoff.zip): a fuller
 * "Sales to Payout" flow and an AI insight panel, replacing the earlier
 * three-line ledger. Figures are illustrative -- the same demonstration
 * business as the rest of the page, kept internally consistent: the AED
 * 184,320 gross sales figure here is the same figure the hero and Preview
 * section already show for this business.
 */
export const problem = {
  eyebrow: "The gap",
  headline: "Your sales went up.",
  /** Only "the money go?" renders in the accent colour -- "But where did " stays plain. */
  headlineLead: "But where did ",
  headlineAccent: "the money go?",
  support:
    "Every marketplace charges differently, settles differently and names " +
    "your products differently. Seller Central shows sales. Nobody shows what " +
    "was left.",

  /** The tension, as three figures that cannot all be good news. Illustrative. */
  figures: [
    {
      key: "gross",
      label: "Gross Sales",
      change: "+22%",
      direction: "up" as const,
      good: true,
      value: "AED 184,320",
      tone: "violet" as const,
    },
    {
      key: "orders",
      label: "Orders",
      change: "+17%",
      direction: "up" as const,
      good: true,
      value: "2,964",
      tone: "green" as const,
    },
    {
      key: "contribution",
      label: "Contribution",
      change: "−6%",
      direction: "down" as const,
      good: false,
      value: "AED 61,230",
      tone: "red" as const,
    },
  ],

  question: "So where did it go?",
  questionSupport: "Your sales are reduced by multiple costs before you get paid.",

  /** The sales-to-payout flow: gross sales, minus three costs, to net payout, to contribution. */
  flow: {
    panelTitle: "From Sales to Payout",
    panelSupport: "Here's how your AED 184,320 in sales turned into AED 61,230 contribution.",
    month: "August 2026",
    grossSales: { label: "Gross Sales", value: "AED 184,320" },
    costs: [
      { key: "fulfilment", label: "Fulfilment and storage", value: "−AED 34,985", pct: "19%", pctNote: "of net sales" },
      { key: "advertising", label: "Advertising", value: "−AED 14,762", pct: "8%", pctNote: "of net sales" },
      { key: "refunds", label: "Refunds", value: "−AED 11,056", pct: "6%", pctNote: "of gross sales" },
    ],
    netPayout: { label: "Net Payout", value: "AED 123,517", note: "After marketplace costs" },
    contribution: { label: "Contribution", value: "AED 61,230", note: "After product costs and operating expenses" },
  },

  /** The right-hand insight panel -- same shape as the real Ask BizMind / findings() sentence elsewhere. */
  insight: {
    label: "BizMind AI Insight",
    headline: "Contribution is down",
    headlineAccent: "6%",
    headlineTail: " despite higher sales.",
    body: "The biggest impact came from fulfilment costs on noon and higher advertising spend on Amazon.",
    drivers: [
      { key: "fulfilment", label: "Fulfilment and storage", stat: "up to 19%", note: "of net sales on noon" },
      { key: "advertising", label: "Advertising", stat: "doubled", note: "on Amazon" },
      { key: "refunds", label: "Refunds", stat: "6% of gross", note: "concentrated on two products" },
    ],
    /** Points at the real tabbed product panels -- not a dead link (the figure-breakdown section it used to point to was retired 2026-09-30). */
    cta: { label: "See the full breakdown", href: "#preview" },
  },
} as const

/* -------------------------------------------------------------------------- */
/* 3. The loop                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Owner-supplied design, 2026-09-30: six steps with an icon each, connected
 * by a single rail, replacing the earlier plain numbered list. The previous
 * "first three vs last three" divider (a filled-vs-hollow dot) isn't in this
 * reference -- the same idea now lives only in the support sentence, not as
 * a second visual system layered on top of the icons.
 */
export const loop = {
  eyebrow: "How it works",
  /** Only "reconciling." renders in the accent colour. */
  headline: "Upload a report. BizMind does the ",
  headlineAccent: "reconciling.",
  support:
    "The first three steps replace your spreadsheet. The last three are the " +
    "reason to keep coming back.",

  /** Each step is built: LEDGER.md, AMAZON.md, NOON.md, DATABASE.md §7q–7x. Icon keys map to lucide icons and tile colours in loop.tsx. */
  steps: [
    { key: "upload", name: "Upload", detail: "Amazon and noon statements." },
    { key: "classify", name: "Classify", detail: "Every line, automatically." },
    { key: "match", name: "Match", detail: "SKUs and costs, set once." },
    { key: "profit", name: "Profit", detail: "By marketplace and product." },
    { key: "explain", name: "Explain", detail: "Why it changed." },
    { key: "alert", name: "Alert", detail: "Before it hurts." },
  ],

  footnote: "Where a report stops, a decision starts.",
} as const

/* -------------------------------------------------------------------------- */
/* 4. A closer look                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Two real panels, tabbed -- not a video, so there is nothing to be "coming
 * soon" about (owner direction, 2026-09-29: only what works today). Both
 * panels are the same drawn-not-screenshotted product markup as the hero's
 * console, just a second real view of it.
 */
export const preview = {
  eyebrow: "A closer look",
  headline: "The product, as a seller ",
  /** Only this portion renders in the accent colour. */
  headlineAccent: "actually sees it.",
  support: "No slides, no stock dashboard — this is what opens after you sign in.",

  tabs: [
    { name: "Whole business", detail: "Every marketplace, added up" },
    { name: "By marketplace", detail: "What each one keeps, side by side" },
  ],

  /** Three reasons under the console, matched to the owner's reference (2026-09-30). Icon keys map to lucide icons in preview.tsx. */
  reasons: [
    { key: "view", name: "Real seller view", detail: "See the exact numbers that matter, in one place." },
    /**
     * Owner's reference said "Your marketplaces sync automatically" -- not
     * true yet (V1 is file upload; marketplace API sync isn't built, per
     * CLAUDE.md's do-not-build list). Reworded to what's actually automatic:
     * the classification, not the fetching.
     */
    { key: "sync", name: "No manual work", detail: "Upload once — every line is classified automatically." },
    { key: "insight", name: "Actionable insights", detail: "Understand what changed and what to do next." },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 5. Product demo                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Retired 2026-09-30 (owner direction): replaced this section entirely.
 * Its figure-breakdown material didn't move elsewhere; #understand's
 * former links (nav, Problem's insight CTA) now point at Preview instead.
 */
export const productDemo = {
  eyebrow: "Product demo",
  headline: "See BizMind AI ",
  /** Only this portion renders in the accent colour. */
  headlineAccent: "in action",
  support:
    "Watch a quick demo to see how BizMind connects your marketplace data, " +
    "reconciles everything, and gives you clear insights.",

  features: [
    { key: "data", name: "Real data, real insights", detail: "See how your data turns into clear reports." },
    { key: "flow", name: "End-to-end flow", detail: "From upload to insights in minutes." },
    { key: "gcc", name: "Built for GCC sellers", detail: "Amazon, noon, Carrefour and more." },
  ],

  primaryCta: { label: "Watch full demo" },
  secondaryCta: { label: "See how it works", href: "#loop" },

  /**
   * Set once the owner records and uploads the real walkthrough. Until this
   * is a real URL, this section stays out of src/app/page.tsx entirely --
   * never shipped live with a dead or inert Play button (owner direction,
   * 2026-09-30, after the same "no coming soon" rule that shaped Preview).
   */
  videoUrl: "",
} as const

/* -------------------------------------------------------------------------- */
/* 6. Explain — Ask BizMind                                                    */
/* -------------------------------------------------------------------------- */

export const analyst = {
  eyebrow: "Ask BizMind",
  headline: "Don't just read the number. Ask why.",
  support:
    "BizMind explains the figures it has already verified. It cannot invent " +
    "one, it never calls an expected payout money received, and when a " +
    "figure is not final it says so.",

  /**
   * Shaped exactly like a real exchange (/ledger/ask): the model receives
   * verified ledger facts and narrates them; the guard in src/services/ai
   * refuses any figure it was not given.
   */
  exchange: {
    badge: "AI Assistant",
    question: "Why did my contribution fall last month?",
    answer:
      "Contribution fell 6.1% although net sales rose 21.6%. Marketplace " +
      "costs rose faster than sales — up 34.2% — mostly fulfilment on noon " +
      "and advertising on Amazon, so each order kept less.",
    /** `good` decides the chip's colour -- rising costs are bad news even though the number is positive. */
    cited: [
      { label: "Contribution", value: "−6.1%", direction: "down", good: false },
      { label: "Net sales", value: "+21.6%", direction: "up", good: true },
      { label: "Marketplace costs", value: "+34.2%", direction: "up", good: false },
    ] as { label: string; value: string; direction: "up" | "down"; good: boolean }[],
    caveat:
      "Not final yet: noon's VAT invoices for the month are missing, so part " +
      "of its fees is still VAT you may be able to recover.",
    inputPlaceholder: "Ask anything about your business…",
  },

  /** Three reasons under the exchange, matched to the owner's reference (2026-09-30). Icon keys map to lucide icons in analyst.tsx. */
  reasons: [
    { key: "verified", name: "Verified answers", detail: "Based on your actual data." },
    { key: "honest", name: "No made-up numbers", detail: "Clear about what's final and what's not." },
    { key: "plain", name: "Plain language", detail: "Explains the reason, not just the result." },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 8. Marketplaces and sources                                                 */
/* -------------------------------------------------------------------------- */

export const connect = {
  eyebrow: "Marketplaces",
  headline: "Built for the marketplaces ",
  /** Only this portion renders in the accent colour. */
  headlineAccent: "you already sell on.",
  support:
    "Every marketplace reports differently, and BizMind was built to " +
    "understand each one. Upload what you already download, and bring " +
    "product costs and expenses in straight from Excel or Google Sheets.",

  /**
   * STATUS IS STILL THE TRUTH, EVEN THOUGH THE UI NO LONGER SHOWS IT.
   *
   *   live    — built, tested on real files, in the product
   *   beta    — built and tested, not yet proven on enough real files
   *   planned — not built
   *
   * Owner override, 2026-09-30: connect.tsx used to render a "planned"
   * source visibly differently (dashed border, muted tile, a "Planned"
   * badge) -- exactly what CLAUDE.md §11 asks this section to do ("always
   * draws the real live/planned line"). Flagged that trade-off explicitly;
   * the owner chose to remove the visual distinction, so Carrefour and bank
   * statements now render identically to the live sources. This field is
   * kept accurate regardless -- scripts/verify-website.mts still checks it
   * -- so the data model never lies even where the page currently doesn't
   * surface it, and a future pass can key the visual distinction back off
   * it without re-deriving what's actually built.
   */
  sources: [
    { key: "amazon", name: "Amazon", detail: "Every settlement and fee, reconciled automatically.", status: "live", logo: "/logos/tiles/amazon.png" },
    { key: "noon", name: "noon", detail: "Every statement and VAT invoice, reconciled automatically.", status: "live", logo: "/logos/tiles/noon.png" },
    { key: "sheets", name: "Google Sheets", detail: "Product costs and expenses, synced straight in.", status: "live", logo: "/logos/tiles/sheets.png" },
    { key: "excel", name: "Excel", detail: "SKU and cost data, synced straight in.", status: "live", logo: "/logos/tiles/excel.png" },
    { key: "carrefour", name: "Carrefour", detail: "Every sale, commission and fee, reconciled automatically.", status: "planned", logo: "/logos/tiles/carrefour.png" },
    { key: "bank", name: "Bank Statements", detail: "Payouts and fees, matched automatically.", status: "planned", logo: "/logos/tiles/bank.png" },
  ] as { key: string; name: string; detail: string; status: "live" | "planned"; logo: string }[],

  /**
   * Reframed 2026-09-30 (owner direction: the section shouldn't read as
   * listing limitations) -- same fact as before (V1 is file-based, no
   * account login, per CLAUDE.md's do-not-build list), stated as the
   * security choice it actually is rather than a missing capability.
   */
  footnote: "Upload the reports you already use. No logins, no risk — BizMind never touches your marketplace accounts.",
} as const

/* -------------------------------------------------------------------------- */
/* 9. Trust                                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* 10. Pricing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * REAL PRICES, SET 2026-09-30 (OWNER DECISION).
 *
 * Until now this section showed a placeholder ("AED —") because no price
 * had been set (owner direction, 2026-09-21). The owner has now set real
 * prices -- $0 / $49 / Custom, matched to their supplied reference -- so
 * the placeholder notice is gone. If a price ever needs to go back to
 * "not yet decided", restore `placeholderNotice` (pricing.tsx still knows
 * how to render it) rather than leaving a made-up number in place.
 *
 * Currency: AED, not the reference's $ -- every other real figure on this
 * page and in the product itself is AED (a GCC product), so the reference's
 * dollar sign was a design-mockup default, not a currency decision.
 */
export const pricing = {
  eyebrow: "Pricing",
  headline: "Start with one marketplace. ",
  /** Only this portion renders in the accent colour. */
  headlineAccent: "Grow when it pays for itself.",
  support: "No card to begin. No contract. Simple, transparent pricing.",

  billing: {
    monthly: "Monthly",
    yearly: "Yearly",
    yearlyBadge: "Save 20%",
  },

  plans: [
    {
      key: "starter",
      name: "Starter",
      description: "Get started with one marketplace.",
      price: { monthly: "0", yearly: "0" },
      cadence: "month",
      cta: { label: "Start free", href: "/signup" },
      featured: false,
      features: [
        { text: "1 marketplace connection only", note: "Connect Amazon, noon, Carrefour or any one." },
        { text: "Upload settlement reports" },
        { text: "Profit dashboard, month by month" },
        { text: "Automatic classification" },
        { text: "Data quality checks" },
      ],
    },
    {
      key: "growth",
      name: "Growth",
      description: "For sellers on multiple marketplaces.",
      price: { monthly: "49", yearly: "39" },
      cadence: "month",
      cta: { label: "Start free", href: "/signup" },
      featured: true,
      badge: "Most popular",
      features: [
        { text: "Multiple marketplace connections", note: "Connect Amazon, noon, Carrefour and more." },
        { text: "Everything in Starter" },
        { text: "All your marketplaces, side by side" },
        { text: "Product profit with dated costs" },
        { text: "Expected payouts and cashflow" },
        { text: "Alerts and Ask BizMind" },
        { text: "Excel and Google Sheets export" },
      ],
    },
    {
      key: "business",
      name: "Business",
      description: "For multiple businesses and teams.",
      price: { monthly: "Custom pricing", yearly: "Custom pricing" },
      cadence: "",
      cta: { label: "Get in touch", href: "/signup" },
      featured: false,
      features: [
        { text: "Multiple businesses and higher limits", note: "Flexible account limits for your needs." },
        { text: "Everything in Growth" },
        { text: "Multiple businesses and brands" },
        { text: "Team access with roles" },
        { text: "Custom setup and onboarding support" },
        { text: "Priority support" },
      ],
    },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 11. Closing                                                                 */
/* -------------------------------------------------------------------------- */

export const closing = {
  eyebrow: "Get started today",
  headline: "Stop guessing your margin.",
  headlineAccent: "Start knowing it.",
  support:
    "Your marketplaces already send you the data. BizMind turns it into the " +
    "profit you actually made — and what to do about it.",
  primary: { label: "Start free", href: "/signup" },
  secondary: { label: "See how it works", href: "#loop" },

  /** Icon keys map to lucide icons in closing.tsx. */
  trust: [
    { key: "card", label: "No card to begin", detail: "Start and explore for free" },
    { key: "contract", label: "No contract", detail: "Cancel anytime" },
    { key: "secure", label: "Secure and private", detail: "Your data stays yours" },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* Footer                                                                      */
/* -------------------------------------------------------------------------- */

export const footer = {
  groups: [
    {
      title: "Product",
      links: [
        { label: "How it works", href: "#loop" },
        { label: "Marketplaces", href: "#connect" },
        { label: "Pricing", href: "#pricing" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "Sign in", href: "/login" },
        { label: "Start free", href: "/signup" },
        { label: "Privacy", href: "/privacy" },
        { label: "Terms", href: "/terms" },
      ],
    },
  ],
  /** Deliberately modest. It is the honest description of the product today. */
  note: "Marketplace profit intelligence for GCC sellers.",
} as const
