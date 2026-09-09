# Decisions

A record of choices that shaped the project, and why. New entries go at the
bottom. If a decision is reversed, mark it superseded rather than deleting it —
the reasoning is worth keeping.

Format: what was decided, why, what was rejected, and the cost of changing it.

---

## 2026-09-08 — Node.js 24 LTS, not Node.js 22

**Decided:** Node.js 24.19.0 as the runtime.

**Why:** Node 22 was requested initially, but by September 2026 it is in
maintenance and reaches end-of-life in **April 2027** — roughly seven months
away. Node 24 is the Active LTS and is supported until **April 2028**. Starting
a product on a runtime that expires within months would force an upgrade
shortly after launch.

**Rejected:** Node 22 (short remaining life), Node 26 (not yet LTS at the time).

**Cost to change:** Low. Runtime upgrades are routine.

---

## 2026-09-08 — Next.js 16 with the App Router

**Decided:** Next.js 16.3.4, App Router, TypeScript, Turbopack (the default).

**Why:** Latest stable release. Server Components keep data access and secrets
on the server, which matters for a multi-tenant product where every query must
be tenant-scoped. One framework covers UI and API, which keeps a small team
fast.

**Watch out:** Next 16 removed synchronous `cookies()`, `headers()`, `params`
and `searchParams` — all are async now. `middleware.ts` was renamed to
`proxy.ts`. These are recorded in `CLAUDE.md` § 3 because older tutorials and
model training data still teach the old forms.

**Cost to change:** Very high. This is the foundation.

---

## 2026-09-08 — Tailwind CSS v4

**Decided:** Tailwind v4 with CSS-first configuration.

**Why:** v4 is the current stable line and configures itself from CSS custom
properties via `@theme`, which suits a token-driven design system: the tokens
*are* the config, in one file, readable without knowing JavaScript. No
`tailwind.config.js` to drift out of sync.

**Rejected:** Tailwind v3 (previous generation), CSS Modules and styled
components (slower to iterate, no shared token vocabulary).

**Cost to change:** High.

---

## 2026-09-08 — shadcn/ui on Radix primitives

**Decided:** shadcn/ui v4 with `--base radix`.

**Why:** shadcn copies component source into the repository rather than hiding
it in a dependency, so components can be adapted to BizMind's design language
without fighting a library. Radix primitives handle keyboard navigation, focus
management and ARIA correctly — accessibility that is expensive to retrofit.
Radix was chosen over the newer Base UI default for its longer production track
record.

**Rejected:** Material UI and Ant Design (opinionated look, hard to make feel
like our brand), building primitives from scratch (accessibility risk).

**Cost to change:** Moderate. Components are ours; swapping the primitive layer
means rewriting the interactive ones.

---

## 2026-09-08 — Hex colours in the token file, not OKLCH

**Decided:** Design tokens are written as hex.

**Why:** Exact, universally readable, and reviewable by a non-technical owner
who can paste one into any colour picker. Tailwind v4 and the `color-mix()`
calls inside shadcn components accept hex directly, so nothing is lost. The
usual argument for OKLCH — generating a ramp by arithmetic — does not apply
here, because the ramp was picked deliberately rather than computed.

**Cost to change:** Low. It is one file.

---

## 2026-09-08 — Chart palette validated, not chosen by eye

**Decided:** Six categorical series colours, validated for colour-blind
separation and contrast in both light and dark themes before adoption.

**Why:** A business chart where two series look alike is a correctness problem,
not a cosmetic one — an owner could misread which channel is losing money.
Colour-blind safety cannot be judged by eye, so it was computed. Figures and
rules are in `DESIGN.md`.

**Consequence:** The palette caps at six series. `getSeriesColor()` throws past
that instead of silently cycling, forcing the caller to group into "Other" or
split the chart.

**Cost to change:** Low, but any change must be re-validated.

---

## 2026-09-08 — Three fonts, each with a job

**Decided:** Plus Jakarta Sans (headings), Inter (body/UI), JetBrains Mono
(figures), all via `next/font` and declared only in `src/config/fonts.ts`.

