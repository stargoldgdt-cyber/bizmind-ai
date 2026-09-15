# CLAUDE.md — Permanent development instructions for BizMind AI

Read this file before doing anything in this repository. It outlines what
BizMind is, how it must be built, and what must never be done. It outranks
habit and outranks any pattern you remember from other projects.

Also read `AGENTS.md` — Next.js 16 writes framework-specific rules there, and
this version differs from older Next.js in ways that matter.

---

## 1. The product

**BizMind AI** is a **GCC Marketplace Profit Intelligence Platform**
(repositioned 2026-09-15 — read `ARCHITECTURE_BASELINE.md`).

Sellers in the GCC list the same physical products on Amazon, noon and
Carrefour. Each marketplace charges differently, settles differently and names
products differently. BizMind answers, from the marketplaces' own settlement
data:

- how much each marketplace and each product really makes after marketplace
  fees, product costs, advertising and operating expenses
- where the money goes, and why profit changed
- what was settled, what was paid out, and what actually reached the bank
- what to do next

It is **not** an ERP and **not** a traditional accounting system. It keeps an
immutable, line-level ledger of what marketplaces reported, computes verified
figures from it, and uses AI only to explain them.

The loop the whole product serves:

```
SOURCE DATA → LEDGER → UNDERSTAND → EXPLAIN → ALERT → RECOMMEND
```

**Users are marketplace sellers and operators, not accountants.** Every screen
should answer "what do I do about this?", not just "here is a number".

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
ones can be added later without a rewrite. Financial permissions (decision B11,
2026-09-15) are checked inside the database functions, never only in the UI:

| Role | May |
| --- | --- |
| VIEWER | Read only |
| STAFF | Import data. Not confirm SKU mappings, change COGS, or confirm anything financial |
| ADMIN | Import, confirm SKU mappings, manage COGS and expenses, withdraw a file |
| OWNER | Everything, including integrations, reconciliation and configuration (marketplace accounts, tax profiles) |

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
Presentation  →  API / Application  →  Business logic
              →  Financial engines (P&L, cashflow, reconciliation — in SQL)
              →  Immutable ledger  →  PostgreSQL
```

Marketplace data reaches the ledger through exactly one path (`LEDGER.md`):

```
Source file → Transport (upload; marketplace APIs later)
            → Marketplace adapter (pure; one per marketplace format)
            → Customer-data filter → ledger_apply_file() → source_rows + ledger
```

Supporting data — COGS, product master, expenses — is entered natively or
arrives through Google Sheets dataset targets (`src/services/datasets`). It
never writes the ledger.

The order/product/expense import pipeline and the analytics, health score and
alerts built on it are the **legacy model**. They keep working until they are
retired (`ROADMAP.md`), but no new feature is built on them.

Directory conventions (create a folder when you have real code for it, not
before — see `ARCHITECTURE.md`):

| Path | Holds |
| --- | --- |
| `src/app/` | Routes, layouts, route handlers |
| `src/components/ui/` | shadcn primitives — avoid editing by hand |
| `src/components/` | Shared presentational components |
| `src/features/<name>/` | Feature-scoped UI and logic |
| `src/services/` | Business logic, analytics, AI, integrations |
| `src/services/marketplaces/` | Marketplace adapter contract, customer-data filter, ledger file payload |
| `src/services/datasets/` | Dataset targets Google Sheets and CSV write through (supporting data only) |
| `src/lib/` | Framework-level helpers (Supabase clients, utils) |
| `src/config/` | Constants, tokens, fonts, product copy |
| `src/types/` | Shared TypeScript types |
| `src/hooks/` | Shared React hooks |

Rules:

- Business logic belongs in `src/services/`, never in a React component.
- Marketplaces are adapters. A new marketplace is an adapter, its mapping rules
  (data) and a test fixture; the ledger and the engines never change for it.
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
- **The ledger is immutable.** Never update or delete a `financial_transactions`,
  `source_rows`, `settlements` or `payouts` row, and never write one except
  through `ledger_apply_file()`. A correction is a new record or a withdrawn
  source file. The database refuses anything else, for every role.

---

## 10. Development workflow

Work in phases. Do not jump ahead, and do not expand scope mid-phase.

The product was repositioned on 2026-09-15. Legacy phases 0–12 built the
platform the new product stands on (auth, tenancy, exact money, import,
analytics, AI guard, integration engine, Google Sheets, alerts); their record is
`ROADMAP_LEGACY.md`. The current plan:

```
GCC 1   Ledger foundation              ✅ built, verified live (119 checks) — LEDGER.md
GCC 2   Amazon Flat File V2 adapter        ✅ built, July reproduced from real files — AMAZON.md
GCC 3   P&L engine, fee breakdown, data quality
GCC 4   Product master, SKU mapping, dated COGS
GCC 5   Expenses + Google Sheets dataset targets
GCC 6   Settlements, payouts, bank, reconciliation, cashflow
GCC 7   Dashboard, money flow, reports, exports
GCC 8   AI intents + alerts on the ledger
GCC N   noon adapter (only after real sample files)
GCC 10  Legacy retirement
```

**Read `ARCHITECTURE_BASELINE.md` and `ROADMAP.md` before starting any phase.**
Every open decision there has a conservative default; do not replace a default
with a guess.

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
- Do not build payroll, HR, full accounting, VAT engines or VAT returns,
  manufacturing, a mobile app, marketplace API connectors (V1 is file-based),
  autonomous purchasing or marketing, PPC management, repricing, inventory
  forecasting, or WhatsApp automation. VAT *treatment* is configuration an
  accountant confirms, never something BizMind works out. Recoverable VAT on
  marketplace fees is never a P&L expense; non-recoverable VAT is its own
  expense line; while the treatment is unknown, P&L contribution is incomplete,
  never shown as final, and never assumed (B1).
- Do not merge the six views of money: P&L (economic profit), tax ledger (VAT,
  input VAT), cashflow (actual cash), settlement (marketplace calculation),
  payout (marketplace-reported payment), bank (actual receipt). They link only
  through reconciliation.
- Do not update or delete ledger rows, or write them outside `ledger_apply_file()`.
- Do not store customer names, emails, phone numbers or addresses in the ledger
  or any new table.
- Do not allocate marketplace-level fees or advertising to products (V1).
- Do not merge SKUs automatically. A person confirms every mapping.
- Do not convert currencies (V1). Currency belongs to the marketplace account.
- Do not build two-way Google Sheets sync (V1). BizMind writes only to
  spreadsheets it created for an export.
- Do not assume Carrefour's platform or API, and do not finalise noon mappings
  without real sample files.
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
