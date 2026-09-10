# CLAUDE.md — Permanent development instructions for BizMind AI

Read this file before doing anything in this repository. It outlines what
BizMind is, how it must be built, and what must never be done. It outranks
habit and outranks any pattern you remember from other projects.

Also read `AGENTS.md` — Next.js 16 writes framework-specific rules there, and
this version differs from older Next.js in ways that matter.

---

## 1. The product

**BizMind AI** is an AI business intelligence and automation layer.

> Your ERP records what happened. BizMind tells you what to do about it.

It is **not** an ERP, not a dashboard tool, not a chatbot, not an accounting
system. It sits *on top of* the systems a business already runs (Shopify,
WooCommerce, marketplaces, spreadsheets, ERPs) and turns their data into
decisions.

The loop the whole product serves:

```
CONNECT → UNDERSTAND → ANALYZE → ALERT → RECOMMEND → AUTOMATE
```

Traditional tools do `Data → Report`.
BizMind does `Data → Understanding → Insight → Recommendation → Action`.

**Users are business owners and operators, not analysts.** Every screen should
answer "what do I do about this?", not just "here is a number".

### Who the repository owner is

The product owner is a **non-technical founder**. When reporting work:

- Explain in plain language, not jargon.
- If a manual step is needed, give exact click-by-click instructions and stop
  for confirmation before continuing to anything that depends on it.
- Do the work yourself whenever it can be done safely from the terminal.
- Never ask him to hand-write code.

---

## 2. Technology stack

Locked in. Do not add alternatives without an entry in `DECISIONS.md`.

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript, `strict` |
| UI | Tailwind CSS v4 + shadcn/ui on Radix primitives |
| Icons | lucide-react |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth |
| Authorization | PostgreSQL Row Level Security |
| Validation | Zod |
| AI | OpenAI API |
| Hosting | Vercel |
| Package manager | npm |

Keep dependencies few and justified. A new dependency needs a reason recorded
in `DECISIONS.md`.

---

## 3. Next.js 16 rules that bite

This version removed things older tutorials still teach.

- `cookies()`, `headers()`, `draftMode()`, `params` and `searchParams` are
  **async**. Always `await` them. Synchronous access no longer works at all.
- **`middleware.ts` is deprecated — the file is now `proxy.ts`** and the
  exported function is `proxy()`. It runs on the Node.js runtime; the edge
  runtime is not supported there. This matters for auth in Phase 2.
- Turbopack is the default bundler.
- Use the generated `PageProps<'/route'>`, `LayoutProps<'/'>` and
  `RouteContext<'/route'>` helpers for typing route files.
- `revalidateTag` now requires a `cacheLife` profile as its second argument.

When unsure about framework behaviour, read `node_modules/next/dist/docs/`
rather than relying on memory.

---

## 4. Multi-tenancy — the hard security boundary

BizMind is multi-tenant SaaS. **Business A must never see Business B's data.**
This is the single most important rule in the codebase.

```
User → Business Member → Business → Business Data
```

Non-negotiable:

1. Every business-owned table carries a `business_id`.
2. **Row Level Security is enabled on every such table.** RLS is the security
   boundary, not a nice-to-have.
3. Never rely on frontend filtering, or on remembering to add a `WHERE` clause,
   for tenant isolation. The database must refuse cross-tenant reads even if
   application code is wrong.
4. Never use the Supabase **service-role key** to serve a user request. It
   bypasses RLS. It is for trusted background jobs only, and never reaches the
   browser.

   Two such jobs exist: the webhook receiver and the sync worker, neither of
   which has a session. The key is confined to two modules under
   `src/services/integrations/security/`, `callTrusted()` can only reach
   tenant-resolving functions, and **a call carrying a business id is
   refused** — because those functions derive their own tenant and there must
   be no parameter to point at another one. A test fails the build if the key
   appears anywhere else. See INTEGRATION_ENGINE.md.
5. Every new table needs its RLS policy written in the same migration that
   creates it.

Roles: `OWNER`, `ADMIN`, `STAFF`, `VIEWER`. Model permissions so finer-grained
ones can be added later without a rewrite.

---

## 5. AI rules — the most dangerous part of this product

**The AI must never invent, estimate, or calculate a business number.**

If BizMind tells an owner their profit is X and X is wrong, the product is
worse than useless — it is harmful. So:

