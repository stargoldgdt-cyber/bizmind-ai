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
 * hold, and no integration presented as ready when it is not.
 *
 * Where a claim is checkable, the code that makes it true is named in a
 * comment.
 */

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

export const nav = {
  links: [
    { label: "Product", href: "#understand" },
    { label: "How it works", href: "#loop" },
    { label: "Integrations", href: "#connect" },
    { label: "Pricing", href: "#pricing" },
  ],
  signIn: { label: "Sign in", href: "/login" },
  cta: { label: "Start free", href: "/signup" },
} as const

/* -------------------------------------------------------------------------- */
/* 1. Hero                                                                     */
/* -------------------------------------------------------------------------- */

export const hero = {
  eyebrow: "AI business intelligence",

  /**
   * Two sentences, second one shorter. The first says what you get, the
   * second says what makes it different from every dashboard the reader has
   * already bought and stopped opening.
   */
  headline: "Know your numbers.",
  headlineAccent: "Know what to do next.",

  support:
    "BizMind reads the data your business already produces and tells you " +
    "where the money is going — in plain language, with the working shown.",

  primary: { label: "Start free", href: "/signup" },
  secondary: { label: "Watch the 90-second tour", href: "#film" },

  /** True: import is CSV/Excel, and no card is collected anywhere in the app. */
  note: "No credit card. Start with a spreadsheet you already have.",
} as const

/* -------------------------------------------------------------------------- */
/* 2. The problem                                                              */
/* -------------------------------------------------------------------------- */

