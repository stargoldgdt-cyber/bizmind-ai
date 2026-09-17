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

> **Amended 2026-09-15.** Marketplace settlement files use marketplace adapters with
> built-in mapping rules and write to the ledger (see "The ledger is the financial
> source of truth"). This pipeline remains for spreadsheet datasets and the legacy model.

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

> **Amended 2026-09-15.** Currency is checked against the *marketplace account*, not the
> business; one business may hold AED and SAR accounts. Everything else stands.

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

> **Superseded 2026-09-15** by "COGS is one number with a dated history". The intent
> survives: editing a cost never silently changes past profit.

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

> **Deprecated 2026-09-15.** The health score is not carried into the marketplace product.

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

> **Superseded for the ledger model 2026-09-15.** No product-level apportionment of
> marketplace-level fees in V1 (decision A7). This entry describes the legacy model.

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

> **Amended 2026-09-15.** Still binding for spreadsheet datasets. How it applies to
> marketplace fee-mapping rules is open decision B2 (ARCHITECTURE_BASELINE.md).

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

---

## 2026-09-09 — The AI is checked, not trusted

**Decided:** Every reply from a language model is machine-checked before an
owner sees it. Each number in the reply is compared against the fact sheet the
model was given; a number that was not in that sheet means the whole reply is
**discarded**, not edited.

**Why:** A prompt saying "do not invent figures" is a request. This is the
enforcement, and the difference matters more here than anywhere else in the
product. If BizMind states a profit of 4,102.88 when it is 4,898.46, the owner
prices, buys and hires against a number that does not exist — and the mistake
is invisible, because the sentence around it reads perfectly well. A model is
extremely good at producing that sentence.

Discarding rather than repairing is deliberate. The invented figure is usually
load-bearing for the sentence containing it, and an owner reading a confident
paragraph has no way to tell which half to believe.

**The model is also given nothing to calculate with.** It never sees an order
or a line item — only figures already computed in SQL. Arithmetic is not merely
forbidden; there are no operands.

**Known limit, stated rather than hidden:** the allowlist is built from every
number in the fact sheet, so a small integer appearing anywhere in it is
allowed anywhere in the reply. That admits a stray count. It does not admit a
money figure or a percentage, which do not collide by accident — and those are
the ones that cost money. A test asserts this limit explicitly.

**Rejected:** Asking the model to return structured JSON with the figures
filled in. It reads safer and is not: the model would still be choosing which
value goes in which field, and a swapped pair of correct numbers is harder to
notice than an invented one.

**Cost to change:** Low to loosen, and it must not be loosened.

---

## 2026-09-09 — No OpenAI SDK

**Decided:** The AI layer calls the OpenAI REST API with `fetch`. The `openai`
package is not a dependency.

**Why:** This is one HTTP POST. A package would add supply-chain surface and a
second thing to keep current, in exchange for retry and streaming behaviour we
want to control ourselves — the timeout here exists because an owner is waiting
on a dashboard, not because a library chose a default.

It also makes the "one door" rule trivially checkable: a test greps the whole
source tree for `api.openai.com` and asserts exactly one file matches.

**Rejected:** The official SDK. Reasonable, and worth revisiting if BizMind
starts using streaming, tool calls or the assistants API — none of which V1
does, because V1 ships no autonomous AI actions.

**Cost to change:** Low. One file.

---

## 2026-09-09 — Explanations load after the page, never with it

**Decided:** The dashboard renders every figure server-side and complete. The
written explanation is fetched afterwards by a client component.

**Why:** An owner needs their revenue figure. They would like a paragraph about
it. Making the first wait on the second — and on a third party's availability —
gets the priority backwards.

It also makes degradation the normal path rather than an error path. No key, a
timeout, a rate limit, or a guard rejection all produce the same thing: the
dashboard, complete, with one line explaining why there is no paragraph. Every
one of those lines ends "Your figures above are unaffected", because silence
would invite the reading that something is wrong with the numbers.

**Cost to change:** Low.

---

## 2026-09-09 — When the AI wants a number, compute it

**Decided:** `cost_gap` and `fee_gap` — the share of order lines with no
recorded cost, and of orders with no recorded fee — are computed in SQL and
supplied to the AI layer as figures in their own right (migration 0010).

**Why:** Measured against a real model, the number guard rejected five
explanations out of eight. Every rejection was the same: given "cost coverage
is 75%", the model wrote "25% of order lines have no cost". Correct arithmetic,
and precisely what the guard exists to stop.

Adding an explicit instruction not to do it moved the pass rate from 3/8 to
3/8. The prompt was not the problem.

The problem was that BizMind had never computed a figure the explanation
genuinely needed. "25% of your order lines have no cost recorded" is the
sentence an owner acts on; "cost coverage is 75%" is the same fact phrased for
an analyst. With only the second available, deriving the first was the only way
to write a useful sentence — so the model kept doing it, and the guard kept
being right to refuse.

Supplying the gap took it to **8/8**.

**Rejected:** Computing the complement in TypeScript. It is not money, so it
sits in a grey area of the arithmetic rule — which is exactly why it should not
be done. A rule with a convenient exception is not a rule, and the next
exception would be easier to justify than this one.

**Also rejected:** Loosening the guard to tolerate a complement. That is the
same as allowing derived figures, which is the one thing this phase exists to
prevent.

**The general lesson, worth more than the feature:** when the AI reaches for a
number it was not given, that is evidence of a missing figure, not of a
disobedient model. Compute it.

**Cost to change:** Low.

---

## 2026-09-09 — gpt-5.6-terra, and proving which model answered

**Decided:** `DEFAULT_MODEL` is `gpt-5.6-terra`, set in one place and
overridable with `OPENAI_MODEL`. `ai:check` reads the model name from OpenAI's
**response** and fails if it does not match what was requested.

**Why the response and not the request:** a key that works proves nothing about
which model replied. A provider is free to serve a different or dated build
than an alias implies, and every explanation would then be written by a model
nobody chose — invisibly, because the prose would look the same.

**No temperature is sent.** The first attempt at this change failed outright:
`gpt-5.6-terra` accepts only its own default temperature and rejects any other
value. Sending a parameter BizMind does not need had tied the product to one
generation of model. The determinism that mattered never came from temperature
anyway — it came from computing the figures the explanation needs, so there is
nothing left to be creative about.

Measured: **6 of 6** narrations passed the number guard, every one answered by
`gpt-5.6-terra`.

**Cost to change:** Very low. One constant.

---

## 2026-09-09 — Corrected: PostgREST returns numbers, not strings

**Corrected, not decided.** This codebase asserted in three places that
PostgREST serialises `numeric` as a JSON **string**, and that typing money as
`string` therefore made accidental arithmetic in JavaScript impossible.

Both halves were wrong. Probing the live deployment:

```
{"revenue":0.1000,"cogs":0.30000000,"cost_gap":50.00}
```

Unquoted JSON numbers, carrying full scale. The **wire format is exact** — JSON
numbers are arbitrary precision by specification. `JSON.parse` is what narrows
them to IEEE-754 doubles, so by the time a figure reaches JavaScript it is a
`number`.

**What this is not:** a live defect. Nothing in this codebase does arithmetic on
money, every figure is rounded for display, and a double carries far more
precision than any realistic amount needs.

**What it is:** a safety net that was described as stronger than it is.
`revenue + cogs` is ordinary addition at runtime, not string concatenation. The
rule that all financial arithmetic happens in SQL still holds — it is enforced
by review and by tests, not by the type.

`Money` remains declared as `string`, which does not match the runtime value.
That mismatch is **recorded rather than quietly fixed**: correcting it touches
every consumer of every figure and deserves its own change, with its own tests,
rather than being folded into a task about something else.

**Found by:** writing a live contract test for migration 0010 that asserted the
documented type instead of assuming it. The assertion failed, which is exactly
what it was for.

**Cost to change:** Medium, and worth scheduling.

---

## 2026-09-09 — Money crosses the boundary as exact text, cast in SQL

**Decided:** Every money and ratio column is cast to `text` inside the
PostgreSQL function that produces it. The application receives exact decimal
strings — `"9007199254740993.0000"` — and never converts one to a number.

**Why here and not anywhere else:** the cast has to happen while the value is
still exact. `String(Number(value))` after `JSON.parse` would look like a fix
and be none: the precision is gone by then. SQL is the last point at which
every digit still exists, and `numeric::text` is lossless.

**The problem it fixes:** this codebase declared `Money = string` and claimed
PostgREST returned numerics as strings. It returned unquoted JSON numbers, and
`JSON.parse` narrowed each one to an IEEE-754 double. The type was a lie and
the promised safety did not exist.

**Structure:** three analytics functions were MOVED into a private
`analytics_core` schema with `ALTER FUNCTION … SET SCHEMA`, so their arithmetic
was carried across verbatim rather than retyped — nothing retyped means nothing
mistyped. Thin `public` wrappers cast their output. The three that build on
them read exact numerics from `analytics_core`, calculate in SQL as before, and
cast only their own output. `analytics_core` is not exposed through PostgREST,
so exactly one representation of a figure is reachable by application code.

**Rejected: `Money = number`.** It would have made the declaration truthful and
made the product worse — enshrining floating point as the financial
representation to avoid admitting the boundary was wrong.

**Rejected: computing the complement in TypeScript.** Same reasoning as the
coverage gap: convenient, and the start of a rule with exceptions.

**Counts stay `bigint`.** They are exact integers far below 2^53 and are
already declared `number`. Casting them would make the types lie the other way.

**Cost to change:** High to reverse, and it should not be reversed.

---

## 2026-09-09 — The type never prevented arithmetic; a scanner does

**Decided:** `scripts/verify-money-guard.ts` scans every source file for
arithmetic on a money-named field and fails the build. It runs in
`npm run verify`.

**Why:** `a + b` on two strings compiles and returns `"10002000"`. TypeScript
does not stop it and no declaration could. Claiming the type provides the
guarantee was the more dangerous half of the original mistake — a safety net
people believe in is worse than none.

The scanner tests itself against known-bad and known-good samples, so a regex
that quietly stopped matching is caught rather than silently protecting
nothing. It caught its own weakness twice while being written, and both
corrections are recorded in its comments.

**Three files are exempt, each with a stated reason.** An exemption without a
reason is how a rule stops applying.

**What it found, on its first run:**

- `.sort((a, b) => Number(b.revenue) - Number(a.revenue))` — replaced with
  `compareMoney`, which compares digit strings and converts nothing.
- `const rate = (refunds / revenue) * 100`, **printed to the owner in an
  insight title** — a financial figure calculated in floating point in
  TypeScript. Now `refund_rate`, computed in SQL.
- `percentChange()` in `format.ts` — computed a percentage in TypeScript, was
  unused, and was sitting inside an exempted file. Deleted.

**Cost to change:** Low.

---

## 2026-09-09 — The display layer formats the string, it does not convert it

**Decided:** `formatMoney`, `formatNumber` and `formatPercent` pass the exact
decimal string straight to `Intl.NumberFormat`, which accepts a string and
rounds it exactly.

**Why:** the boundary test caught this. Every layer preserved
9007199254740993.0000 — and the dashboard displayed
**AED 9,007,199,254,740,992.00**, because `format.ts` called `Number(value)`
before formatting. The database was right and the screen was wrong, which is
the failure the whole exercise exists to prevent, hiding in the last place
anybody would look.

An empty string now renders as "—" rather than being formatted: `Intl` turns
`""` into `0.00`, which would state that a figure nobody recorded is zero.

**Cost to change:** Low.

---

## 2026-09-09 — Shopify will be GraphQL-only, because REST is closed to us

**Decided:** The Shopify connector will use the GraphQL Admin API exclusively.

**Why:** this is not a preference. Shopify made the REST Admin API **legacy on
1 October 2024**, and **from 1 April 2025 every new public app must be built
exclusively on GraphQL**. BizMind has no Shopify app yet, so it is a new app.

A connector built on REST could not be listed, and the work would be discarded.
Every tutorial showing `/admin/api/2024-01/orders.json` is describing a door
that is closed to us.

**Consequences that follow, and none of them are small:**

- Rate limiting is a **calculated query cost** in a leaky bucket, not a request
  count. The client paces itself from `extensions.cost.throttleStatus`, which
  makes it adaptive without hard-coding the merchant's plan.
- Pagination is **cursor-based**; the cursor is the sync checkpoint.
- **New public apps must use expiring tokens and implement refresh.** A design
  assuming a permanent token does not pass review, so the connection record
  carries a refresh token and an expiry from the start.

**Version strategy:** pin one dated version in an environment variable and
upgrade deliberately. Versions ship quarterly with 12 months of support and 9
months of overlap, so a considered annual upgrade is comfortable. Tracking
"latest" would mean a silent schema change every quarter.

**Source:** shopify.dev, consulted 2026-09-09. References in
PHASE9_INTEGRATIONS.md §10.

**Cost to change:** N/A. There is no alternative.

---

## 2026-09-09 — The sync engine is built before the first connector

**Decided:** Phase 10's job table, claimer, retry and backoff are built and
tested against a **fixture connector** in the repository, before either real
connector exists. This inverts the phase numbering on purpose.

**Why:** the engine can then be proven with no credentials, no vendor account,
no network and no approvals — none of which are under our control. The first
real connector plugs into something already known to work, so a failure during
the Shopify OAuth dance is a Shopify problem rather than a question about which
of two new systems is wrong.

It also means WooCommerce goes first among the connectors: a key and a secret,
no OAuth, no app review, no Shopify approvals, and testable against a local
install. It will find the mapping bugs cheaply.

**Queue:** PostgreSQL with `FOR UPDATE SKIP LOCKED`, driven by Vercel Cron. No
queue provider is introduced until something requires one. Work must be
resumable at any point, which the durable cursor already provides, so a
serverless time limit truncates progress rather than losing it. Moving to a
real queue later replaces the claimer and leaves the connectors untouched.

**Cost to change:** Low, which is the point.

---

## 2026-09-10 — The session-less write path: two confined modules, not a key

**Decided:** Webhook receipt and background sync use the Supabase service-role
key, confined to two modules under `src/services/integrations/security/`.
`privileged.ts` never exports the client; it exports `callTrusted()`, which
can only reach an allowlist of SECURITY DEFINER functions that each derive
their own tenant — and which **refuses any call carrying a business id**.

**Why the key at all:** a webhook arrives with no signed-in user, so RLS keyed
on `auth.uid()` cannot resolve the tenant. `write_audit_log()` does not merely
fail to help — it raises `28000 Not authenticated`, so the path could not even
record what it did.

CLAUDE.md forbids the service-role key for serving a *user request*. That rule
is not bent: a verified vendor callback and a scheduled worker are background
jobs, which is the case it explicitly allows.

**Why so narrow:** the key bypasses RLS completely, so a module that hands out
a general-purpose privileged client turns every future mistake into a
cross-tenant one. The allowlist is enforced at runtime as well as in the type,
because a type is erased and this is the one place where being wrong is
expensive. A test asserts the key appears in exactly those two files.

**Rejected: verifying HMAC inside PostgreSQL** so the endpoint could be reached
by `anon` with no privileged key at all. It is genuinely attractive — the
secret would never enter application memory. It was rejected because the
credential is encrypted with a key held OUTSIDE the database, deliberately, so
the database cannot decrypt it; and because Postgres has no constant-time
comparison, which would trade one class of attack for another.

**Rejected: SECURITY DEFINER wrappers callable by `authenticated`.** Any
customer with a login could then forge a delivery into any business on the
platform.

**Cost to change:** Medium. The boundary is one file.

---

## 2026-09-10 — Connection identity is the provider's own stable id

**Decided:** `integration_accounts.external_account_id` holds the provider's
permanent name for a store — a `myshopify.com` domain, a WooCommerce site URL.
Connecting is an upsert on `(business_id, integration_id, external_account_id)`
and the channel is carried across.

**Why:** reconnecting a store must not create a second channel. If it did, one
store's history would be split in two and every figure that groups by channel
would quietly halve — with no error, and nothing on screen to suggest anything
was wrong. That is the shape of bug this product exists to not have.

**A live store belongs to exactly one business**, enforced by a partial unique
index on `(integration_id, external_account_id) where status <> 'DISCONNECTED'`.
Without it the same shop could be connected by two customers and a webhook
would resolve ambiguously — a cross-tenant leak wearing the costume of a
feature request. Partial, so a store can be disconnected and later connected by
someone else.

**Cost to change:** High. It is the reconnection key and the webhook lookup key.

---

## 2026-09-10 — Credentials are encrypted with a key the database does not have

**Decided:** AES-256-GCM from Node's own `crypto`, with the key in
`BIZMIND_ENCRYPTION_KEY`. Every ciphertext is bound to
`business_id` + purpose as additional authenticated data.

**Why GCM:** it authenticates as well as encrypts, so a tampered ciphertext
fails to decrypt rather than decrypting to something attacker-influenced.

**Why the AAD binding:** the attack worth defending against is not "read the
secret" but "move a valid secret to a row where it authorises something else".
A ciphertext carried across tenants fails authentication.

**Why the key is not in the database:** so a database backup on its own does
not yield a usable credential for somebody else's store.

**Also decided:** `authenticated` is granted privileges on
`integration_accounts` column by column, with the two credential columns left
out. RLS decides which rows are visible; a column grant decides which columns.
Without it an owner could read their own encrypted tokens through PostgREST —
and "encrypted" is not "safe to hand to a browser".

**Corrected during installation.** The first version granted SELECT on the
whole table and then revoked two columns. In PostgreSQL that is a no-op: a
column-level REVOKE cannot remove a table-level GRANT. The credentials were
readable, and the code read as though they were not.

The migration's own verification block refused to install it —
`SECURITY: authenticated can read integration_accounts.credentials_encrypted`.
That is the argument for asserting privileges inside a migration rather than
trusting that the statements above did what they appear to do. The fix is a
grant list, so forgetting a column hides it rather than exposing it.

**Cost to change:** Rotating the key invalidates every stored credential.

---

## 2026-09-10 — The engine was built before any connector, against a fixture

**Decided:** The sync and webhook engine, and a deterministic fixture
connector, were built and tested before Shopify or WooCommerce. This inverts
the phase numbering deliberately, as ROADMAP.md predicted it should.

**Why:** OAuth approvals, developer accounts and store provisioning are outside
our control and take days. The retry schedule, the idempotency guarantee and
the tenant boundary are not, and they are the parts that must be right.

The fixture connector produces every failure a real provider will inflict — a
rate limit, a 500 that clears, a revoked token, a repeated record, a partial
page, a forged signature — on demand, with no network and no credentials. The
scenarios that clear on the SECOND attempt are the valuable ones: they let a
test assert the engine recovered, not merely that it gave up politely.

So the first real connector debugs one system rather than two.

**It is not a fake integration and produces no production data.** It uses
`channelType: "OTHER"` rather than a new enum value, because a test-only
concept has no business widening a production enum that analytics groups by.

**Cost to change:** Low. It is one directory and it can stay forever as a
regression harness.

---

## 2026-09-10 — What installing the migration actually found

**Recorded because the pattern matters more than the four bugs.**

Migration 0012 passed review, passed 462 offline assertions, typechecked,
linted and built. Installing it against a real database found **five** faults
in four attempts, and every one of them read as correct:

1. **A record variable in a multi-item `INTO` list** (42601). Caught by
   PostgreSQL itself.
2. **A column-level `REVOKE` that cannot undo a table-level `GRANT`.** The
   credentials were readable and the code said they were not.
3. **Privileges inherited before the migration ran.** Supabase's
   `alter default privileges` grants ALL on every new table, so declining to
   grant was never enough — the privilege had to be taken away.
4. **A uniqueness rule that did not exist.** The index was keyed on
   `integration_id`, which is per-business, so "one live store belongs to one
   business" was enforced against nothing. With `webhook_account_lookup()`
   ending in `LIMIT 1`, a shop connected twice would have delivered into
   whichever tenant the planner returned first.
5. **A `CASE` of bare literals is `text`, not an enum** (42804). Every webhook
   delivery failed on it.

Two were found by the migration's own verification block refusing to install.
Two were found by the live test suite. **None would have been found by
reading.**

**The conclusions worth keeping:**

- A migration should assert its own guarantees rather than trust that its
  statements did what they appear to do. Faults 2 and 3 were caught that way,
  and both were security holes.
- A privilege model must be tested against a real database with a real second
  tenant. Fault 4 was invisible to every other kind of check.
- The database's own HINT can be wrong for the situation. When `sync_enqueue`
  failed, PostgreSQL suggested
  `GRANT SELECT ON integration_accounts TO authenticated` — which would have
  undone fault 2's fix entirely. A generic hint does not know two of those
  columns are secret.

**Cost to change:** N/A. This is a record, not a decision.

---

## 2026-09-10 — WooCommerce leaves four fields null, on purpose

**Decided:** The WooCommerce connector maps `subtotal`, `fee_total`,
`unit_cost` and the per-line `discount` to NULL, even though a plausible number
could be assembled for each.

**Why:**

- `subtotal` would be `total - total_tax - shipping_total + discount_total`.
  That is arithmetic on money in TypeScript, which MONEY.md forbids outright.
- `unit_cost` **does not exist in WooCommerce core.** There is nothing to map.
- `fee_total` would be a sum of `fee_lines` — both a sum, and a claim about
  meaning that nobody has established. Phase 7.2's rule applies: a field is not
  a fee because it is called one. WooCommerce has no marketplace and therefore
  no marketplace fee.
- The line `discount` would be `subtotal - total`. A subtraction.

**The consequence, accepted deliberately:** gross profit and margin are
OVERSTATED for every WooCommerce order until costs arrive another way. That is
not a defect of the connector; it is the truth about what WooCommerce knows.
The cost-coverage figure already says so on every screen showing a margin, and
the AI refuses to recommend anything resting on it.

A connector that filled those nulls with arithmetic would produce a margin that
looks right and is not — which is the exact failure this product exists to
avoid, arriving through the one door nobody was watching.

**Cost to change:** Low, and it should not change. If cost data becomes
available from a plugin, it arrives as its own mapped field with its own
semantics confirmation.

---

## 2026-09-10 — A store URL is untrusted input that we then fetch

**Decided:** `checkSiteUrl()` refuses loopback, private ranges, link-local
(including `169.254.169.254`), `.local`, `.internal`, embedded credentials, and
anything not HTTPS. Redirects are not followed.

**Why:** a connection form that takes a URL and fetches it is a server-side
request forgery hole. An owner who types `http://169.254.169.254` is confused;
an attacker who types it is asking our server to read its own cloud credentials
and hand them back in an error message.

Not following redirects matters for a second reason: a redirect would carry the
`Authorization` header — the merchant's own consumer secret — to a host they
never named.

**Plain HTTP is refused rather than supported through OAuth 1.0a**, which
WooCommerce documents for exactly that case. Supporting it would be effort
spent making an insecure configuration usable, and the merchant would be worse
off for our helpfulness.

**Known limit, stated:** the check is on the literal host, not a resolved
address, so DNS could point a public name at a private one. Blocking that
properly needs resolution at request time. What bounds the damage today is that
BizMind only ever sends a store's own credentials to the host its owner named,
and never reflects a response body back to them.

**Cost to change:** Low.

---

## 2026-09-11 — The Google Picker's browser key is the one API key in the browser

**Decided (by the owner):** the Google Picker's browser API key,
`NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`, is sent to the browser. It is the single
agreed exception to "no API keys in the frontend".

**Why:** with the `drive.file` permission (approved decision 1), BizMind can
open only files the owner picks in Google's own picker, and Google's picker
does not run without a browser key — Google's sample says requests fail with
"API developer key is invalid" otherwise. The alternative, pasting a link,
would need permission to read every spreadsheet in the owner's Drive: a
sensitive scope that needs Google's review and shows customers a stronger
warning.

**What keeps it safe:**

- In Google Cloud the key is restricted to the **Google Picker API only**, and
  to BizMind's own web addresses plus `https://docs.google.com/*`, where the
  picker runs. Anywhere else Google refuses it.
- On its own it reads nothing. Opening a file needs the owner's Google sign-in,
  and the lasting authorisation (the refresh token) never leaves the server.
- The picker's short-lived access token is held in memory while connecting and
  sent only to BizMind's own server actions. It is never stored.

A test fails the build if any other `NEXT_PUBLIC_GOOGLE_*` value appears, or if
browser code mentions a refresh token, a stored credential or the client
secret.

**Cost to change:** Low. Swapping the key is an environment change; dropping
the picker means revisiting the scope decision.

---

## 2026-09-15 — BizMind becomes a GCC Marketplace Profit Intelligence Platform

**Decided:** BizMind is repositioned from an order-centric business intelligence
layer to a GCC marketplace profit intelligence platform (Amazon, noon,
Carrefour). Not an ERP, not a traditional accounting system. The approved
baseline is `ARCHITECTURE_BASELINE.md`.

**Why:** A real seller's settlement files showed the question that matters —
which marketplace and which product actually make money — cannot be answered
from an order total and one fee column.

**Cost to change:** High. Every later phase builds on the ledger.

---

## 2026-09-15 — The ledger is the financial source of truth

**Decided:** One immutable row per reported amount in `financial_transactions`,
with source rows, settlements and payouts beside it. Exactly one writer,
`ledger_apply_file()`. No UPDATE or DELETE for any role, including the service
role; a trigger enforces it. Composite foreign keys make every reference carry
its business id, so a row cannot point into another tenant even through a bug.
Deleting a whole business still removes everything.

**Why:** A figure that can be edited in place cannot be traced, and a trace is
the product's promise: dashboard figure → transaction → source row → file.

**Cost to change:** High.

---

## 2026-09-15 — A source file is its fingerprint and its parsed rows (B6)

**Decided:** The ledger keeps a file's SHA-256 fingerprint and every parsed row
(as text, blank as null, customer data removed). The original uploaded bytes are
not stored.

**Why:** The rows are the evidence every figure needs, and a stored original file
would bring buyer details BizMind has decided never to hold.

**Cost to change:** Low to add file storage later; the fingerprint already
identifies the file.

---

## 2026-09-15 — Financial permissions (B11)

**Decided:** VIEWER reads. STAFF imports, but cannot confirm SKU mappings,
change COGS or confirm anything financial. ADMIN imports, confirms SKU mappings,
manages COGS and expenses. OWNER has every financial, integration,
reconciliation and configuration permission. Enforced inside each database
function. Ledger file withdrawal stays OWNER/ADMIN, as legacy withdrawal is.

**Why:** Importing is routine work; confirming what a number means is not.

**Known gap:** The existing Google Sheets connect functions allow ADMIN, where
B11 reserves integrations for OWNER. Left unchanged in Phase 1 (it is outside
the phase); to be aligned when the Sheets target layer is rebuilt (Phase 5).

---

## 2026-09-15 — Currency belongs to the marketplace account

**Decided:** `marketplace_accounts.currency` is the currency of everything
recorded against the account, and it locks once data exists. A row in another
currency is refused. No conversion in V1.

**Why:** Amazon.ae and Amazon.sa settle in different currencies; converting
would require an exchange rate, and inventing one would invent a figure.

---

## 2026-09-15 — COGS is one number with a dated history (built in Phase 4)

**Decided:** The seller enters one COGS per unit. Each change is a new dated
version; profit uses the cost in force on each sale's posted date.

**Why:** Settlement files carry no cost, so the rule "cost only from the order
line" would leave every marketplace sale without one. Dated versions keep the old
rule's point — past profit never moves silently.

---

## 2026-09-15 — No customer data in the new model (A14)

**Decided:** No buyer name, email, phone or address in `source_rows`, the ledger
or any new table. Filtered at the adapter boundary against an allow-list, and
refused again in the database (column-name rule and email detection).

**Why:** BizMind does not need to know who bought something to know what it
earned, and holding buyer details would be a liability with no benefit.

**Limit, stated:** a pattern cannot recognise a person's name typed into a free
description. The structural protection is the column allow-list.

---

## 2026-09-15 — Google Sheets is an optional data layer (A2–A5)

**Decided:** The Sheets transport stays as built. Its targets move to datasets:
COGS, product master and operating expenses in V1; advertising and bank
transactions optional; SKU mappings as suggestions only. Manual adjustments are
native only. BizMind may write only to spreadsheets it created for an export. No
two-way sync in V1.

**Why:** Sellers already keep costs and expenses in sheets; the ledger must stay
a record of what marketplaces reported.

---

## 2026-09-15 — Marketplace-level costs stay marketplace-level (A7)

**Decided:** Fees and advertising without reliable SKU attribution are not spread
across products in V1.

**Why:** An allocation presented as a product's cost is a guess shaped like a fact.

---

## 2026-09-15 — Adapters: Amazon Flat File V2; noon waits; Carrefour is a contract

**Decided:** Amazon builds against `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`
(the XML and V1 flat-file settlement reports are deprecated by Amazon); the
summary export is never a financial source. Noon's mapping waits for real sample
files. Carrefour stays a contract until its capability is verified — no Mirakl
assumption.

---

## 2026-09-15 — VAT treatment is configuration, not computation (A11)

**Decided:** Each account has a tax profile whose only treatment is
`UNCONFIGURED` until an accountant confirms one. New treatments arrive by
migration, not by a form. Tax lines are recorded on their own ledger side.

---

## 2026-09-15 — The rules table is `ledger_mapping_rules`

**Decided:** The Phase 1 request listed `fee_mapping_rules`; the approved
baseline names the table `ledger_mapping_rules`, and that name was kept.

**Why:** The rules classify cash, tax and memo lines as well as fees. A table
called "fee" rules would mislead the first person to add a payout rule.

---

## 2026-09-15 — Payouts reference their source row, not a ledger line

**Decided:** The baseline listed `payouts.source_transaction_id`. Phase 1 stores
`source_file_id` + `source_row_id` instead, and ledger lines reference their
payout.

**Why:** A ledger line points at its payout. A payout pointing back at a ledger
line would be circular, and one side could only be filled in by updating an
immutable row. Lineage is unchanged: the payout still traces to its source row.

---

## 2026-09-15 — WooCommerce deprecated, not deleted (A13)

**Decided:** The WooCommerce connector is hidden and not extended. Its code and
tests stay until removal is separately approved.

---

## 2026-09-15 — Amazon fee rules approved by the owner (B2, B3)

**Decided:** The 21 Amazon Flat File V2 rules are GLOBAL data seeded by
migration 0031, `SAMPLE_VERIFIED` against four real Amazon.ae settlements, with
the evidence on each rule. The owner confirmed:

- **Premium Services Fee** is the Amazon Selling Partner 360 (SP 360) fee: a
  marketplace fee at marketplace level, not advertising.
- **Tax on fee** is a separate VAT line (TAX · FEE_VAT). Whether it counts in
  profit: see B1, decided later the same day.
- **COD charge** is other income, not sales; the COD fee is a marketplace fee.
- A settlement's header row gives the **payout Amazon reports** (its total and
  deposit date). Matching it to the bank stays in Phase 6.

