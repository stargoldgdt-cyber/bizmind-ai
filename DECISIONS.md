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

## 2026-09-08 — `shadcn` kept as a runtime dependency

**Decided:** Left `shadcn` in `dependencies` where its installer placed it,
rather than moving it to `devDependencies`.

**Why:** `globals.css` imports `shadcn/tailwind.css`, so the package is needed
at build time, not only by the CLI. Moving it risks a broken production build
for a tidiness gain. Revisit if the CSS import is ever removed.

**Cost to change:** Low.
