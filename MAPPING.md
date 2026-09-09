# Mapping

**Flexible source fields. Standard BizMind meaning.**

No business should have to rename its spreadsheet columns to use BizMind. One
seller writes `Product Wholesale Price`, another writes `Landed Cost`, a third
writes `COGS`. All three can mean the same thing. None of them proves it.

This document describes the layer that turns whatever a source calls something
into what BizMind calls it — and, more importantly, the rules that stop that
layer from guessing.

---

## 1. The chain

```
RAW SOURCE DATA
     ↓            the file, preserved verbatim in source_records
SOURCE FIELD
     ↓            the column, under its own name, in source_field_semantics
MAPPING
     ↓            confirmed by a person, or nothing at all
CANONICAL METRIC
     ↓            BizMind's own vocabulary
ANALYTICS
                  figures calculated in SQL
```

Every step is kept. Nothing renames anything in place, and no step throws away
what the one before it said. That is what makes it possible to answer, months
later, *"where did this cost of goods number come from?"*

---

## 2. The canonical vocabulary

Defined once, in [`src/services/metrics/canonical.ts`](src/services/metrics/canonical.ts).
That file is the authority. The dashboard's metric registry is **built from it**
rather than restating it, so a metric cannot come to mean one thing on the
dashboard and another in the mapping layer.

Each metric has an **origin**, and it decides everything else:

| Origin | Meaning |
| --- | --- |
| `sourced` | A confirmed source column may supply this figure |
| `computed` | BizMind calculates it. **No source may supply it, ever** |

**Sourced:** revenue, payment received, cost of goods, channel fees,
advertising, shipping cost, storage, promotions, refunds, other charges,
operating expenses, total charges, orders, units.

**Computed:** gross profit, gross margin, net profit, net margin, customers,
average order value, cost coverage, fee coverage.

### Why computed metrics are unreachable

A marketplace's own `Profit/Loss` column looks exactly like net profit. It is
not. It is built from whatever that seller put in their own cost column, and it
excludes every expense the marketplace never saw.

If a source column could be mapped to `net_profit`, that figure would inherit
the credibility of a number BizMind had actually checked. So it cannot be. The
database refuses it through a foreign key, and the refusal explains itself:

> "Net profit is calculated by BizMind from figures it has checked, so no
> source column can be mapped to it. Map the underlying figures instead."

---

## 3. A name is not a definition

`Wholesale Price` can mean:

- **A.** the cost of the units actually sold — cost of goods
- **B.** what was spent restocking this period — procurement, not COGS
- **C.** what the held inventory is worth — a balance, not a cost
- **D.** the price charged to trade buyers — revenue, not a cost at all

All four are ordinary bookkeeping. Each produces a different profit. The column
name cannot tell them apart.

A system that guesses here is right often enough to be trusted and wrong often
enough to be dangerous, which is the worst combination a financial product can
have. So BizMind prefers:

> "I need you to confirm what this field means."

over:

> "I guessed what this field means."

**Field-name similarity creates a suggestion. It can never create confirmed
financial semantics.**

---

## 4. Candidate and mapping are different columns

This is the mechanism, and the reason it holds:

| Column | What it is | Who writes it |
| --- | --- | --- |
| `candidate_metric` | What BizMind **suspects** | A name-matching rule |
| `maps_to` | What BizMind is **permitted to use** | Only a person |

Analytics never reads `candidate_metric`. A suggestion cannot be promoted by
accident, by a bug, or by an `UPDATE` that forgets the difference — because
they are not the same column.

---

## 5. Statuses

| Status | Meaning |
| --- | --- |
| `SUGGESTED` | BizMind proposed it; nobody has looked yet |
| `PENDING_CONFIRMATION` | Put to a person, awaiting their decision |
| `CONFIRMED` | A person stated the meaning. **Only this may be used** |
| `REJECTED` | Examined and found *not* to mean what it looked like |
| `UNKNOWN` | Looked at, and honestly not known |

`UNKNOWN` is a real answer, not a failure. It records that somebody looked and
does not know, which stops the same question being asked at every import.

### Confirmation rules — enforced by the database

```sql
constraint semantics_mapping_requires_confirmation
  check (maps_to is null or status = 'CONFIRMED'),
constraint semantics_confirmation_requires_attribution
  check (status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null))
```