**Why:** Inter is built for dense interface text and is the reference face for
dashboards. Plus Jakarta Sans gives headlines a geometric, premium character
without being a novelty face. A monospace with tabular figures makes columns of
money align — with proportional digits, financial tables jitter and are hard to
scan, which matters more here than in most products.

**Rejected:** A single font family (headlines lack character), Geist (the
scaffold default, less distinctive).

**Cost to change:** Very low. One file.

---

## 2026-09-08 — Folders are created when they hold real code

**Decided:** No empty scaffolding directories. `src/features/`, `src/services/`,
`src/types/` and `src/hooks/` are documented in `ARCHITECTURE.md` but not
created until a phase puts real code in them.

**Why:** Empty folders imply structure that does not exist and drift from
reality. The documented plan communicates intent without the pretence.

**Cost to change:** None.

---

## 2026-09-08 — Four-level surface system as the primary rhythm device

**Decided:** Added `surface-1` (white), `surface-2` (tinted), `surface-3`
(near-black) and `surface-brand` (violet), each with its own foreground, muted
and border tokens. Page rhythm comes from alternating full-bleed section bands.

**Why:** Analysis of the supplied visual reference identified section-level
colour zoning as the single mechanism doing most of the work in making that
design feel premium — not gradients, effects or decoration. The previous system
had no equivalent, and had no way to build a dark or violet section without
hard-coding colours, which violated our own no-hard-coded-colour rule.

Every level carries its own foreground set specifically so that
`text-white` never needs to be written inside a section.

**Verified:** all thirteen text/background pairings across both themes were
measured for WCAG contrast. Lowest is 5.36:1 against a 4.5:1 requirement.

**Rejected:** one background with decorated sections (weaker rhythm); per-section
one-off colours (unmaintainable).

**Cost to change:** Low now, high after Phase 4. This is why it was done before
the dashboard exists.

---

## 2026-09-08 — Removed the glow token

**Decided:** Deleted `--shadow-glow` / `--elevation-glow` entirely, and removed
it from the hero CTA.

**Why:** It conflicted directly with the product's own anti-generic brief, which
lists "excessive glowing effects" as something to avoid. The visual reference
uses no glow anywhere; its CTAs are flat violet pills. Keeping an unused-but-
available glow token invites it back in later.

Elevation is now reserved for things that genuinely float — dialogs, popovers,
dropdowns, layered product screenshots.

**Cost to change:** Trivial to re-add if ever wanted.

---

## 2026-09-08 — Uniform grids instead of bento

**Decided:** `DESIGN.md` now specifies uniform 3- and 4-across grids as the
default, with bento mosaics reserved for content that genuinely varies in
importance (a dashboard overview, not a feature list).

**Why:** The reference deliberately avoids bento. Uniform grids read calmer and
more enterprise, and they collapse 4→2→1 responsively without special cases.
"Bento" as a default invites mosaics that are hard to keep tidy and hard to make
responsive.

**Cost to change:** None — it is guidance, not a token.

---

## 2026-09-08 — Two visual registers, marketing and product

**Decided:** Documented marketing and product as separate registers with
different density, spacing, container and violet usage, drawing on the same
tokens.

**Why:** The visual reference is a marketing page and contains almost nothing
about dashboard design. The biggest risk it introduced was applying marketing
spaciousness to a dashboard — producing a product that demos well and works
badly, with three numbers visible per screen.

Recorded alongside it: a strict colour hierarchy for the product (status →
violet → chart series → neutral ink). If a dashboard is mostly neutral, a single
amber chip becomes genuinely informative. A colourful dashboard cannot alert.

**Cost to change:** Low today; it is documentation ahead of Phase 4.

---

## 2026-09-08 — Tenancy helpers are SECURITY DEFINER functions

**Decided:** RLS policies resolve tenant access through
`current_user_business_ids()` and `current_user_has_role()`, both
`SECURITY DEFINER` with `search_path = ''`.

**Why:** An RLS policy on `business_members` that itself queries
`business_members` causes infinite recursion — Postgres cannot evaluate the
policy without first evaluating the policy. This is the single most common way
multi-tenant Supabase schemas break. Doing the lookup inside a definer function
breaks the cycle.

Safe because each function only reveals facts about the *calling* user's own
memberships; none accepts a user id to impersonate. `search_path = ''` stops a
malicious schema shadowing the referenced tables, which is why every object
inside them is fully qualified.

