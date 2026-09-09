# BizMind AI

**Your ERP records what happened. BizMind tells you what to do about it.**

BizMind AI is an AI business intelligence and automation layer. It connects to
the systems a business already runs — Shopify, WooCommerce, marketplaces,
spreadsheets, ERPs — normalises their data into one model, computes verified
metrics, and turns those numbers into decisions.

It is not an ERP, not a dashboard tool, and not a chatbot. It sits on top of
what a business already has.

```
CONNECT → UNDERSTAND → ANALYZE → ALERT → RECOMMEND → AUTOMATE
```

---

## Status

**Phase 7 of 15 — analytics engine.**

Foundation, design system, Supabase Auth, the multi-tenant security model, the
universal data model, a working dashboard and CSV/Excel import are in place.
Every business figure is computed in SQL and checked against hand arithmetic;
tenant isolation was verified by attack, not assumption. Import is built as the
first connector, so Shopify and WooCommerce reuse the same pipeline. AI arrives
in its own phase. See `CLAUDE.md` § 10.

---

## Quick start

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

Full instructions, including how secrets are handled, are in
[SETUP.md](./SETUP.md).

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local development server |
| `npm run build` | Production build — must pass before committing |
| `npm run start` | Serve the production build |
| `npm run lint` | Code quality checks — must pass before committing |
| `npm run verify` | Typecheck, lint, the offline test suites and build, in one go |
| `npm run test:analytics-data` | Analytics against the live database |
| `npm run test:costs` | Historical cost stability against the live database |
| `npm run test:source-truth` | Blank-is-not-zero and the semantics gate, live |

---

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · shadcn/ui on Radix ·
Supabase (PostgreSQL, Auth, RLS) · OpenAI · Vercel

---

## Documentation

| File | What it covers |
| --- | --- |
| [CLAUDE.md](./CLAUDE.md) | **Permanent development rules. Read first.** |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system fits together |
| [DESIGN.md](./DESIGN.md) | Colour, typography, spacing, chart rules |
| [SETUP.md](./SETUP.md) | Getting it running, and how secrets work |
| [DATABASE.md](./DATABASE.md) | Schema, tenant isolation, migrations |
| [INTEGRATIONS.md](./INTEGRATIONS.md) | Import pipeline and the connector contract |
| [DECISIONS.md](./DECISIONS.md) | Why each major choice was made |
| [AGENTS.md](./AGENTS.md) | Next.js 16 framework rules (auto-generated) |

`API.md` and `AI.md` are written as their phases land.

---

## Two rules worth knowing up front

**Tenant isolation is enforced in the database.** Every business-owned table has
a `business_id` and Row Level Security. The database refuses cross-tenant reads
even if application code is wrong.

**The AI never calculates a business number.** Every financial figure is
computed by our own code and verified; the AI only explains figures it was
given. A wrong number here would be worse than no number at all.
