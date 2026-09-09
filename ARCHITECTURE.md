# Architecture

How BizMind AI is put together, and why.

---

## 1. The shape of the system

BizMind is a layer on top of the systems a business already runs. It reads
their data, normalises it into one model, computes verified metrics, and uses
AI only to explain and recommend.

```
┌──────────────────────────────────────────────────────────────┐
│  Presentation            Next.js App Router, React Server     │
│                          Components, shadcn/ui                │
├──────────────────────────────────────────────────────────────┤
│  Application / API       Route handlers (/api/v1), Server     │
│                          Actions, auth + tenant guards        │
├──────────────────────────────────────────────────────────────┤
│  Business logic          src/services — domain rules          │
├──────────────────────────────────────────────────────────────┤
│  Analytics engine        Verified metric computation          │
├──────────────────────────────────────────────────────────────┤
│  Universal data model    One schema, vendor-neutral           │
├──────────────────────────────────────────────────────────────┤
│  PostgreSQL (Supabase)   Row Level Security enforced here     │
└──────────────────────────────────────────────────────────────┘
```

The AI layer sits beside the analytics engine, never beneath it:

```
Analytics engine ──► verified numbers ──► AI service ──► explanation
                 └─────────────────────► UI ──────────► the same numbers
```

The UI renders the computed number. The AI only ever narrates a number that has
already been computed. This is a correctness boundary, not a style preference —
see `AI.md` when that layer is built.

---

## 2. How external data gets in

Every integration follows the same path. No connector is allowed to write
directly into application tables.

```
External source          Shopify · WooCommerce · CSV · REST · Webhooks
      │
      ▼
Connector                vendor-specific fetch + auth
      │
      ▼
Raw source record        preserved verbatim; blanks stay blank
      │
      ▼
Mapper                   source column → canonical metric
      │                  SUGGESTED by name, CONFIRMED only by a person
      ▼
Validation               Zod schema; reject or quarantine bad rows
      │
      ▼
Normalisation            currency, units, timezones, identifiers
      │
      ▼
Universal data model     the only shape the rest of the app knows
      │
      ▼
Analytics ──► Alerts ──► AI ──► Automation
```

Consequences of this design:

- Core logic never learns what "Shopify" is. Adding Daraz later touches the
  connector layer only.
- One sync engine serves every connector: initial sync, incremental sync, sync
  status, last-synced time, failure handling, retries and logs.
- Integration credentials are stored server-side and never reach the browser.

### The mapping step is a gate, not a translation

**Flexible source fields. Standard BizMind meaning.**

No business renames its columns to use BizMind, and BizMind does not guess what
they mean. A column heading produces a *candidate*; only a person produces a
mapping, and it is recorded against their name. The permission is stored in a
different database column from the guess, and constraints — not code — refuse
any mapping that was never confirmed.

The raw record survives the whole journey. Mapping adds meaning; it never
renames or discards what the source said, so "where did this number come from?"
stays answerable months later.

A source can supply a figure. It can never supply a **conclusion**: gross
profit, net profit, margins and coverage are calculated by the analytics engine
and are structurally unreachable from any column.

See [MAPPING.md](./MAPPING.md).

---

## 3. Multi-tenancy

The security model is enforced in the database, not the application.

```
users
  └── business_members (role: OWNER | ADMIN | STAFF | VIEWER)
        └── businesses
              └── every business-owned row carries business_id
```

- Row Level Security is enabled on every business-owned table.
- Policies resolve the caller's accessible businesses through
  `business_members`.
- The application still scopes its queries — but if it forgets, the database
  refuses the read anyway. Defence in depth.
- The service-role key bypasses RLS and is therefore never used to serve a user
  request.

Details and policy SQL will live in `DATABASE.md` from Phase 3.

---

## 4. Directory layout

Folders are created when there is real code to put in them. Empty scaffolding
is not created for appearance. This is the current and planned structure:

```
src/
├── app/                     Routes, layouts, route handlers      [exists]
│   ├── layout.tsx           Root layout: fonts, metadata, providers
│   ├── page.tsx             Foundation page (replaced in Phase 4)
│   └── globals.css          Design tokens — single source of truth
│
├── components/
│   ├── ui/                  shadcn primitives (generated)        [exists]
│   └── brand/               Logo and brand marks                 [exists]
│
├── config/                  Constants and tokens                 [exists]
│   ├── site.ts              Product name, tagline, pillars
│   ├── fonts.ts             The only place fonts are declared
│   └── design-tokens.ts     CSS-variable references for JS consumers
│
├── lib/                     Framework-level helpers              [exists]
│   └── utils.ts             cn() class merger
│
├── features/                Feature-scoped UI + logic            [Phase 4+]
├── services/                Business logic                       [Phase 7+]
│   ├── metrics/             The canonical vocabulary — the authority
│   ├── analytics/           Verified metric computation
│   ├── ingestion/           Parsing, mapping, validation, normalisation
│   ├── ai/                  The only place OpenAI is called
│   └── integrations/        One module per connector
├── types/                   Shared TypeScript types              [Phase 3+]
└── hooks/                   Shared React hooks                   [Phase 4+]
```