**Rejected:** inlining membership subqueries in every policy (recursion, and
duplicated logic across every future table); JWT custom claims (stale after a
role change until the token refreshes).

**Cost to change:** High — every future table's policies build on these.

---

## 2026-09-08 — Businesses are created only through a function

**Decided:** `businesses` has **no INSERT policy**. `create_business()` inserts
the business and the OWNER membership together, and is the only supported path.

**Why:** The two writes must be atomic. As separate statements, a failure
between them leaves a business with no owner — unadministrable and invisible to
everyone, including the person who just created it. A function body is one
transaction, so it cannot half-succeed.

Paired with a `prevent_last_owner_removal()` trigger, so an owner cannot later
delete or demote themselves out of their own workspace.

**Cost to change:** Low.

---

## 2026-09-08 — The active business is a hint, never an authority

**Decided:** The current business is stored in a cookie, but every read
re-checks it against the user's actual memberships and falls back to their first
business if it does not match.

**Why:** A cookie is client-controlled. Trusting it would be the classic
multi-tenant flaw: RLS would still block the *data*, but the interface would
claim to be showing a company the user has no access to — confusing at best,
and a plausible-looking security incident at worst. The rule generalises: verify
every client-supplied identifier server-side.

**Cost to change:** Low.

---

## 2026-09-08 — Password rule is length, not composition

**Decided:** Minimum 12 characters. No required symbols, digits or mixed case.

**Why:** Length is what actually resists guessing. Composition rules push people
toward predictable patterns like `Password1!` and toward reusing passwords
across sites, which makes accounts less safe rather than more. This matches
current NIST guidance.

**Cost to change:** Trivial — one schema.

---

## 2026-09-08 — Environment variables validated at startup

**Decided:** `src/lib/env.ts` validates public configuration with Zod and throws
a readable message if anything is missing or malformed.

**Why:** The product owner is non-technical. A missing variable would otherwise
surface as an obscure runtime error deep inside a request; instead it fails
immediately saying exactly which value is missing and what to do about it.

Deliberately covers **public values only**. Server-only secrets are read where
they are used, so there is no chance of one being pulled into a browser bundle
through this module.

**Trade-off accepted:** the app will not start at all until Supabase is
configured. That is the correct behaviour — a misconfigured app should not
pretend to work.

**Cost to change:** Trivial.

---

## 2026-09-08 — File import built as the first connector

**Decided:** CSV/Excel import shares one pipeline with every future
integration: mapping, validation, normalisation and an atomic apply. A file
connector and a Shopify connector differ only in how raw records arrive and
whether the mapping is user-chosen or vendor-fixed.

**Why:** Building import as a standalone feature would mean writing the same
validation and upsert logic again for Shopify, then again for WooCommerce, and
letting marketplace assumptions leak into the data model. The shared contract
makes each new connector a mapping plus a fetch.

**Cost to change:** High later, trivial now — which is why it was done now.

---

## 2026-09-08 — Ambiguity is refused, never resolved

**Decided:** An ambiguous date (`03/04/2026`), a number contradicting the
chosen decimal separator, an unrecognised order status, or a row in a foreign
currency is REJECTED with an explanation. None of them is guessed.

**Why:** Guessing produces a plausible wrong number, which is the most
dangerous output this product can generate — worse than an error, because
nobody investigates a figure that looks reasonable. `03/04/2026` read as
month-first instead of day-first moves revenue into a different month and
silently corrupts every period comparison.

Currency is the sharpest case: converting would require an exchange rate, and
inventing one would be inventing a financial figure. Foreign-currency rows are
refused and the user is told to use a separate business.

**Cost to change:** Low, but it should not change.

---

## 2026-09-08 — Missing recommended fields warn rather than block

**Decided:** Three tiers. `required` blocks the import; `recommended` allows it
but names the consequence and needs an explicit acknowledgement; `optional` is
silent.

**Why:** Blocking an import because costs are missing would stop an owner
seeing their revenue at all. Importing silently would let them believe a
100% margin is real. The middle path shows the number and states plainly that
profit is overstated — which is also why `dashboard_summary` returns cost
coverage.