**Why:** These are the codes in the owner's real files, and each settlement
reconciled exactly under them. A code not covered stays UNMAPPED rather than
being guessed.

---

## 2026-09-15 — A changed settlement is refused, not replaced (B8)

**Decided:** The default stands. Uploading a settlement id already counting in
the account, with different content, is refused, naming the file that holds it.
The owner withdraws the old file first.

**Why:** Replacing silently would change figures already seen, and the ledger
never edits a row.

---

## 2026-09-15 — Settlement files are uploaded as the marketplace provides them

**Decided:** Ledger files may be `.txt` (Amazon's report). Any cell a
spreadsheet turned into a non-text value makes the upload refused, and the
Amazon adapter refuses comma decimals and dates without a time.

**Why:** Re-saving a report in a spreadsheet can reformat dates and amounts in
ways that cannot be reliably reversed.

---

## 2026-09-15 — VAT on marketplace fees is not a P&L expense when recoverable (B1)

**Decided by the owner:**

- UAE marketplace service fees may include 5% VAT; Saudi fees may include 15%.
- When that VAT is legally recoverable as input VAT through the company's VAT
  return, it is **excluded from P&L**. It is recorded separately on the tax
  ledger as input VAT, and is never counted as marketplace cost, operating
  expense, advertising expense or revenue.
- When the VAT is not recoverable, it is an expense, on its own line rather
  than folded into the marketplace fee.
- **Unknown is the default.** While the treatment is unknown, BizMind does not
  assume zero and does not assume expense. P&L contribution is shown as
  incomplete (requiring a VAT treatment), never as a final figure, with the
  warning "VAT treatment unknown: AED <amount>" and a data-quality warning.
  The contribution excluding that VAT may be shown only as an informational
  "Contribution before fee-VAT treatment".
- The separation is kept: P&L = economic profit and cost; tax ledger = VAT and
  input VAT; cashflow = actual cash movement; settlement = the marketplace's
  calculation; payout = the payment the marketplace reports; bank = the actual
  receipt.

**July 2026 example (Amazon.ae), contribution before COGS and operating
expenses, AED 119.79 VAT on the SP 360 fee:**

| Account's fee-VAT treatment | Final P&L contribution | Shown |
| --- | --- | --- |
| Unknown (default) | None — incomplete | "VAT treatment unknown: AED 119.79"; informational "Contribution before fee-VAT treatment: AED 36,552.76" |
| Recoverable | **AED 36,552.76** | Warning gone; AED 119.79 is input VAT on the tax ledger |
| Not recoverable | **AED 36,432.97** | AED 119.79 as a separate non-recoverable VAT expense line |

The owner describes this VAT as recoverable. July reads AED 36,552.76 as final
only once the owner marks the Amazon.ae account Recoverable.

**How it is applied:**

- The treatment is set per marketplace account on its tax profile (a UAE and a
  Saudi account can differ), by the owner, once confirmed by their accountant.
  It is never inferred from registration, country or rate, and BizMind never
  calculates VAT from a rate: it uses the VAT the marketplace reports.
- Existing `TAX · FEE_VAT` ledger lines are the input VAT on marketplace fees.
  The code stays `FEE_VAT` (ledger rows are immutable and the category list is
  closed); screens call it "Input VAT". Changing the treatment never changes a
  ledger row.
- Not covered by this decision: VAT charged on sales (`OUTPUT_VAT`). It stays
  on the tax ledger, apart from revenue, as before.

**Why:** Recoverable input VAT is reclaimed from the tax authority, so it is not
an economic cost of selling. Counting it would understate profit; silently
dropping it when recoverability is unconfirmed would overstate it, which is
why an unknown treatment leaves the contribution incomplete rather than final.

**Supersedes:** the B1 default ("tax lines excluded from profit, with a 'not
confirmed' banner").

---

## 2026-09-15 — Marketplace lines are classified automatically; people handle exceptions only

**Decided by the owner:** A seller never classifies normal marketplace lines.
Uploading a file detects the marketplace and format, and the adapter's rules
classify every known line automatically.

- High-confidence rule: classified and counted.
- Medium-confidence rule: classified and counted, flagged for review.
- No rule, a new code or a genuinely ambiguous line: kept as Unknown, shown in
  Data Quality, and the rest of the file continues.
- A file is refused only for structural reasons: wrong or unsupported report,
  wrong marketplace, currency mismatch, customer data that cannot be removed,
  or a changed settlement (B8).

The owner validates the live dashboard against the marketplace reports and
reports mismatches; each becomes a rule correction.

**Why:** Asking sellers 20–30 classification questions per upload makes the
product unusable, and the marketplace's own codes already say what most lines
are. The product foundation and a working dashboard come first; real-data
validation corrects the rules afterwards.

---

## 2026-09-15 — Four-layer classification model

**Decided:** Every marketplace line is classified as Financial Type (Revenue,
Expense, Tax, Cash, Memo) → Category → Subcategory → P&L Treatment (Increase
Revenue, Decrease Revenue, Increase Expense, No P&L Impact, Conditional). The
full table is in ARCHITECTURE_BASELINE.md §C "Automatic classification".

- The type records what the marketplace reported; the treatment records how it
  affects profit. Non-recoverable VAT stays Tax / Input VAT with treatment
  Increase Expense; recoverable VAT has No P&L Impact; unknown VAT is
  Conditional and leaves the P&L incomplete (B1).
- Reversals keep the original category; refunds of sales reduce revenue;
  payouts are Cash.
- Marketplace-reported totals and results are Memo cross-checks. Percentages
  and labels are not imported. Seller cost data is COGS input.

**Why:** Tax cannot simply mean "never affects profit", and a category alone
cannot say whether money raises or lowers profit. Metrics are defined once over
categories and treatments, with no Amazon- or noon-specific formulas.

---

## 2026-09-15 — Classification is applied at calculation time

**Decided:** Ledger lines keep the marketplace's facts and are never edited.
Metrics classify each line through the active rule version when they are
calculated. A correction retires the old rule version and adds a new one; every
later calculation uses it for all periods, with no re-upload. BizMind shows a
correction's effect before it applies, and the audit log records it. The side
and category stored on ledger lines in Phases 1–2 remain the import-time record.

**Why:** Corrections found during validation must reach past months without
rebuilding the financial engine or editing an immutable ledger.

---

## 2026-09-15 — Unknown lines make the figures they affect Incomplete

**Decided:** A figure is Final only when no Unknown line, unresolved Conditional
line or unreadable row affects it. Otherwise it is shown as Incomplete, with the
exact unclassified amount and the reason. It is never shown as zero or estimated.

**Why:** Leaving an unknown fee out silently overstates profit — the same reason
unknown VAT leaves the contribution incomplete (B1).

---

## 2026-09-15 — Owners and admins may classify an Unknown code for their business (B2 amended)

**Decided:** Rules are normally BizMind's, global and versioned. For an Unknown
code only, an owner or admin may classify it for their own business. The choice
is audited, marked as confirmed by the seller, and never overrides a
high-confidence BizMind rule.

**Why:** A seller should not wait for a BizMind release to classify a fee only
their account has, but seller choices must not quietly replace verified rules.

---

## 2026-09-15 — Dashboard before COGS, expenses and reconciliation

**Decided:** New phase order:

3. Automatic classification + P&L engine (Amazon)
4. Live dashboard + validation view
5. noon adapter
6. Products, SKU mapping, dated COGS
7. Expenses + Google Sheets dataset targets
8. Payouts, bank, reconciliation, cashflow, reports
9. AI explanations + alerts
10. Legacy retirement

Owner validation runs from Phase 4 onward. Until Phases 6 and 7, Gross Profit
and Net Profit show Incomplete.

The noon sample files required by A17 were supplied on 2026-09-15. The noon
Invoices & Credit Notes file names every statement fee with its VAT listed
separately (Referral Fee and its adjustment, FBN Outbound, Directship Outbound
and its rebates, Advertising, Return Administration, Damaged Returns, Warranty,
Cancellation, Import VAT Recovery, Shipping Fee Rebate), so noon can be
classified automatically in Phase 5.

**Why:** A working product the owner can check against real reports finds rule
problems sooner than further design discussion.

---

## 2026-09-15 — Marketplace take rate is not defined yet (B15)

**Decided:** No take rate is defined or shown, and no replacement KPI is created.

**Finding:** The owner's historical 19.1% ("Blended take rate" in the gap
analysis acceptance table) has no recorded formula. Tested against the July 2026
Amazon ledger lines (gross sales AED 61,429.11): commission plus FBA fulfilment
is 18.62%; four different combinations of small additional costs reach
19.06%–19.12%; all fees except SP 360 and advertising give 19.20%, or 19.03%
without the COD fee. The exact historical formula cannot be proven from the
available data.

**Supersedes:** the Phase 2 note that 19.1% was "19.03% or 19.20% depending on
whether COD lines count" — neither rounds to 19.1%.

---

## 2026-09-16 — How Phase 3 implements automatic classification

**Decided while building (migration 0032):**

- **Classification rules are their own versioned table** (`classification_rules`),
  separate from `ledger_mapping_rules`. Import rules still decide what is
  written (quantity, attribution); classification rules decide what money
  means when figures are calculated. A correction touches only the latter.
- **A line's match key** is its three stored source codes joined with "|", so
  lines recorded before Phase 3 are classified without being touched.
- **Precedence:** a HIGH BizMind rule, then the business's own classification,
  then a MEDIUM BizMind rule. A business may classify only a code BizMind does
  not classify and that appears in its own files.
- **Signs:** amounts keep the marketplace's sign from the seller's view, so each
  figure is a signed sum and reversals net off without special cases.
- **Periods** are half-open on the line's posted time, in UTC. Figures are per
  marketplace account and never combined across currencies (A12).
- **Figures and data quality are calculated, not stored,** so a rule change or
  VAT setting change is reflected immediately and closes its own warnings.
- **An unknown line makes every figure for its account and period Incomplete**,
  since its category is unknown; unresolved VAT affects contribution only.

**Why:** Each choice keeps the ledger untouched and lets validation corrections
reach past periods without re-uploads or engine changes.

---

## 2026-09-17 — The ledger dashboard lives at /ledger, beside the legacy pages

**Decided (GCC Phase 4):**

- The marketplace dashboard is **Marketplaces → Marketplace profit** (`/ledger`),
  with `/ledger/lines` and `/ledger/quality`. The legacy `/dashboard`, `/profit`
  and `/data-quality` stay unchanged until legacy retirement (Phase 10).
- The period is one calendar month in UTC, matching the engine. Account and
  month live in the URL.
- An incomplete contribution is shown as the word "Incomplete"; its
  informational figure always carries "not final" and a label saying what it
  excludes (B1). The VAT warning reads "VAT treatment unknown: <amount>".
- A settlement is listed for a month when any of its lines is posted in it or
  its own period overlaps it, with its total compared against all its lines
  and the part that counts in the month shown separately.
- The validation export writes every figure exactly as SQL produced it,
  leaves an incomplete contribution blank with the word Incomplete, and
  neutralises text a spreadsheet would evaluate. It is never cached.
- Classifying an unknown code shows its effect (lines and amounts per account
  and month) before it is confirmed; the business's own classifications are
  listed with Undo.

**Why:** The owner validates the product against real marketplace reports;
every figure must open into its lines and export exactly, and nothing
unfinished may look final.

---

## 2026-09-17 — How noon is read (GCC Phase 5)

**Decided, from the owner's real July 2026 exports (NOON.md):**

- **Two reports, both required per period:** the Transaction View (item
  level) and Invoices and Credit Notes. Each is recognised by its exact
  headings.
- **VAT is taken from noon's invoices, never calculated.** Transaction View
  fees include VAT. Each statement-fee invoice line becomes two lines that add
  to zero: the stated VAT back into the fee's category, and the same VAT as
  Input VAT. Import VAT Recovery moves its whole amount the same way. Until a
  period has its invoices, contribution is incomplete
  (`FEE_VAT_NOT_SEPARATED`), unless the account's VAT setting is
  Non-recoverable.
- **Sales stay as noon reports them.** Customer invoices and credit notes add
  only Output VAT, on the tax side.
- **Dates** are calendar days (no time in the files), kept as 00:00 UTC.
- **A zero amount adds no line.** A row whose amounts are all zero is kept as a
  warning.
- **Rows in another currency** (the "Noon SA" contract) are warnings in this
  account and are counted when the file is uploaded to the matching account.
- **Order updates** count with product sales, signed, under review (they mix
  returns and later changes). **Balance transfers** are cash, under review,
  until their purpose is confirmed (B4).
- **Overlapping exports are refused** for every marketplace: a file repeating a
  row already counted for the account, or a restore that would do so, names
  the file that already holds the row.
- **All accounts in one currency** can be added up (dashboard: "All AED
  accounts"), never across currencies.

**Why:** noon exports cover date ranges rather than settlements, state VAT
only on invoices, and mix two contracts in one file. Each rule keeps the
figures exact, keeps unconfirmed meanings visible, and never counts a row twice.