plus a foreign key that admits only `sourced` metrics.

In plain terms:

1. A field nobody confirmed cannot feed a BizMind figure.
2. A confirmation must carry a name and a timestamp.
3. The target must be a real metric a source is allowed to supply.
4. Only an **owner or admin** may confirm — it changes what every profit figure
   in the business is built from.
5. Every confirmation writes an `audit_logs` entry.

Rules 1–3 are constraints, not code. No code path can skip them, because they
are not code paths.

---

## 6. Mapping profiles

A profile records that a particular **file shape** has been dealt with: this
set of columns, from this source, for this kind of import.

Recognition is by *signature* — the column set, normalised and sorted. The same
export next month is recognised regardless of column order or spacing.

**A profile stores no metric.** It stores which source fields it covers, and
each of those points at a row in `source_field_semantics`, where the meaning
lives behind the constraints. A profile therefore cannot carry a mapping the
gate would have refused — not because the code is careful, but because there is
nowhere to put one.

### Reuse is not silence

`resolve_mapping_profile()` returns every field with a `usable` flag, which is
true only when the status is `CONFIRMED` **and** a metric is set. Anything else
comes back explicitly unusable.

And a file that has **gained a column** produces a different signature, so it is
not recognised at all and the new column gets asked about. That is the
behaviour that matters: a marketplace adding a fee column must never slip in
unnoticed.

---

## 7. Lineage

`mapping_lineage(business_id, metric)` answers *"where did this number come
from?"*:

| | |
| --- | --- |
| Canonical metric | `cogs` |
| Source | Amazon |
| Original field | `product Wholesale Price` |
| Status | CONFIRMED |
| Confirmed by | the business owner, by name |
| Confirmed at | timestamp |
| What BizMind had guessed | `cogs`, medium confidence |
| Source records preserved | count |

Unmapped columns appear too, with no metric, so the **gaps are visible** rather
than absent.

---

## 8. Raw and canonical stay separate

- Source columns keep their own names, odd casing included:
  `product Wholesale Price`, not `product_wholesale_price` and certainly not
  `cogs`.
- `source_records` holds each record exactly as supplied, with `blank_fields`
  recording what was empty so blank never becomes zero.
- Mapping adds meaning. It never renames, overwrites or discards the original.

A confirmed mapping does not rewrite history either: confirming a column
changes what future analysis can use, not what any past figure was.

---

## 9. The Amazon case

The worked example, and a regression test.

`Total Sales − Total Expense = Payment` reconciles exactly
(74,644.49 − 24,995.90 = 49,648.59). Because that closes **without**
`product Wholesale Price`, Amazon never produced that column — it is
seller-supplied, so no Amazon documentation could ever define it.

The business owner confirmed it means **the cost of the units sold**, so it is
mapped to `cogs` with their confirmation on record.

**That confirmation is about this business, not about the phrase.** Another
seller's `Wholesale Price` column starts again as an open question.

`Profit/Loss` (= Payment − Wholesale) stays under its own name. It is not
BizMind's net profit and now cannot become it: `net_profit` is computed, so no
column may be mapped to it. It also omits every operating expense Amazon never
saw.

---

## 10. Where the code lives

| Path | Holds |
| --- | --- |
| `src/services/metrics/canonical.ts` | The vocabulary. The authority |
| `src/services/ingestion/canonical-mapping.ts` | Suggestions, signatures. Confirms nothing |
| `src/services/ingestion/source-fields.ts` | What is known about each source's columns |
| `src/features/imports/mapping-actions.ts` | Server actions. Business from the session |
| `src/features/imports/components/column-meanings.tsx` | The question, asked well |
| `supabase/migrations/0009_canonical_mapping.sql` | The tables, gates and lineage |

No financial arithmetic exists in any of them. Mapping decides **meaning**;
every calculation stays in SQL. A test asserts it.

---

## 11. Tests

```bash
npm run test:mapping
```

118 assertions, no database needed: the vocabulary, the single-definition rule,
the refusal to confirm, the named false friends, signature behaviour, and the
Amazon regression case.

```bash
npm run test:mapping-data
```

Against the live database: the vocabulary in SQL matches the vocabulary in
TypeScript, both gates hold, computed metrics are unreachable, profiles are
reused but a new column is not, lineage is complete, confirming moves no
figure, and one business cannot read, write or overturn another's mappings.