| Responsibility | Owner |
| --- | --- |
| Calculating revenue, COGS, margin, profit, inventory, scores | **Backend / SQL** |
| Aggregation and data validation | **Backend** |
| Explaining a number in plain language | AI |
| Summarising, prioritising, recommending | AI |

The pattern is always: **compute first, then narrate.**

```
User asks → backend computes verified figures → figures passed to AI
          → AI explains those exact figures → response
```

Rules:

- Never let a model produce a figure that was not computed by our own code.
- Pass computed values into the prompt; never ask the model to do arithmetic on
  raw rows.
- All OpenAI access goes through the AI service layer. No `openai` import
  anywhere else in the codebase.
- Every AI feature must degrade safely: if the model is unavailable, the
  underlying numbers must still display.

---

## 6. Security rules

- **Secrets live in environment variables. Never in source, never in the
  browser.** No API key, service-role key, access token, or password is ever
  committed or shipped to the client.
- Any variable prefixed `NEXT_PUBLIC_` is visible to the world. Only put
  genuinely public values there.
- Validate every input crossing a trust boundary with Zod — request bodies,
  query params, webhook payloads, imported spreadsheet rows.
- Authorize on the server for every API route. Never trust a client-supplied
  `business_id`; derive it from the session.
- Verify webhook signatures where the provider supports them.
- Error messages shown to users must not leak stack traces, SQL, or internal
  identifiers.
- Write to `audit_logs` for every meaningful business change (who, what,
  before, after, when).

---

## 7. Design system

`src/app/globals.css` is the **single source of truth** for colour, radius and
elevation. Read `DESIGN.md` before touching visual code.

The guiding idea is **calm surface, sharp signal**. The chrome stays quiet;
colour and weight are spent on the numbers, the changes and the
recommendations. Premium comes from restraint, not from added effects.

- **Never hard-code a colour in a component.** Use the semantic tokens
  (`bg-card`, `text-muted-foreground`, `border-border`, `bg-brand-600`). If you
  are about to write `text-white` inside a section, a token is missing — add it
  to `globals.css` instead.
- **Four surface levels** carry page rhythm: `surface-1` (white), `surface-2`
  (tinted), `surface-3` (near-black), `surface-brand` (violet). Each has its own
  `-foreground`, `-muted` and `-border`. Sections are full-bleed flat colour
  fields; levels 3 and brand are rare, roughly one section in five.
- **Two registers.** Marketing is spacious and banded. The product is compact,
  sits on one calm surface, and uses violet only for actions and active state.
  Never apply marketing spaciousness to a dashboard.
- **Colour hierarchy inside the product:** status → violet → chart series →
  neutral ink. Most of the screen is neutral, so a single amber chip actually
  means something. A colourful dashboard cannot alert.
- Fonts are declared only in `src/config/fonts.ts`. Plus Jakarta Sans for
  headings, Inter for body and UI, JetBrains Mono for figures. Two weights do
  almost all the work; headlines run 4–9 words.
- Any number a user compares gets `tabular-nums` so digits align.
- Status colours (success/warning/danger/info) carry meaning and are reserved.
  Never reuse them as chart series colours, and never signal state with colour
  alone — pair it with an icon or a label.
- Chart series colours are validated for colour-blind separation. Do not change
  them casually; see `DESIGN.md`.
- **Most cards carry no shadow**; borders and surface contrast do the work.
  **There is no glow token and buttons never glow.**
- Uniform grids by default, not bento mosaics. Headings left-aligned.
- Show real product UI. **No abstract AI imagery** — no orbs, blobs, neural
  motifs or glowing brains.

Every screen must work on mobile. Dashboards get a real mobile layout, not a
shrunken desktop one.

**Do not let visual polish outrun correctness.** A beautiful card showing a
wrong profit figure is worse than a plain one showing the right figure.

---

## 8. Architecture

```
Presentation  →  API / Application  →  Business Logic
              →  Analytics Engine   →  Universal Data Model  →  PostgreSQL
```

External systems are normalised before they reach our data model:

```
External source → Connector → Mapper → Validation → Normalisation
                → Universal Data Model
```

Directory conventions (create a folder when you have real code for it, not
before — see `ARCHITECTURE.md`):

