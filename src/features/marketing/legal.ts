import { legal } from "@/config/legal"

/**
 * The Privacy Policy and Terms, as structured text.
 *
 * Every statement about data describes what the code does today:
 *   - buyer names, emails, phones and addresses are removed before storage
 *     (src/services/marketplaces/customer-data.ts; checked again in the
 *     database, migration 0030)
 *   - each business is separated by row-level security (CLAUDE.md §4)
 *   - Google access is limited to files the user picks or BizMind creates
 *     (drive.file scope, src/services/integrations/connectors/google-sheets)
 *   - the AI receives computed figures, never the uploaded files
 *     (src/services/ai/ledger-facts.ts)
 *   - no advertising or analytics trackers are loaded
 *
 * Company-specific details come from src/config/legal.ts. A lawyer should
 * review both texts before the owner relies on them.
 */

export type LegalSection = {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
}

export type LegalDocument = {
  title: string
  summary: string
  sections: LegalSection[]
}

export const privacyPolicy: LegalDocument = {
  title: "Privacy Policy",
  summary:
    "What BizMind collects, why, where it is kept and what you can ask us to do with it. In short: " +
    "we keep your marketplace figures to work out your profit, we never keep your buyers' personal " +
    "details, and your data is never visible to another business.",
  sections: [
    {
      heading: "Who we are",
      paragraphs: [
        `BizMind AI is operated by ${legal.entity}, ${legal.address} ("we", "us"). For anything about ` +
          `your data, write to ${legal.contactEmail}.`,
      ],
    },
    {
      heading: "What we collect",
      bullets: [
        "Your account: your name, email address and sign-in details.",
        "Your business: its name, currency, marketplace accounts and the people you invite.",
        "The marketplace reports you upload, such as Amazon settlement reports and noon transaction and " +
          "invoice exports: order and settlement references, SKUs, dates, amounts, fees and VAT.",
        "Product costs, SKU matches and operating expenses you enter, upload or sync from a Google Sheet.",
        "A record of important changes (who changed what, and when), kept so figures can be traced.",
      ],
    },
    {
      heading: "What we never keep",
      paragraphs: [
        "Marketplace reports can contain your buyers' names, email addresses, phone numbers and " +
          "addresses. BizMind removes those columns before anything is saved, and the database refuses " +
          "them again as a second check. We do not store your buyers' personal details.",
        "We never ask for your Amazon, noon or other marketplace passwords. BizMind reads the reports " +
          "you upload; it does not log in to your marketplace accounts.",
      ],
    },
    {
      heading: "Why we use it",
      bullets: [
        "To calculate and show your sales, marketplace costs, profit, expected payouts and reports.",
        "To run the checks and alerts you set up.",
        "To explain your figures in plain language when you use Ask BizMind.",
        "To keep the service secure, fix problems and contact you about your account.",
      ],
      paragraphs: ["We do not sell your data, and we do not use it for advertising."],
    },
    {
      heading: "Services we rely on",
      paragraphs: ["We use a small number of providers, each only for its purpose:"],
      bullets: [
        "Supabase, for the database and sign-in.",
        "Vercel, to host the application.",
        "OpenAI, to write explanations when you use Ask BizMind. It receives the figures BizMind has " +
          "already calculated, never your uploaded files.",
        "Google, only if you connect Google Sheets. BizMind can then open only the sheets you choose and " +
          "the sheets it creates for your exports.",
      ],
    },
    {
      heading: "How your data is protected",
      bullets: [
        "Each business's data is separated by the database itself, so one business can never read " +
          "another's.",
        "Data travels over encrypted connections (HTTPS).",
        "Only people you invite to your business can see it, with the role you give them.",
        "Marketplace figures are never edited after upload; a wrong file is withdrawn, not changed.",
      ],
    },
    {
      heading: "Cookies",
      paragraphs: [
        "BizMind uses only the cookies needed to keep you signed in. We do not use advertising or " +
          "analytics cookies.",
      ],
    },
    {
      heading: "How long we keep it, and your choices",
      paragraphs: [
        "We keep your data while your account is open. You can withdraw an uploaded file at any time, " +
          `and you can ask us to delete your business and its data by writing to ${legal.contactEmail}. ` +
          "You can also ask for a copy of your data or ask us to correct it.",
      ],
    },
    {
      heading: "Changes",
      paragraphs: [
        "If we change this policy in a way that matters, we will tell you in the product or by email " +
          `before it takes effect. This version took effect on ${legal.effectiveDate}.`,
      ],
    },
  ],
}

export const termsOfService: LegalDocument = {
  title: "Terms of Service",
  summary:
    "The agreement between you and us when you use BizMind: what the service does, what it does not, " +
    "and what each of us is responsible for.",
  sections: [
    {
      heading: "The service",
      paragraphs: [
        `BizMind AI is provided by ${legal.entity}. It works out marketplace sales, costs and profit from ` +
          "the reports you upload, and explains them. By creating an account you agree to these terms.",
      ],
    },
    {
      heading: "Your account",
      bullets: [
        "Keep your sign-in details safe, and tell us if you think someone else has used your account.",
        "You are responsible for the people you invite to your business and the roles you give them.",
        "Upload only reports and data you are entitled to use.",
      ],
    },
    {
      heading: "Your data",
      paragraphs: [
        "Your data stays yours. You give us permission to store and process it only to provide the " +
          "service to you. Our Privacy Policy explains how we handle it.",
      ],
    },
    {
      heading: "What BizMind is not",
      bullets: [
        "BizMind is not an accountant or tax adviser, and nothing in it is financial, tax or legal " +
          "advice. Settings such as whether VAT on marketplace fees is recoverable should be confirmed " +
          "by your accountant.",
        "Figures depend on the reports you provide. BizMind marks figures it cannot complete as not " +
          "final; check important decisions against your marketplace reports and your accountant.",
        "An expected payout is what a marketplace reports it will pay you. It is not confirmation that " +
          "money reached your bank.",
        "BizMind never changes your listings, prices, advertising or stock.",
      ],
    },
    {
      heading: "Plans and fees",
      paragraphs: [
        "Some plans are free. Paid plans, when offered, are charged as shown at the time you choose " +
          "them. We will tell you before any price you pay changes.",
      ],
    },
    {
      heading: "Acceptable use",
      bullets: [
        "Do not try to access another business's data, disrupt the service or get around its security.",
        "Do not upload anything unlawful or anything you have no right to share.",
      ],
    },
    {
      heading: "Availability and liability",
      paragraphs: [
        "We work to keep BizMind available and accurate, but the service is provided as it is, without " +
          "a guarantee that it will be uninterrupted or free of errors. To the extent the law allows, " +
          "we are not liable for indirect losses, lost profits or decisions made on the basis of the " +
          "service, and our total liability is limited to the fees you paid us in the 12 months before " +
          "the claim.",
      ],
    },
    {
      heading: "Ending the agreement",
      paragraphs: [
        "You can stop using BizMind at any time and ask us to delete your data. We may suspend or close " +
          "an account that breaks these terms, and will tell you why where we can.",
      ],
    },
    {
      heading: "Law and contact",
      paragraphs: [
        `These terms are governed by ${legal.governingLaw}. Questions: ${legal.contactEmail}. ` +
          `This version took effect on ${legal.effectiveDate}.`,
      ],
    },
  ],
}