Rules:

- Business logic lives in `src/services/`, never inside a React component.
- `src/components/ui/` is generated by the shadcn CLI. Prefer wrapping over
  hand-editing, so components can be regenerated.
- A feature that grows beyond a couple of files gets its own folder under
  `src/features/`.

---

## 4b. The analytics engine

The layer everything later depends on. Alerts, recommendations and the AI will
all consume its output, so it has one job: produce figures that are correct and
say so when they are not.

```
DATA        universal data model
   |
ANALYTICS   SQL functions -- every figure, including every period delta
   |
INSIGHT     deterministic rules over verified figures
   |
AI          Phase 8 -- explains these outputs, never computes them
   |
ACTIONS     Phase 13 -- rule-based, logged, never autonomous
```

### Where calculations live, and why

**Every business figure is computed in SQL.** Not some of them, and not the
easy ones. Two reasons:

1. `numeric` is exact decimal arithmetic. A value parsed into a JavaScript
   number becomes binary floating point, where 0.10 has no exact representation
   and the error compounds across aggregation.

2. It is the boundary that keeps the AI honest. If the application is not
   permitted to calculate, neither is anything built on top of it.

This extends further than it first appears: **period-over-period changes are
computed in SQL too**, by `analytics_compare()`. Leaving a subtraction to the
caller would be the first crack in the rule.

TypeScript in `src/services/analytics/` does exactly two things: it decides
which figures to ask for, and it compares already-computed RATIOS against
documented thresholds. That is judgement, not arithmetic.

| Module | Responsibility |
| --- | --- |
| `types.ts` | The metric registry -- every published number, defined once |
| `periods.ts` | Comparison windows, half-open so nothing is double-counted |
| `health.ts` | Business Health Score. Every threshold stated in the file |
| `insights.ts` | Deterministic rules. No model involved |
| `index.ts` | The single facade. Nothing above it calculates |

### SQL functions

| Function | Returns |
| --- | --- |
| `analytics_counted_orders` | The definition of "counted revenue", in one place |
| `analytics_financials` | Headline figures plus data-quality counts |
| `analytics_compare` | One row per metric: current, previous, change, direction |
| `analytics_channels` | Per-channel performance. Reconciles exactly to the total |
| `analytics_products` | Per-product performance from order lines |
| `analytics_reconciliation` | Makes the order-vs-line revenue gap visible |
| `analytics_health_inputs` | Measured ratios for the health score |

All are `SECURITY INVOKER`, so Row Level Security applies inside them. A caller
asking about another tenant receives zeros and empty sets -- not an error,
which would confirm the business exists.

### Two reconciliation facts, stated rather than hidden

**Channels reconcile exactly.** Every counted order belongs to one channel or
to none, and orders with none are grouped as "Unattributed" rather than
dropped. Channel revenue therefore always sums to total revenue, and a test
asserts it.

**Products do NOT reconcile to total revenue, by construction.** Product
revenue is order-LINE revenue; order totals also contain shipping and
order-level discounts, which belong to an order rather than to any product.
`analytics_reconciliation()` reports the gap so it is a known quantity instead
of a discrepancy someone discovers later.

Per-product fees are an **allocation**, split by line revenue, and the column
is named `fees_allocated` so it can never be read as a charge someone actually
paid per product.

### Data quality is a first-class output

The engine reports what it does not know:

| Signal | Meaning |
| --- | --- |
| `cost_coverage` | Share of order lines with a recorded cost. Below 100 means profit is OVERSTATED |
| `orders_without_channel` | Channel comparisons are incomplete |
| `orders_zero_fees` | BizMind cannot distinguish a genuine zero fee from one never recorded |
| `cancelled_orders` | Counted separately; excluded from every figure |
| `order_line_gap` | Shipping and order-level adjustments |

A ratio with a zero denominator returns **NULL, never 0 and never infinity**.
Null means "cannot be calculated", which is a different fact from zero and
stays distinguishable all the way to the screen.

---

## 5. Rendering model

- Server Components are the default. Data fetching happens on the server, close
  to the database, and secrets stay there.
- `"use client"` is added only where interactivity requires it, and as deep in
  the tree as possible.
- Route handlers under `/api/v1/` exist for external consumers and webhooks.
  Internal UI reads data directly on the server rather than calling our own HTTP
  API.

---

## 6. API versioning

Public surface is versioned from the start:

```
/api/v1/orders
/api/v1/products
/api/v1/customers
/api/v1/payments
/api/v1/expenses
/api/v1/inventory
/api/v1/integrations
/api/v1/webhooks
```

Once a third party depends on `v1`, it does not break. Breaking changes go to
`v2` and both run side by side.

---

## 7. What is deliberately not here yet

Phase 1 built the foundation only. There is no database, no authentication, no
AI, no integrations and no dashboard. That is intentional — each arrives in its
own phase so it can be built and verified properly rather than sketched.

See `CLAUDE.md` § 10 for the phase plan.
