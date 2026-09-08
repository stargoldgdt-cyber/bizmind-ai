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
Mapper                   vendor fields → BizMind fields
      │
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
│   ├── analytics/           Verified metric computation
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
