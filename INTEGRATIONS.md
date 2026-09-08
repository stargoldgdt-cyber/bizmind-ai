# Integrations

How outside data gets into BizMind.

File import is the **first connector**, not a separate feature. Shopify,
WooCommerce and the REST connector reuse everything below the mapping step, so
adding one never means touching the universal data model.

---

## 1. The pipeline

```
External source
      │            CSV / XLSX today · Shopify, WooCommerce, REST, webhooks later
      ▼
  Connector        obtains raw records
      │
      ▼
  Mapping          source field ──► canonical field
      │            file:    chosen by the user
      │            vendor:  fixed by the connector
      ▼
  Validation       required fields, types, ranges, duplicates
      │
      ▼
  Normalisation    dates, decimals, currency, status wording
      │
      ▼
  Apply            ONE transaction, idempotent upsert
      │
      ▼
  Universal data model ──► analytics ──► AI
```

**A file import and a Shopify sync differ in exactly two places:** how the raw
records arrive, and whether the mapping is chosen or fixed. That is the whole
point of the design.

Nothing below the mapping step knows what a marketplace is. There is no
vendor-specific logic in the data model, and there must never be.

---

## 2. Where the code lives

| Path | Role |
| --- | --- |
| `src/services/ingestion/contracts.ts` | The shared contract every connector implements |
| `src/services/ingestion/entities.ts` | Canonical target fields per entity, and how much each matters |
| `src/services/ingestion/normalize.ts` | Dates, decimals, currency, status — the "never guess" layer |
| `src/services/ingestion/validate.ts` | Row validation, grouping, duplicate detection |
| `src/services/ingestion/mapping.ts` | Suggests a column mapping from headings |
| `src/services/ingestion/parse.ts` | CSV and XLSX readers (server only) |
| `src/app/api/v1/imports/route.ts` | Upload endpoint |
| `src/features/imports/actions.ts` | Preview and commit |
| `supabase/migrations/0004_import_pipeline.sql` | Batch tracking and the atomic apply functions |

To add a connector: produce `RawRecord[]`, supply a fixed `Mapping`, and call
the same validation and apply functions. Do not add a new write path.

---

## 3. Supported formats

| Format | Notes |
| --- | --- |
| `.csv` | UTF-8, with or without a byte order mark. Quoted values containing commas handled |
| `.xlsx` / `.xlsm` | First worksheet. Dates arrive as real `Date` values; formula cells use their computed result |

Limits: **8 MB** and **20,000 rows** per file. Larger exports should be split
by date range. Files are read on the server, never in the browser.

---

## 4. Entities and fields

Importance drives behaviour: `required` blocks, `recommended` warns and must be
acknowledged, `optional` is silent.

### Orders — revenue, margin, channel profit, customers

| Field | Importance | Why |
| --- | --- | --- |
| Order ID | required | Idempotency key. Without it, re-importing duplicates |
| Order date | required | Every period figure depends on it |
| Order total | required | Revenue |
| **Channel fees** | recommended | Without it profit is **overstated** — usually the biggest reason marketplace revenue is worth less than it looks |
| **Quantity** | recommended | No quantity, no cost of goods |
| **Unit cost** | recommended | Without it profit is **overstated**. May instead come from a product import |
| **SKU** | recommended | Links lines to the catalogue so costs can be filled in |
| Order number, status, customer email/name, currency, subtotal, discount, tax, shipping, product name, unit price, line total | optional | |

One row per order line. Order-level values repeat across the lines of an order.

### Products — cost of goods and inventory

| Field | Importance |
| --- | --- |
| SKU, Product name | required |
| **Unit cost** | recommended — this is the field that clears the "profit is overstated" warning |
| Selling price, category, brand, barcode, stock on hand, reorder point | optional |

### Expenses — net profit

| Field | Importance |
| --- | --- |
| Date, Amount | required |
| **Category** | recommended — without it, "where is my money going" cannot be answered |
| Description, paid to, reference, currency | optional |

---

## 5. Validation rules

The governing rule: **never resolve an ambiguity by guessing.** A plausible
wrong number is the worst thing this product can produce.

| Rule | Behaviour |
| --- | --- |
| **Ambiguous dates** | `03/04/2026` is refused in auto mode. The user must state DMY, MDY or YMD. Guessing would move transactions between months |
| Excel dates | Real `Date` cells and serial numbers are unambiguous and accepted as-is |
| Impossible dates | 31 February is refused, not rolled forward |
| **Decimal separator** | Chosen explicitly. `1.234,56` and `1,234.56` are both valid, and a value contradicting the choice is refused rather than reinterpreted |
| Number cleaning | Currency symbols, spaces and thousands separators stripped; `(123.45)` read as negative |
| Negatives | Refused where meaningless — an expense amount, a unit cost |
| **Currency** | Checked, never converted. A row in another currency is refused, because inventing an exchange rate would be inventing a financial figure |
| Unknown status | Refused. Treating an unrecognised status as fulfilled could count a cancelled order as revenue |
| Missing required | The whole file is blocked, naming the columns |
| Missing recommended | Import proceeds only after the user ticks an acknowledgement naming what will be incomplete |
| Bad rows | Skipped individually with a row number and reason; the rest still import |

### Duplicates

| Case | Behaviour |
| --- | --- |
| Same order across several lines | Grouped into one order with several lines — the normal shape of an export |
| Same order with **conflicting totals** | Both rows refused. BizMind will not choose between two revenue figures |
| Same SKU twice in a product file | Later row wins, with a warning |
| Order with no readable lines | Imported, with a warning that its cost is unknown |

---

## 6. Idempotency

Re-importing the same file **updates** rather than duplicates, via
`(business_id, source, external_id)` on the universal model.

- **Order lines are replaced, not appended.** Appending would double quantities
  and therefore cost of goods, producing a wrong margin that looks plausible.
- **Customers match on email** within a business, so the same buyer arriving
  from two channels stays one customer.
- **Applying the same batch twice is refused** outright — a second upload of
  the same file is the supported path.
- **Expenses with no reference cannot be recognised** on a second import. The
  interface warns before committing.

---

## 7. Safety

- **All-or-nothing.** Each import runs in one transaction. A failure on row 900
  of 1000 leaves the database exactly as it was — verified by feeding a batch
  whose second row fails at the database level and confirming the valid first
  row was not written.
- **`business_id` comes from the batch row**, never from the caller's
  arguments, and the batch is only visible to its own tenant. A caller cannot
  import into a business they do not belong to.
- **Re-validated on commit.** The preview's output is never accepted as input;
  the server revalidates from the stored rows, so a crafted request cannot
  write unvalidated data.
- **Role-gated.** A VIEWER cannot import. RLS enforces it; the interface
  explains it.
- **Auditable.** `import_batches` keeps the file, the mapping and the row
  counts; `import_issues` keeps every problem by row; and a completed import
  writes an `audit_logs` entry stamped with who did it.

---

## 8. Planned connectors

| Phase | Connector | Reuses |
| --- | --- | --- |
| 9 | Shopify | Everything below the mapping step; mapping is fixed |
| 10 | WooCommerce | Same |
| 11 | Generic REST | Same, with a user-defined mapping like the file connector |
| 12 | Webhooks + sync engine | Same apply functions, driven by events rather than uploads |

`import_batches` is deliberately shaped to become the basis of `sync_jobs`: it
already records a source, a status, counts, and an error.
