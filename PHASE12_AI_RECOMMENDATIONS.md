# Phase 12 — AI recommendations and the daily brief

**Status: DESIGN ONLY. Nothing here is implemented.**

Phase 8 built an AI that explains one period and cannot state a figure it was
not given. Phase 12 extends that to a daily brief and to recommendations — and
extends the guarantees with it, rather than relaxing them because the output
got more ambitious.

---

## 1. The rule, unchanged

```
DATABASE → ANALYTICS → VERIFIED FACTS → AI EXPLANATION / RECOMMENDATION
```

The model receives figures already computed in SQL, and every number in its
reply is checked against the facts it was given before an owner sees it. A
reply containing an invented figure is discarded whole — see AI.md §4.

**Phase 12 adds no exception.** A recommendation is more consequential than an
explanation, so it gets the same guard plus additional structure.

---

## 2. Architecture

```
analytics bundle          exact figures, per period
      +
deterministic findings    insights.ts, rules over arithmetic
      +
open alerts               Phase 11
      ↓
fact sheet                formatted, labelled, with reliability notes
      ↓
model                     writes prose ABOUT those facts
      ↓
number guard              every figure checked
      ↓
structured validation     Zod, against the contract in §4
      ↓
recommendation            stored, ranked, shown
```

Two things are new: the fact sheet grows to include alerts and the previous
brief, and the reply must satisfy a **schema** rather than being free prose.

Structure is a safety feature. A paragraph can drift into advice BizMind does
not give; a JSON object with a `recommended_action` and a
`supporting_metrics` array has fewer places to hide.

---

## 3. The four features

### 3.1 Daily business brief

Answers *"what changed, and what should I do today?"* Built from figures for
the period, the comparison, the deterministic findings, and any open alerts.

Generated **once per business per day**, on a schedule, and stored — not
regenerated on each page load. Three reasons: an owner refreshing should not
see the wording change, a stored brief can be compared against yesterday's,
and it costs a fraction of the tokens.

### 3.2 Business health explanation

`health.ts` already produces a score with per-dimension reasons and states
plainly when a dimension **cannot** be measured. The AI explains those
dimensions in the owner's language. It does not compute the score, adjust it,
or explain away a low one.

### 3.3 Recommendations

Ranked suggestions, each tied to figures. The ranking is **computed**, not
chosen by the model — see §5.

### 3.4 "What changed?"

Period-over-period movement, from `analytics_compare`, which already computes
absolute and percentage change in SQL. The AI narrates the comparison; it never
performs one.

---

## 4. The recommendation contract

```ts
type Recommendation = {
  /** Stable key, e.g. "margin_erosion". Not free text. */
  type: string
  /** COMPUTED from severity and impact. The model does not choose it. */
  priority: "critical" | "high" | "medium" | "low"
  title: string
  explanation: string
  /**
   * The figures this rests on. Every one is a metric key plus the exact
   * value the database produced -- never a number the model wrote.
   */
  supporting_metrics: {
    metric: string        // FK-checked against canonical_metrics
    value: string         // exact decimal text, from analytics
    label: string
  }[]
  /**
   * How much the underlying data can be trusted. DERIVED from coverage,
   * not asserted by the model.
   */
  confidence: "high" | "medium" | "low"
  recommended_action: string
  /** Always true in V1. Nothing executes. */
  requires_approval: true
}
```

### Where each field comes from

| Field | Source |
| --- | --- |
| `type` | An enum BizMind defines. A model returning an unknown type is rejected |
| `priority` | Computed (§5) |
| `title`, `explanation`, `recommended_action` | The model — prose only |
| `supporting_metrics` | **Injected from analytics after generation.** The model names which metrics it used; the values are looked up |
| `confidence` | Computed from cost and fee coverage |
| `requires_approval` | Constant `true` |

**`supporting_metrics` values are never taken from the model's output.** It may
say "this rests on gross margin and fee coverage"; BizMind supplies what those
figures are. This makes a wrong figure in a supporting metric structurally
impossible rather than merely checked.

---

## 5. Priority and confidence are computed

**Priority** from the deterministic severity already assigned by `insights.ts`
(`critical`/`warning`/`info`/`positive`) and the size of the movement, which
`analytics_compare` computed in SQL.

**Confidence** from data quality:

| Cost coverage | Fee coverage | Confidence |
| --- | --- | --- |
| 100% | 100% | high |
| ≥ 90% | ≥ 90% | medium |
| below that | | low |

