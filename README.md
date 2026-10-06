# BizMind AI

**GCC Marketplace Profit Intelligence.** Which marketplace and which product
actually make you money — and where the rest of it went.

BizMind helps sellers on Amazon, noon and Carrefour understand sales,
marketplace fees, product costs, advertising, operating expenses, profit,
settlements, payouts and cash — from the marketplaces' own settlement data,
recorded in an immutable line-level ledger. It is not an ERP and not a
traditional accounting system.

---

## Status

**GCC Phase 1 — ledger foundation built and verified live.**

The platform underneath is in place and tested: Supabase Auth, database-enforced
tenant isolation, exact money handling, file import with lineage and withdrawal,
a checked AI layer, an integration engine with Google Sheets, and rule-based
alerts. Phase 1 added the immutable financial ledger, its single writer and the
marketplace adapter contract. No marketplace parser exists yet; Amazon arrives
in Phase 2. See [ROADMAP.md](./ROADMAP.md) and
[ARCHITECTURE_BASELINE.md](./ARCHITECTURE_BASELINE.md).

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
| `npm run test:mapping` | Canonical vocabulary and the suggestion engine |
| `npm run test:mapping-data` | Mapping gates, profiles and isolation, live |
| `npm run test:migration-0010` | Live contract test for the coverage-gap columns |
| `npm run test:money-guard` | Fails the build on any money arithmetic in TypeScript |
| `npm run test:money-boundary` | Proves exact decimals survive database → AI, live |
| `npm run test:integration-engine` | The engine and fixture connector, no database |
| `npm run test:woocommerce` | The WooCommerce connector, no store needed |
| `npm run test:marketplaces` | The adapter contract, customer-data filter and ledger payload, offline |
| `npm run test:ledger` | The ledger against the real database: immutability, one writer, isolation, withdrawal |
| `npm run test:amazon` | The Amazon Flat File V2 adapter, offline |
| `npm run test:amazon-ledger` | An invented Amazon settlement end to end against the real database |
| `npm run test:amazon-acceptance -- <file> <file> …` | The named real Amazon files reproduce July (local only; files never committed) |
| `npm run test:classification` | The classification model and its TypeScript/SQL parity, offline |
| `npm run test:pnl` | Automatic classification, the P&L engine and the dashboard's readers against the real database |
| `npm run test:ledger-dashboard` | Month ranges, the validation CSV and the dashboard's wiring, offline |
| `npm run test:noon` | The noon adapter and its rules, offline |
| `npm run test:noon-ledger` | Invented noon exports end to end against the real database |
| `npm run test:noon-acceptance -- <tv.csv> <invoices.csv>` | The named real noon exports reproduce July (local only; files never committed) |
| `npm run test:catalog` | SKU normalisation, cost validation, migration 0035's guarantees and the product screens' wiring, offline |
| `npm run test:catalog-ledger` | Products, SKU matching, dated costs and Gross Profit against the real database |
| `npm run test:expenses` | Expense classification, Net Profit and the product/cost Sheet tabs, offline |
| `npm run test:expenses-ledger` | The same against the real database, through the real sync worker (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run test:payouts` | Expected payouts are never shown as received, offline |
| `npm run test:reports` | The report catalogue and its Excel workbooks keep every digit, offline |
| `npm run test:report-exports` | The Google Sheets write scope: only sheets BizMind created, offline |
| `npm run test:payouts-ledger` | Every expected-payout status from one fixture month, against the real database |
| `npm run test:report-exports-ledger` | The export queue and write scope against the real database (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run test:ledger-ask` | Ask BizMind on the ledger: facts and guards with a fake model, offline |
| `npm run test:ledger-alerts` | Alerts on ledger figures, every skip reason, against the real database |
| `npm run ai:check-ledger` | One real model answer per ledger question, through every guard (needs `OPENAI_API_KEY`) |
| `npm run test:overview` | The home dashboard: migration 0043, no arithmetic, wording and routing, offline |
| `npm run test:overview-ledger` | The home dashboard's readers against the P&L engine and isolation, live |
| `npm run test:sku-setup` | SKU setup: identical-SKU matching rules, one-sheet Excel checks and round trip, offline |
| `npm run test:sku-setup-ledger` | SKU setup against the real database: automatic matching, costs from first sale, conflicts, isolation |
| `npm run test:website` | The public website claims nothing untrue: marketplace statuses, placeholder notices, legal pages |
| `npm run test:auth` | Sign-in, create-account, forgot and reset password, Google sign-in wiring, the redirect rule and security headers, offline |
| `npm run test:product-profit` | Product profitability: grouping, ranking, wording, layout rules and no money arithmetic, offline |
| `npm run test:product-analysis` | Product analysis page: the shape of what SQL returns, the insight rules, and no money arithmetic, offline |
| `npm run test:ledger-parts` | Large settlement files split into parts: nothing lost or doubled, related rows kept together, repeatable, offline |
| `npm run test:integration-live` | Tenant isolation and idempotency, live |
| `npm run test:automation` | Alert rules, thresholds and the migration guards, no database |
| `npm run test:automation-live` | Proves a rule stays silent when it should, live |
| `npm run verify:integrations` | Both integration suites |
| `npm run test:ai` | The number guard and safe degradation, no key needed |
| `npm run ai:check` | Verifies the OpenAI key, model and one real explanation |

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
| [MAPPING.md](./MAPPING.md) | Canonical vocabulary, and why a column name is not a definition |
| [AI.md](./AI.md) | How the AI is stopped from ever producing a figure |
| [MONEY.md](./MONEY.md) | Why money is a string, and what keeps it exact |
| [INTEGRATION_ENGINE.md](./INTEGRATION_ENGINE.md) | The sync and webhook engine connectors plug into |
| [ARCHITECTURE_BASELINE.md](./ARCHITECTURE_BASELINE.md) | The approved GCC architecture and its decisions |
| [LEDGER.md](./LEDGER.md) | The immutable financial ledger (GCC Phase 1) |
| [ROADMAP.md](./ROADMAP.md) | GCC phases, open decisions, manual steps |
| [WOOCOMMERCE.md](./WOOCOMMERCE.md) | The first real connector, and what WooCommerce cannot tell us |
| [ROADMAP.md](./ROADMAP.md) | **Phases 9–12: what is decided, what is not, what comes first** |
| [PHASE9_INTEGRATIONS.md](./PHASE9_INTEGRATIONS.md) | Shopify + WooCommerce design |
| [PHASE10_SYNC.md](./PHASE10_SYNC.md) | Sync and webhook reliability engine |
| [PHASE11_AUTOMATION.md](./PHASE11_AUTOMATION.md) | Alerts and deterministic automation |
| [PHASE12_AI_RECOMMENDATIONS.md](./PHASE12_AI_RECOMMENDATIONS.md) | Daily brief and recommendations |
| [DECISIONS.md](./DECISIONS.md) | Why each major choice was made |
| [AGENTS.md](./AGENTS.md) | Next.js 16 framework rules (auto-generated) |

`API.md` is written as its phase lands.

---

## Two rules worth knowing up front

**Tenant isolation is enforced in the database.** Every business-owned table has
a `business_id` and Row Level Security. The database refuses cross-tenant reads
even if application code is wrong.

**The AI never calculates a business number.** Every financial figure is
computed by our own code and verified; the AI only explains figures it was
given. A wrong number here would be worse than no number at all.

---

## Deployment

Hosted on Vercel, built from the `main` branch on
[github.com/stargoldgdt-cyber/bizmind-ai](https://github.com/stargoldgdt-cyber/bizmind-ai).
A push to `main` triggers a production deploy automatically. Production
environment variables (Supabase, OpenAI, Google OAuth, `CRON_SECRET`) are set
in the Vercel project's Environment Variables screen, not in this repo.
