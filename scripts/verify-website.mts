/**
 * The public website, offline.
 *
 * Run with:  npm run test:website   (part of npm run verify)
 *
 * The landing page's rule is that it claims nothing BizMind does not do, and
 * (owner direction, 2026-09-29) shows nothing that reads as unfinished. This
 * guards the checkable parts:
 *   - marketplaces are labelled by what is actually built
 *   - the homepage shows no "coming soon" banner or disabled control; a
 *     marketplace may be named as part of who BizMind is built for (owner
 *     direction, 2026-09-30), but the Marketplaces section always draws the
 *     real live/planned line for a reader who wants it
 *   - a placeholder price never shows without the placeholder notice
 *   - bracketed company details never show without the legal "draft" notice
 *   - no copy calls an expected payout money received
 *   - the legal pages exist and the footer links to them
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"

import { legal } from "../src/config/legal"
import { connect, footer, hero, pricing } from "../src/features/marketing/content"
import { privacyPolicy, termsOfService } from "../src/features/marketing/legal"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

const statusOf = (fragment: string) => connect.sources.find((s) => s.name.includes(fragment))?.status
check("Amazon and noon are available; Carrefour and bank statements are planned",
  statusOf("Amazon") === "live" && statusOf("noon") === "live" && statusOf("Carrefour") === "planned" &&
    statusOf("Bank") === "planned")

/**
 * Owner decision, 2026-09-30: real prices are set now (previously this
 * checked that a placeholder never showed without its notice -- there's no
 * placeholder left to guard, so the check tightens to "no price figure
 * looks like one crept back in").
 */
const placeholderPrice = pricing.plans.some((p) => /—|\?|TBD/.test(p.price.monthly) || /—|\?|TBD/.test(p.price.yearly))
check("no pricing figure is a placeholder", !placeholderPrice)

const legalText = JSON.stringify([privacyPolicy, termsOfService, legal])
check("bracketed company details never show without the draft notice", !/\[[^\]]+\]/.test(legalText) || legal.draft)

/**
 * The Trust section (which used to state this guarantee explicitly, as
 * "Expected is never received") was retired 2026-09-30 (owner direction).
 * The fact itself isn't gone from the page -- Preview and Product demo's
 * KPI cards still label an expected payout "Not received", and the terms
 * page still says the same thing (checked separately, below) -- so this
 * check narrows to what it can still verify directly: nothing in the copy
 * source claims an expected payout was actually received.
 */
const copy = readFileSync("src/features/marketing/content.ts", "utf8")
check("no copy calls an expected payout money received",
  !/payouts? (was|were|is|are) received|money received from|received payout/i.test(copy))
check("the hero promises no card, which V1 never asks for",
  hero.trust.some((t) => t.includes("No credit card")))
/**
 * Owner direction, 2026-09-30: the hero now names Carrefour as part of who
 * BizMind is built for (reference-matched, explicit and repeated). The
 * guard that matters now isn't hiding the name -- it's making sure the one
 * place a reader can find the real live/planned split (Marketplaces,
 * further down the page) still draws it correctly, every marketplace the
 * hero shows a logo for is a real one, and no hero logo silently claims a
 * status the data model doesn't back.
 */
check("every marketplace the hero shows a logo for is a real, known one -- no invented marketplace",
  hero.marketplaces.every((m) => connect.sources.some((s) => s.name.includes(m.name))))
/** Strips comments before scanning rendered-UI source, so a doc comment explaining an absence isn't mistaken for the thing itself. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
/**
 * Owner override, 2026-09-30: an earlier version of this guard also checked
 * that a planned source (Carrefour, bank statements) rendered visibly
 * differently from a live one -- a dashed border, a muted tile, a
 * "Planned" badge. Flagged that trade-off explicitly (removing it means
 * the homepage shows two unbuilt integrations as available today) and the
 * owner chose to remove the visual distinction anyway. What's left to
 * guard is narrower: connect.sources[].status must still call them
 * "planned" in the data model (checked above, `statusOf`), and neither key
 * can silently vanish from what actually renders.
 */
const connectSource = stripComments(readFileSync("src/features/marketing/components/connect.tsx", "utf8"))
check("the Marketplaces section still renders Carrefour and bank statements, even though the data model alone now carries their real status",
  connectSource.includes('"carrefour"') && connectSource.includes('"bank"'))
const previewSource = stripComments(readFileSync("src/features/marketing/components/preview.tsx", "utf8"))
check("the old video teaser is gone, and its replacement has no disabled control or 'coming soon' text",
  !existsSync("src/features/marketing/components/film.tsx") &&
    !/coming soon/i.test(previewSource) &&
    !/\bdisabled\b/.test(previewSource))

const privacy = JSON.stringify(privacyPolicy)
check("the privacy policy states buyer details are never kept, and names every data processor",
  privacy.includes("We do not store your buyers' personal details") &&
    ["Supabase", "Vercel", "OpenAI", "Google"].every((p) => privacy.includes(p)))
check("the terms say BizMind is not tax advice and an expected payout is not money in the bank",
  JSON.stringify(termsOfService).includes("not an accountant or tax adviser") &&
    JSON.stringify(termsOfService).includes("not confirmation that money reached your bank"))

const links = footer.groups.flatMap((g) => g.links.map((l) => l.href))
check("the footer links to the privacy policy and terms, and both pages exist",
  links.includes("/privacy") && links.includes("/terms") &&
    readFileSync("src/app/privacy/page.tsx", "utf8").includes("privacyPolicy") &&
    readFileSync("src/app/terms/page.tsx", "utf8").includes("termsOfService"))

// Scroll motion (owner request, 2026-10-06; DESIGN.md section 11). It must never be able to hide the page.
const reveal = readFileSync("src/features/marketing/components/scroll-reveal.tsx", "utf8")
const css = readFileSync("src/app/globals.css", "utf8")
const marketingFiles = readdirSync("src/features/marketing/components")
check("scroll reveals do nothing for visitors who prefer reduced motion, in script and in styles",
  /prefers-reduced-motion: reduce/.test(reveal) && /@media \(prefers-reduced-motion: no-preference\)[\s\S]*data-reveal-state="hidden"/.test(css))
check("nothing is hidden by the server: only the script marks an element hidden, so a page without scripts is complete",
  !/data-reveal-state/.test(readFileSync("src/app/page.tsx", "utf8")) &&
    marketingFiles.every((f) => f === "scroll-reveal.tsx" || !/data-reveal-state/.test(readFileSync(`src/features/marketing/components/${f}`, "utf8"))))
check("only elements below the fold are hidden, each reveals once, and no parallax or scroll-jacking exists",
  /getBoundingClientRect\(\)\.top < window\.innerHeight\) continue/.test(reveal) && /unobserve/.test(reveal) &&
    !/parallax|scroll-snap|wheel/i.test((reveal + css.slice(css.lastIndexOf("/*", css.indexOf("Marketing scroll motion")))).replace(/\/\*[\s\S]*?\*\//g, "")))
check("the landing page mounts ScrollReveal, and no product screen does",
  /<ScrollReveal \/>/.test(readFileSync("src/app/page.tsx", "utf8")) &&
    !readdirSync("src/app/(app)", { recursive: true }).some((f) => String(f).endsWith(".tsx") && /ScrollReveal|data-reveal/.test(readFileSync(`src/app/(app)/${f}`, "utf8"))))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