Demonstrated in testing: importing product costs corrected a channel that had
been showing a 100% margin down to its real 50%.

**Cost to change:** Low.

---

## 2026-09-08 — uuid overridden to clear an exceljs advisory

**Decided:** `exceljs` for XLSX reading, with an npm `overrides` entry forcing
`uuid` to v11.

**Why:** The npm `xlsx` package is frozen at 0.18.5 — SheetJS moved
distribution to their own CDN — and that version carries a known prototype
pollution flaw. `exceljs` is the maintained npm-native alternative, but it pins
`uuid@^8`, which took the project from zero advisories to two.

Rather than accept them, `uuid` was overridden to v11, restoring a clean audit.
The override was then FUNCTIONALLY tested: a workbook was written and read back
to confirm exceljs still works. An override that silently breaks the library
would be worse than the advisory it fixes.

**Cost to change:** Low.

---

## 2026-09-08 — Import writes live in SQL functions

**Decided:** Each entity has an `import_apply_*` function that takes validated
rows as jsonb and writes them in one transaction. `business_id` is read from
the batch row, never from the caller's arguments.

**Why:** Two reasons. A half-applied import is worse than none — the owner sees
a figure that is neither the old truth nor the new one — and a function body is
a single transaction. And deriving the business from the RLS-protected batch
means a caller cannot import into a business they do not belong to even by
passing its id.

Verified: a batch whose second row fails at the database level leaves the valid
first row unwritten.

**Cost to change:** Moderate.

---

## 2026-09-09 — Historical costs are never taken from the catalogue

**Decided:** An order line's `unit_cost` comes from the imported file and from
nowhere else. Nothing copies a product's current cost into a past order.

**Why:** The first import implementation did exactly that, and it was wrong in
the most dangerous way this product can be wrong — it produced a plausible
number nobody would question. A supplier re-pricing an item would silently
rewrite last year's profit, and two people running the same report months apart
would get different answers. Seen in testing: an order imported with no cost was
given 1500.00 from the catalogue, turning an honest "cost unknown" into a
confident, invented margin.

A cost is a snapshot of one moment. The catalogue is a fact about a different
moment. They are not interchangeable.

**Consequence accepted:** importing product costs no longer clears the "profit
is overstated" warning. The only way to get accurate margins is to include cost
in the sales export. That is a real constraint on the product, and the interface
now says so plainly rather than implying a shortcut that would produce fiction.

**Cost to change:** Low, but it must not change. Migration 0005 fails if the
backfill reappears.

---

## 2026-09-09 — A policy existing is not evidence that it works

**Decided:** `prevent_last_owner_removal()` now ignores cascades from a business
being deleted.

**Why:** Deleting a business cascaded to `business_members`, where the
last-owner guard refused to remove the final OWNER — without knowing the
business it belonged to was itself being deleted. No business could ever be
deleted, even though the DELETE policy allowed it.

**How it was missed:** the Phase 2 tests verified that the delete POLICY
existed. They never verified that a delete SUCCEEDED. It surfaced only when a
regression test tried to clean up after itself.

**The lesson, recorded because it generalises:** test the behaviour, not the
configuration. A policy, a constraint or a setting being present says nothing
about whether the operation it governs actually works.

**Cost to change:** Low.

---

## 2026-09-09 — Period deltas are computed in SQL, not TypeScript

**Decided:** `analytics_compare()` returns current value, previous value,
absolute change, percentage change and direction. TypeScript performs no
arithmetic on money at all.

**Why:** "Never do financial arithmetic in JavaScript" fails the moment someone
writes `Number(a) - Number(b)` for a delta and thinks it does not count. Moving
subtraction into SQL removes the temptation and the exception. The rule is now
absolute, which is the only kind of rule that survives.

What TypeScript still does is compare already-computed RATIOS against
documented thresholds — judgement, not calculation.

**Cost to change:** Low, but it should not change.

---

## 2026-09-09 — A zero denominator yields NULL, never zero or infinity

**Decided:** Every ratio returns NULL when it cannot be calculated. A margin
with no revenue, an average with no orders, a percentage change from a previous
period of zero.

