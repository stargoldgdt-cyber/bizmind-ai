# Money

**Every figure is calculated in PostgreSQL, in exact decimal, and reaches the
application without ever becoming a floating-point number.**

---

## 1. The boundary

```
PostgreSQL numeric(20,4)          exact, 20 digits
        ↓  ::text                 cast in SQL, lossless
PostgREST                         {"revenue":"9007199254740993.0000"}
        ↓  JSON.parse             a quoted string stays a string
analytics service                 Money = string, and it is true
        ↓
fact sheet → AI                   the digits the database produced
        ↓
Intl.NumberFormat                 formats the string, never converts it
        ↓
the screen                        AED 9,007,199,254,740,993.00
```

At no point is a money value handed to `Number()`.

---

## 2. What went wrong, and why the fix is where it is

This codebase used to declare `Money = string` and claim that PostgREST
returned numerics as JSON strings, so accidental arithmetic in JavaScript was
impossible.

Probing the live database showed otherwise:

```json
{"revenue":0.1000,"cogs":0.30000000,"cost_gap":50.00}
```

**Unquoted numbers.** The wire format was exact — JSON numbers are arbitrary
precision by specification — but `JSON.parse` narrowed every one of them to an
IEEE-754 double the moment it reached JavaScript. The declared type was a lie,
and the safety it promised did not exist.

The obvious repair — parse, then call `String()` on the result — would have
been theatre. **The precision is already gone by then.** The conversion has to
be prevented, not undone, so the cast happens in SQL while the value is still
exact.

`numeric::text` is lossless in PostgreSQL: it writes the stored decimal digits,
full scale included.

---

## 3. What is exact, and what is not

| Kind | Type | Why |
| --- | --- | --- |
| Money and ratios | `text` → `string` | Up to 20 significant digits; a double holds 15–17 |
| Counts | `bigint` → `number` | Exact integers far below 2^53. The declaration is already true |

Casting counts would make the types lie in the other direction, so they are
left alone.

### NULL is not zero

`null::numeric::text` is NULL, and PostgREST emits it as JSON `null`. A figure
the database could not calculate arrives as `null` — never `"0"`, never `""`,
never `0`.

That distinction carries real meaning throughout the product: "this order had
no fee" and "the file never said what the fee was" produce identical arithmetic
and very different confidence.

---

## 4. Where the exactness lives

| Layer | Holds |
| --- | --- |
| `analytics_core` (private schema) | The exact-numeric implementations. **Not exposed through PostgREST** |
| `public` wrappers | The same figures as `text`. The only contract application code can reach |

Three functions were **moved** into `analytics_core` with
`ALTER FUNCTION … SET SCHEMA`, so their arithmetic was carried across verbatim
rather than retyped — nothing retyped means nothing mistyped. The three that
build on them read exact numerics from `analytics_core`, calculate in SQL
exactly as before, and cast only their own output.

One representation is reachable over the API. Two contracts for the same figure
is how a codebase ends up believing the wrong one.

The wrappers are `SECURITY INVOKER`. `DEFINER` would have saved a grant and
bypassed Row Level Security, which is never worth a convenience.

---

## 5. The type does not enforce the rule. This does.

`a + b` on two strings compiles and returns `"10002000"`. TypeScript will not
stop you, and no declaration ever could.

**`npm run test:money-guard`** scans every source file for arithmetic on a
money-named field and fails the build. It tests itself on known-bad and
known-good samples, so a regex that quietly stopped matching would be caught.

Three files are exempt, each for a stated reason:

| File | Why |
| --- | --- |
| `src/lib/format.ts` | Hands the exact string to `Intl` and converts nothing |
| `src/services/analytics/money.ts` | The comparator. Compares digits; contains no arithmetic |
| `src/types/database.ts` | Type declarations only |

### What TypeScript may do

- **Format** a figure — `formatMoney`, `formatNumber`, `formatPercent`
- **Compare** one against a threshold — judgement over a figure SQL produced
- **Order** two — `compareMoney`, which compares digit strings

### What it may not do

Add, subtract, multiply or divide. That invents a figure, and an invented
figure has no audit trail.

---

## 6. Ordering without arithmetic

Sorting channels by revenue looked innocent:

```ts
.sort((a, b) => Number(b.revenue) - Number(a.revenue))
```

It converts two exact decimals to doubles and subtracts them — precisely what
the boundary exists to prevent, and wrong for any pair differing beyond a
double's reach.

`compareMoney` compares the digits instead: sign, then integer length, then
integer digits, then zero-padded fraction digits. No conversion, no operators.

It also treats an unknown figure as unknown: `null` sorts **last** in a
descending sort, because a channel whose revenue was never recorded is not the
smallest one.

---

## 7. Two calculations that were moved OUT of TypeScript

Found by the guard, not by inspection.

| Was | Now |
| --- | --- |
| `.sort((a, b) => Number(b.revenue) - Number(a.revenue))` | `compareMoney`, exact |
| `const rate = (refunds / revenue) * 100` — and printed to the owner | `refund_rate`, computed in SQL (migration 0011) |

The second was the worse one: a financial figure calculated in floating point
in TypeScript and shown in an insight title. A figure somebody reads is a
figure the database should have produced.

`percentChange()` in `format.ts` was deleted for the same reason. It computed a
percentage in TypeScript, and nothing used it.

---

## 8. Proving it

```bash
npm run test:money-guard      # offline, no arithmetic in the source
npm run test:money-boundary   # live, exact decimals survive the whole path
```

The live test stores **9007199254740993.0000** — 2^53+1, the smallest integer
an IEEE-754 double cannot hold. `Number("9007199254740993")` returns
`9007199254740992`.

If any step converts it, the last digit is gone and the suite says so. It
checks the raw wire format, the runtime type of every money field, every one of
the six analytics functions, the AI fact sheet, and tenant isolation — then
asserts that converting the value *now* would still lose the digit, so the
proof cannot pass by accident.

The comparator's own tests use 2^53 and 2^53+1, which a double cannot tell
apart, and assert that `compareMoney` can. (An earlier version used 2^53+1 and
2^53+2 and failed, because 2^53+2 *is* representable. The boundary is not
"large numbers" — it is odd integers above 2^53.)