| Path | Holds |
| --- | --- |
| `src/app/` | Routes, layouts, route handlers |
| `src/components/ui/` | shadcn primitives — avoid editing by hand |
| `src/components/` | Shared presentational components |
| `src/features/<name>/` | Feature-scoped UI and logic |
| `src/services/` | Business logic, analytics, AI, integrations |
| `src/lib/` | Framework-level helpers (Supabase clients, utils) |
| `src/config/` | Constants, tokens, fonts, product copy |
| `src/types/` | Shared TypeScript types |
| `src/hooks/` | Shared React hooks |

Rules:

- Business logic belongs in `src/services/`, never in a React component.
- Integrations are independent modules behind a shared interface. Never
  hard-code one vendor's assumptions into core logic.
- APIs are versioned under `/api/v1/`. Do not break v1 once integrations exist.

---

## 9. Coding standards

- TypeScript `strict`. Do not use `any`; do not silence errors with
  `@ts-ignore`. If a type is genuinely unknown, use `unknown` and narrow it.
- Prefer Server Components. Add `"use client"` only where interactivity needs it.
- Name things for what they mean in the business, not for their shape.
- Comment *why*, not *what*. Explain non-obvious decisions and constraints.
- Keep functions small enough to test.
- Handle errors explicitly. Never swallow one silently.
- Money: `numeric(20,4)` in PostgreSQL, never `float`. It crosses into the
  application as **exact decimal text**, cast to `text` in SQL while it is
  still exact — see MONEY.md. Never do financial arithmetic in TypeScript at
  all: `npm run test:money-guard` fails the build on it. Compare with
  `compareMoney`, format with `formatMoney`, calculate in SQL.

---

## 10. Development workflow

Work in phases. Do not jump ahead, and do not expand scope mid-phase.

```
0  Environment            ✅ complete
1  Project foundation     ✅ complete
2  Auth + multi-tenancy     ✅ complete, isolation verified live
3  Database + RLS          ✅ complete, isolation verified live
4  Core dashboard          ✅ complete, arithmetic verified
5  Universal data model    ✅ complete (CSV/Excel import connector)
6  CSV / Excel import      ✅ delivered with phase 5
7  Analytics engine        ✅ complete, figures hand-verified
7.1 Source truth           ✅ complete, blank never becomes zero
7.2 Canonical mapping      ✅ complete, no name becomes a fact
8  AI business analyst      ✅ complete, AI cannot state a figure
9  Shopify + WooCommerce    designed, not built — PHASE9_INTEGRATIONS.md
10 Sync + webhook engine    ✅ ENGINE BUILT — INTEGRATION_ENGINE.md
   + fixture connector      ✅ proves the engine with no network
11 Alerts + automation      ARCHITECTED, not built — PHASE11_AUTOMATION.md
12 AI recommendations       ARCHITECTED, not built — PHASE12_AI_RECOMMENDATIONS.md
13 Generic REST API
14 Audit + security hardening
15 Production deployment
```

Phases 9–12 were renumbered when they were designed: the generic REST connector
moved after the two named ones, because a generic design written before any real
connector exists is a guess.

**Read `ROADMAP.md` before starting any of them.** It records what is decided,
what is not, the changes that must land first, and the recommended order — which
is deliberately NOT the numbering. The sync engine (10) should be built before
the first connector (9), against a fixture connector, so the engine is proven
without credentials, without a vendor, and without a network.

Before every commit:

```bash
npm run lint && npm run build
```

Both must pass. Fix errors rather than working around them.

Commits are small and conventional: `feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`. Ask before any destructive git operation.

Update the relevant documentation in the same commit as the change.

---

## 11. Do NOT do these

- Do not put secrets in source code or expose them to the browser.
- Do not use the service-role key to serve user requests.
- Do not let the AI produce financial figures.
- Do not create a table without RLS.
- Do not hard-code brand colours in components.
- Do not delete or overwrite files without reading them first.
- Do not add a dependency without recording why.
- Do not build ahead of the current phase.
- Do not build payroll, HR, full accounting, VAT engines, manufacturing, a
  mobile app, native Amazon/Daraz connectors, autonomous purchasing or
  marketing, or WhatsApp automation. These are explicitly out of scope for V1.
- Do not ship autonomous AI actions. V1 automation is rule-based and logged;
  approval-based actions come later.
- Do not report work as finished without running lint and build.

---

## 12. Quality bar

This is not a demo. It is the foundation of a product intended to serve
thousands of businesses. Code should be maintainable, modular, typed, secure
and documented. The architecture should scale from 10 to 10,000 customers
without a rewrite.

If a shortcut would be embarrassing to explain to a paying customer, do not
take it.