**Why:** Zero and "unknown" are different facts, and collapsing them
manufactures information. A margin of 0% says the business broke even; a margin
of NULL says there were no sales. Rendering `+100%` or an infinity symbol for a
rise from nothing invents a figure that will be quoted back later as though it
meant something.

The distinction is preserved all the way to the screen, where it appears as
"no prior data" rather than a number.

**Cost to change:** Low.

---

## 2026-09-09 — Health thresholds are published first drafts, not science

**Decided:** Six dimensions, each scored by plain stated bands written in
`health.ts`. No weighting model, no derived formula.

**Why:** You asked for transparent deterministic rules rather than invented
sophistication, and that is the right instinct. BizMind has no customer data to
calibrate against, so any elaborate model would be false rigour dressed as
insight. The bands are readable, arguable and replaceable.

Two rules matter more than the numbers:

- **An unmeasurable dimension scores NULL and is excluded from the average.**
  Defaulting it to 50 would silently move the headline score, which is the
  figure people remember.
- **A dimension built on unreliable inputs is marked low-confidence and says
  why.** A 60% margin on 40% cost coverage is not scored at all.

**Cost to change:** Trivial, and expected once real data exists.

---

## 2026-09-09 — Insights are rules, and they refuse to speak from data gaps

**Decided:** A deterministic rule engine over verified figures. No model. Every
insight carries its supporting metrics so the reasoning can be checked.

**Why:** An insight is a claim about someone's business. It must be true
because the arithmetic says so, not because a sentence was plausible. Later the
AI will EXPLAIN these outputs; it will not generate them.

**Two flaws found by running it against real data, both fixed:**

1. It recommended shifting effort to a channel showing a 100% margin — a margin
   that was 100% only because that channel's costs were missing. Advice
   manufactured from a data gap is worse than no advice. Channel rules now
   require complete cost coverage on both sides of any comparison.

2. It then recommended the "Unattributed" channel, which is not a channel at
   all but the bucket for orders with no channel recorded. Recommendations now
   exclude it, because there is no action behind them.

Both have regression tests. The pattern generalises: **before an insight
recommends anything, check that the number driving it is real.**

**Cost to change:** Low.

---

## 2026-09-09 — Products do not reconcile to total revenue, and that is stated

**Decided:** Product revenue is order-LINE revenue. It does not include
shipping or order-level discounts, so it does not sum to total revenue.
`analytics_reconciliation()` reports the gap explicitly.

**Why:** Shipping belongs to an order, not to a product, and apportioning it
would be an invention. The alternative — quietly letting two revenue figures
differ — produces the moment where someone loses trust in the whole dashboard.
Naming the gap is cheaper than defending it later.

Per-product fees ARE apportioned, by line revenue, and the column is called
`fees_allocated` so it cannot be read as a charge actually paid per product.

**Channels, by contrast, reconcile exactly**, and a test asserts it.

**Cost to change:** Low.

---

## 2026-09-08 — `shadcn` kept as a runtime dependency

**Decided:** Left `shadcn` in `dependencies` where its installer placed it,
rather than moving it to `devDependencies`.

**Why:** `globals.css` imports `shadcn/tailwind.css`, so the package is needed
at build time, not only by the CLI. Moving it risks a broken production build
for a tidiness gain. Revisit if the CSS import is ever removed.

**Cost to change:** Low.

---

## 2026-09-09 — A source column is not a metric until someone says what it means

**Decided:** Data from an outside system is preserved under the source's own
name and feeds **no** BizMind figure until a named person confirms what the
field means. The rule is enforced by two check constraints on
`source_field_semantics`, not by application code.

**Why:** The trigger was a real Amazon.ae export containing a column called
"product Wholesale Price". The name suggests cost of goods. It might be:

- (A) the cost of the units actually sold in the period,
- (B) procurement spend during the period, or
- (C) something specific to how this seller keeps their books.

Those produce materially different profit figures, and the column name cannot
distinguish them. Worse, the settlement identity
`Total Sales − Total Expense = Payment` closes **exactly** without it — so
Amazon did not produce that column at all. It is seller-supplied, which means
no Amazon documentation can ever define it. Only the seller can.

It is recorded verbatim as *"Source-defined product wholesale cost — COGS
attribution unverified."*