A recommendation resting on a margin inflated by missing costs is **low
confidence and says so in the same sentence as the advice**. Phase 7 learned
that an insight recommending action on an incomplete figure is worse than
silence; a recommendation is the same thing with more authority.

Letting the model choose either field would let it be confident about a figure
it cannot assess.

---

## 6. Database

```
daily_briefs
  id, business_id, brief_date, period_key
  narrative text
  model text, generated_at
  fact_sheet_hash text     -- what it was generated from
  status GENERATED | SUPPRESSED
  suppressed_reason text
  unique (business_id, brief_date)

recommendations
  id, business_id, brief_id
  type, priority, confidence
  title, explanation, recommended_action
  supporting_metrics jsonb
  requires_approval boolean not null default true
  status OPEN | ACKNOWLEDGED | DISMISSED | DONE
  acknowledged_by, acknowledged_at
  created_at
```

`fact_sheet_hash` records what the brief was generated from. If the figures are
later corrected — a cost backfill, a re-import — the stored brief can be shown
as stale rather than quietly contradicting the current dashboard.

RLS on both, forced, four policies, as everywhere else.

---

## 7. Guardrails, extended

Everything in AI.md §4 still applies. Phase 12 adds:

1. **Schema validation.** The reply is parsed with Zod. A malformed or
   unexpected shape is discarded, not repaired.
2. **Type allowlist.** `type` must be one BizMind defines.
3. **Metric allowlist.** Every `supporting_metrics.metric` must exist in
   `canonical_metrics`.
4. **Value injection.** Figures are looked up, never read from the reply.
5. **`requires_approval` is a constant.** A model cannot set it false because
   nothing reads it as permission — there is no executor.
6. **No action verbs that imply execution.** The existing `claimsToAct` guard
   already discards a reply claiming to have done something; the recommendation
   path keeps it.

**Degradation is unchanged and non-negotiable.** No key, a timeout, a rate
limit, an empty balance, or a rejected reply all produce the same thing: the
figures, the deterministic findings, and one line saying why there is no
narrative — ending "Your figures above are unaffected."

The dashboard must be fully useful with the AI switched off. It is today, and
Phase 12 must not change that.

---

## 8. Cost

One brief per business per day, plus the existing on-demand explanation. At
`gpt-5.6-terra` prices this is fractions of a penny per business per day.

Controls worth having before it matters: a per-business daily cap, a global
monthly cap, and a token counter recorded per generation so the cost of a
customer is a number rather than a guess. **Open decision (§10).**

Storing the brief rather than regenerating it is the largest single saving.

---

## 9. Testing

Extends `scripts/verify-ai-analyst.mts`:

- A recommendation with an invented figure in `explanation` is discarded.
- A `supporting_metrics` value differing from analytics is **impossible** —
  asserted by construction, since values are injected.
- An unknown `type` or metric key is rejected.
- `requires_approval` is always true, whatever the model returns.
- Priority and confidence match their computed inputs.
- Low coverage produces low confidence, and the text says the figures are
  overstated.
- With no key: the brief is suppressed, the dashboard is complete, and the
  message reassures.
- Tenant isolation: a brief is generated per business and cannot read another's
  figures.

The offline suite runs with `OPENAI_API_KEY` deleted, as it does today, so a
test that reached the network fails rather than quietly spending money.

---

## 10. Open decisions

1. Brief cadence and timezone — "daily" is relative to the business's timezone,
   which `businesses.timezone` already stores.
2. Whether a brief is generated when nothing changed. Probably not: a daily
   message that always says "nothing much happened" trains an owner to ignore
   it.
3. Cost caps and token accounting.
4. Whether recommendations are versioned when figures change, or simply marked
   stale.
5. Delivery — in-app only, or email (shares the Phase 11 decision).
6. Whether "what should I do today?" should ever draw on data older than the
   current period.

---

## 11. Manual steps for the owner

- Nothing new. The OpenAI key is already configured and verified.
- If email delivery is adopted, that provider setup is shared with Phase 11.

---

## 12. Security, scalability, rollback

**Security:** no new external surface. The key stays server-side in
`src/services/ai/client.ts`, still the only file that contacts OpenAI. Briefs
contain figures, so the tables are RLS-protected like any other business data.

**Scalability:** one generation per business per day, on a schedule, through
the Phase 10 worker. Linear in customers and trivially batched.

**Rollback:** additive tables; the feature is a flag. Turning it off leaves
every figure, chart, alert and integration exactly as it was — which is the
same property that makes the degradation path safe.