export const problem = {
  eyebrow: "The gap",
  headline: "Your dashboard is green. Your bank balance disagrees.",
  support:
    "Every tool you own reports what happened. None of them tell you which " +
    "part of it cost you money.",

  /** The tension, as three figures that cannot all be good news. */
  figures: [
    { label: "Revenue", value: "+18%", tone: "up" },
    { label: "Orders", value: "+12%", tone: "up" },
    { label: "Net profit", value: "−9%", tone: "down" },
  ],

  question: "So where did it go?",

  /** What an analyst would have to do by hand. This is the work BizMind does. */
  answer: [
    { label: "Marketplace fees", detail: "up 2.4 points as a share of revenue" },
    { label: "Cost of goods", detail: "up on your three best sellers" },
    { label: "Gross margin", detail: "down to 11.4% from 15.8%" },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 3. The loop                                                                 */
/* -------------------------------------------------------------------------- */

export const loop = {
  eyebrow: "How it works",
  headline: "Six steps. One of them is the one nobody else does.",
  support:
    "Most tools stop at the third step. The value is in the last three.",

  steps: [
    { name: "Connect", detail: "Spreadsheets and stores" },
    { name: "Understand", detail: "What each column means" },
    { name: "Analyze", detail: "Computed, never estimated" },
    { name: "Alert", detail: "Only when it is real" },
    { name: "Recommend", detail: "In plain language" },
    { name: "Automate", detail: "Rules you write" },
  ],

  /** Marks where a report stops and a decision starts. */
  divider: 3,
} as const

/* -------------------------------------------------------------------------- */
/* 4. Demo film                                                                */
/* -------------------------------------------------------------------------- */

export const film = {
  eyebrow: "See it work",
  headline: "A spreadsheet in. A decision out.",
  support: "Ninety seconds, no narration over an empty dashboard.",

  chapters: [
    "Import a sales export",
    "Confirm what the columns mean",
    "Read the profit story",
    "Ask why",
    "Set the alert",
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 5. Understand                                                               */
/* -------------------------------------------------------------------------- */

export const understand = {
  eyebrow: "Understand",
  headline: "Every figure, with its working shown.",
  support:
    "Each number says how it was calculated and how much of the underlying " +
    "data it actually had. A margin built on half your costs says so.",

  /**
   * Real figures from the analytics engine's own vocabulary. Values are
   * illustrative of a demo business, and every one is a figure BizMind
   * genuinely computes — see src/services/metrics/canonical.ts.
   */
  metrics: [
    {
      label: "Revenue",
      value: "AED 284,500.00",
      change: 18.2,
      higherIsBetter: true,
      explanation: "Sum of order totals, excluding cancelled and refunded orders.",
      warning: undefined,
    },
    {
      label: "Gross margin",
      value: "11.4%",
      change: -4.4,
      higherIsBetter: true,
      explanation:
        "Revenue minus cost of goods and marketplace fees, as a percentage of revenue.",
      /** The card's own warning slot. A margin this incomplete must say so. */
      warning: "82% cost coverage — 1 in 6 items sold has no cost recorded.",
    },
    {
      label: "Marketplace fees",
      value: "AED 31,295.00",
      change: 26.0,
      /** Fees rising is not good news, and the delta chip must not colour it green. */
      higherIsBetter: false,
      explanation:
        "Fees charged by each channel, taken from the channel's own settlement figures.",
      warning: undefined,
    },
  ] as {
    label: string
    value: string
    change: number
    higherIsBetter: boolean
    explanation: string
    warning?: string
  }[],

  /** The differentiator, stated as a constraint rather than a boast. */
  pledge: {
    title: "The number is never a guess",
    body:
      "Every figure is calculated in the database and passed to the interface " +
      "as an exact decimal. Nothing is rounded on the way to your screen, and " +
      "the AI is never asked to do arithmetic.",
  },
} as const

/* -------------------------------------------------------------------------- */
/* 6. Explain — the AI analyst                                                 */
/* -------------------------------------------------------------------------- */

export const analyst = {
  eyebrow: "Ask BizMind",
  headline: "Don't just read the number. Ask why.",
  support:
    "BizMind explains figures it was given. It cannot invent one, and when " +
    "the data is too thin to answer, it says so instead of guessing.",

  /**
   * Shaped exactly like a real exchange: the model receives verified figures
   * and narrates them. The guard in src/services/ai enforces that it cannot
   * state a figure it was not given.
   */
  exchange: {
    question: "Why did my profit drop last month?",
    answer:
      "Net profit fell 9.2%, even though revenue rose 18.2%. The cause is " +
      "cost, not sales: marketplace fees rose 26% while revenue rose 18%, so " +
      "fees took a larger share of every order.",
    cited: [
      { label: "Net profit", value: "−9.2%" },
      { label: "Revenue", value: "+18.2%" },
      { label: "Marketplace fees", value: "+26.0%" },
    ],
    caveat:
      "82% cost coverage. One in six items sold has no cost recorded, so " +
      "your real margin is lower than the figure above.",
  },
} as const

/* -------------------------------------------------------------------------- */
/* 7. Protect and act                                                          */
/* -------------------------------------------------------------------------- */

export const act = {
  eyebrow: "Alerts and automation",
  headline: "It tells you early. It does not act behind your back.",
  support:
    "You write the rule. BizMind checks it and raises an alert. Nothing in " +
    "BizMind buys, prices, emails a customer, or changes your store.",

  /** Mirrors the real rule shape in supabase/migrations/0016. */
  rule: {
    when: "Gross margin",
    operator: "falls below",
    threshold: "15%",
    period: "over 30 days",
    then: "Raise a warning alert",
    cooldown: "At most once a day",
  },

  /**
   * The quiet behaviours, which are the actual product.
   * All three are enforced in automation_evaluate_rule().
   */
  restraint: [
    {
      title: "A quiet month is not a crisis",
      body:
        "No orders in the period means there is nothing to measure. BizMind " +
        "records that and stays silent, rather than reading it as a margin " +
        "of zero and waking you on a public holiday.",
    },
    {
      title: "It will not alarm you over a figure it distrusts",
      body:
        "If costs are missing, your reported margin is higher than reality. " +
        "A profit alert holds until the data is complete — and a separate " +
        "alert tells you the data is what needs fixing.",
    },
    {
      title: "Silence is explainable",
      body:
        "Every check is recorded, including the ones that raised nothing and " +
        "why. “Why didn't I hear about this?” has an answer.",
    },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 8. Connect                                                                  */
/* -------------------------------------------------------------------------- */

export const connect = {
  eyebrow: "Integrations",
  headline: "You don't replace your systems. You connect them.",
  support:
    "BizMind sits on top of what you already run. Start with an export you " +
    "have today.",

  /**
   * STATUS IS LOAD-BEARING. "Available" means a customer can use it now.
   *
   *   live    — built, tested, in the product
   *   beta    — built and tested, but not yet run against a real store
   *   planned — designed, not built
   *
   * Nothing moves up a level until it is true.
   */
  sources: [
    { name: "Excel", status: "live" },
    { name: "CSV", status: "live" },
    { name: "WooCommerce", status: "beta" },
    { name: "Shopify", status: "planned" },
    { name: "Amazon", status: "planned" },
    { name: "Custom REST", status: "planned" },
  ],

  statusLabels: {
    live: "Available",
    beta: "In testing",
    planned: "Planned",
  },

  footnote:
    "In testing means built and verified, but not yet run against a live " +
    "store. Planned means designed and not yet built.",
} as const

/* -------------------------------------------------------------------------- */
/* 9. Trust                                                                    */
/* -------------------------------------------------------------------------- */

export const trust = {
  eyebrow: "Why trust the numbers",
  headline: "Built so a wrong figure is hard to produce.",
  support:
    "No logos, no badges. These are properties of how BizMind is built, and " +
    "each one is enforced in code rather than promised in a policy.",

  /** Every one of these is checked by a test that fails the build. */
  guarantees: [
    {
      title: "A blank is never a zero",
      body:
        "An empty cell in your spreadsheet stays unknown. It never quietly " +
        "becomes a zero that flatters a total.",
    },
    {
      title: "A column name is never a definition",
      body:
        "BizMind asks what a column means before using it. A supplier's " +
        "“Profit” column does not become your profit.",
    },
    {
      title: "The AI cannot state a figure",
      body:
        "Numbers are computed in the database and handed to the model to " +
        "explain. A figure it was not given is refused before you see it.",
    },
    {
      title: "Money keeps every decimal",
      body:
        "Amounts travel as exact decimals from the database to your screen. " +
        "No rounding, no floating-point drift.",
    },
    {
      title: "Your data is yours alone",
      body:
        "Separation between businesses is enforced by the database itself, " +
        "not by application code remembering to filter.",
    },
    {
      title: "Everything is on the record",
      body:
        "Meaningful changes are written to an audit trail: who, what, before, " +
        "after, when.",
    },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 10. Pricing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * PLACEHOLDER PRICING — NOT FINAL.
 *
 * These are the only invented numbers on this page. They exist so the section
 * can be designed and reviewed; they are not a pricing decision and must be
 * replaced before the site is published. Everything else on the page is either
 * true today or explicitly labelled as not yet built.
 */
export const pricing = {
  eyebrow: "Pricing",
  headline: "Start with a spreadsheet. Pay when it earns its place.",
  support: "No card to begin. Cancel from the dashboard.",

  placeholderNotice: true,

  plans: [
    {
      name: "Starter",
      price: "Free",
      cadence: "",
      For: "One business, spreadsheet imports.",
      features: [
        "Excel and CSV import",
        "Profit and margin analytics",
        "Business health score",
        "Plain-language explanations",
      ],
      cta: "Start free",
      featured: false,
    },
    {
      name: "Growth",
      price: "$49",
      cadence: "per month",
      For: "Owners running more than one channel.",
      features: [
        "Everything in Starter",
        "Store connections and scheduled sync",
        "Alert rules and daily checks",
        "Channel and product profitability",
        "Team access with roles",
      ],
      cta: "Start free",
      featured: true,
    },
    {
      name: "Scale",
      price: "Talk to us",
      cadence: "",
      For: "Multiple businesses under one roof.",
      features: [
        "Everything in Growth",
        "Multiple businesses",
        "Priority support",
        "Onboarding help with your data",
      ],
      cta: "Get in touch",
      featured: false,
    },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* 11. Closing                                                                 */
/* -------------------------------------------------------------------------- */

export const closing = {
  headline: "Stop guessing.",
  headlineAccent: "Start knowing.",
  support:
    "Your business already produces the data. BizMind turns it into the " +
    "decision you were going to have to make anyway.",
  primary: { label: "Start free", href: "/signup" },
  secondary: { label: "Watch the tour", href: "#film" },
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
        { label: "Integrations", href: "#connect" },
        { label: "Pricing", href: "#pricing" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "Sign in", href: "/login" },
        { label: "Start free", href: "/signup" },
      ],
    },
  ],
  /** Deliberately modest. It is the honest description of the product today. */
  note: "The intelligence layer for the systems you already run.",
} as const