The source's own `Profit/Loss` is `Payment − product Wholesale Price` (verified
on the sampled rows and on the totals: 49,648.59 − 53,510.20 = −3,861.61). It
is kept under that name and is **not** mapped to BizMind's net profit, because
it inherits whatever the wholesale field means.

**Rejected:** Inferring meaning from column names. It is right often enough to
be trusted and wrong often enough to be dangerous — which is the worst
combination a financial product can have.

**Cost to change:** Low to loosen, high to reverse. The constraints are the
enforcement; removing them removes the guarantee.

---

## 2026-09-09 — Blank is stored as unknown, never as zero

**Decided:** A numeric field the source left blank is stored as `NULL`. Money
columns that previously defaulted to `0` are now nullable. A recorded zero
stays `0`.

**Why:** "There was no advertising cost" and "the file did not say what the
advertising cost was" are different facts. Storing both as `0` destroys the
difference permanently, and the resulting profit figure looks *better* than the
truth — the failure direction that loses a customer money.

The Amazon sample had four columns blank across every row: Cost of Advertising,
Inventory Reimbursements, Storage Fee, and Other. Nothing in the export states
that blank means zero.

**Consequence, accepted deliberately:** BizMind can no longer always give a
single confident profit number. `analytics_financials()` now returns
`orders_fees_unknown` and `fee_coverage`, and the dashboard names the gap —
"3 of 8 orders have no recorded fee — so this is overstated." A less
confident number that is true beats a confident one that is not.

**Cost to change:** Medium. The nullable columns are the hard part; the
reporting is additive.

---

## 2026-09-09 — One canonical vocabulary, and computed metrics are unreachable

**Decided:** Every business metric has one stable internal name, defined once in
`src/services/metrics/canonical.ts`. The dashboard registry is built from that
file rather than restating it. Each metric declares an origin: `sourced` (a
confirmed column may supply it) or `computed` (BizMind calculates it). **No
source column may ever be mapped to a computed metric**, enforced by a foreign
key onto a `canonical_metrics` table paired with a pinned `'sourced'` value.

**Why:** Two problems, one answer.

The first is drift. A metric defined in two places eventually means two things,
and nobody finds out until the two disagree in front of a customer.

The second is more dangerous. A marketplace's own `Profit/Loss` column looks
exactly like net profit. It is built from whatever that seller put in their cost
column and excludes every expense the marketplace never saw. If it could occupy
the `net_profit` slot it would inherit the credibility of a figure BizMind had
actually checked. Making that structurally impossible is worth more than any
amount of care in the code that would otherwise have to prevent it.

**Rejected:** Keeping the analytics registry as the vocabulary. It only holds
what the dashboard publishes, which is not the same set as what a source can
supply — advertising, storage and payouts have no dashboard tile yet and still
need canonical names.

**Cost to change:** Medium. The vocabulary is additive; the origin rule is the
part that would be expensive to loosen, and deliberately so.

---

## 2026-09-09 — A similar name creates a question, never a fact

**Decided:** Name matching produces a *candidate*, stored in its own column and
never read by analytics. Only a person, recorded by name and timestamp, can set
the column analytics reads. No input to the suggestion engine produces a
CONFIRMED status — the return type does not allow it, and the database would
refuse it regardless.

**Why:** `Wholesale Price` can be the cost of what sold, what was spent
restocking, the value of stock held, or the price charged to trade buyers. All
four are ordinary bookkeeping and each gives a different profit. Name matching
would be right most of the time, which is precisely the problem: right often
enough to be trusted, wrong often enough to be dangerous.

Keeping the candidate and the permission in **different columns** is what makes
this hold. A suggestion cannot be promoted by a bug or a careless `UPDATE`,
because there is no single column whose value changes the outcome.

Names that match *and* routinely mean something else — "Product Cost",
"Purchase Cost", "Net Sales" — are marked ambiguous and never given high
confidence, however exact the string match was. The name is the problem.

**Consequence, accepted deliberately:** The first import from a new source asks
more questions than a system that guessed would. A saved profile means it is
asked once, and a file that gains a column is asked about again.

**Cost to change:** Low to loosen, and it should not be loosened.
