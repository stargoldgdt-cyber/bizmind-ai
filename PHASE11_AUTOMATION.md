# Phase 11 — Alerts and automation

**Status: DESIGN ONLY. Nothing here is implemented.**

Deterministic rules over verified figures. No language model decides anything,
and nothing acts on the owner's behalf without a rule they wrote and can read.

---

## 1. The principle

BizMind's promise is `Data → Understanding → Insight → Recommendation → Action`.
This is the Action step, and it is the one where a mistake has consequences
rather than embarrassment.

So V1 automation is:

- **Deterministic.** A rule fires because a number crossed a line, not because
  a model found it plausible. The same inputs always produce the same outcome.
- **Auditable.** Every evaluation and every action is on record: what the
  figure was, what the threshold was, when it fired, who was told.
- **Bounded.** V1 actions are alerts, notifications and tasks. Nothing buys,
  sells, prices, emails a customer, or changes a merchant's store.

The insight engine from Phase 7 already works this way, and its rules are the
model to follow: `src/services/analytics/insights.ts` fires on evidence and
stays silent without it.

---

## 2. Architecture

```
schedule / event
      ↓
rule evaluation        SQL, over analytics figures
      ↓
condition met?         a comparison against a stated threshold
      ↓
dedupe / cooldown      has this already fired today?
      ↓
action                 alert · notification · task
      ↓
execution record       what fired, on what figures, and what happened
      ↓
audit_logs
```

**Evaluation happens in SQL**, against the analytics functions. A rule asking
"is gross margin below 15%?" reads `analytics_financials`, which returns exact
decimal text — the comparison is a comparison, not arithmetic, and no figure is
recomputed anywhere.

This matters: an automation that calculated its own margin could fire on a
number the dashboard never showed. The owner would be told something that
contradicts their own screen.

---

## 3. Database

```
automation_rules
  id, business_id
  name              text          -- the owner's words
  description       text
  enabled           boolean
  trigger_kind      SCHEDULE | METRIC_THRESHOLD | EVENT
  schedule          text          -- for SCHEDULE
  metric            text          -- FK to canonical_metrics (Phase 7.2)
  operator          LT | LTE | GT | GTE | EQ | CHANGE_PCT_LT | CHANGE_PCT_GT
  threshold         numeric       -- exact, in the database
  period            text          -- which window to evaluate over
  severity          INFO | WARNING | CRITICAL
  cooldown_hours    integer
  created_by, created_at, updated_at

automation_actions
  id, business_id, rule_id
  kind              CREATE_ALERT | NOTIFY_OWNER | CREATE_TASK
  config            jsonb
  position          integer

automation_runs
  id, business_id, rule_id
  evaluated_at
  metric_value      text          -- the exact figure, as text
  threshold         text
  matched           boolean
  skipped_reason    text          -- COOLDOWN | METRIC_NULL | DISABLED
  status            SUCCEEDED | FAILED | DEAD
  attempts, last_error

alerts
  id, business_id, rule_id, run_id
  severity, title, body
  metric, metric_value, threshold
  status            OPEN | ACKNOWLEDGED | RESOLVED
  acknowledged_by, acknowledged_at, created_at
```

**`metric` is a foreign key onto `canonical_metrics`.** A rule cannot be
written against a metric BizMind does not define, and — reusing the Phase 7.2
constraint shape — a rule should only target a metric that actually exists.
This is what stops "alert me when profitability drops" becoming a rule over a
field nobody can define.

`threshold` is `numeric` in the database and crosses to the application as
text, exactly like every other figure (MONEY.md). No exception is made because
it is a setting rather than a result.

### A rule that cannot be evaluated does not fire

If the metric is NULL — no orders this period, coverage unmeasurable — the run
records `skipped_reason = METRIC_NULL` and **nothing fires**. Treating an
unknown as zero would page an owner at 6am because they had no sales on a
public holiday. The same reasoning that made blank ≠ zero in Phase 7.1.

---

## 4. The worked examples

| Rule | Metric | Operator | Threshold | Notes |
| --- | --- | --- | --- | --- |
| Margin too thin | `gross_margin` | `LT` | 15 | Suppressed when cost coverage < 100 — an overstated margin that dips is not evidence |
| Sales dropped | `revenue` | `CHANGE_PCT_LT` | -20 | Change comes from `analytics_compare`, computed in SQL |
| Low stock | inventory days | `LT` | 10 | **Needs a metric that does not exist yet — see §10** |
| Expense anomaly | `operating_expenses` | `CHANGE_PCT_GT` | 30 | |
| Receivables ageing | receivable age | `GT` | 30 days | **Needs invoices/receivables, which the model does not have — §10** |

Two of the five examples require data BizMind does not yet collect. That is a
finding, not an obstacle: they belong after the model supports them, and
pretending otherwise would produce a rule that silently never fires.

**The margin rule's suppression clause is the important one.** Phase 7 already
learned this: an insight that recommends action on a figure inflated by missing
costs is worse than no insight. Automation inherits that rule.

---

## 5. Permissions

| Role | May |
| --- | --- |
| OWNER | Create, edit, delete, enable/disable any rule; acknowledge alerts |
| ADMIN | Same as owner |
| STAFF | View rules; acknowledge alerts. **Cannot create or change a rule** |
| VIEWER | View alerts only |

Enforced by RLS policies on `automation_rules`, in the same shape as
`source_field_semantics`: an insert/update policy naming the permitted roles.
Not by a check in application code.

A rule is a standing instruction about someone's business. Editing one is
closer to changing a financial setting than to filing a ticket, which is why
STAFF is excluded.

Every create, edit, enable, disable and delete writes to `audit_logs` via the
existing `write_audit_log()` — who, what, before, after, when.

---

## 6. Execution, retry, failure

Reuses the Phase 10 engine. A rule evaluation is a job:

- Retried with exponential backoff and full jitter.
- A failed **action** (a notification that could not be delivered) retries;
  a failed **evaluation** does not fire an action at all.
- After the configured attempts, `DEAD`, and the owner is told the rule is
  broken. A silently broken alert is worse than no alert, because the owner
  believes they are being watched.
- **Cooldown** prevents a flapping metric alerting hourly. The default is
  24 hours per rule; a metric oscillating around a threshold should produce one
  alert, not forty.

---

## 7. Security and tenant isolation

- Every table carries `business_id`, RLS enabled and forced.
- Rules are evaluated **per business**, by a worker that resolves the tenant
  from the rule row — never from a request.
- An alert names figures. `alerts.body` must therefore never be constructed
  from another tenant's data, which the RLS-scoped evaluation guarantees
  structurally.
- Notification delivery (email, later) must not put figures in a subject line
  that a mail server logs. **Open decision (§10).**

Tests: business A's rule cannot read B's figures; a STAFF user cannot create a
rule; a VIEWER cannot acknowledge; every mutation appears in `audit_logs`.

---

## 8. What V1 explicitly does not do

- No LLM decides whether a rule fires, or writes a rule, or changes a
  threshold. CLAUDE.md forbids autonomous AI actions and this is where that
  would be tempting.
- No action changes data in a connected store.
- No action sends anything to a customer.
- No approval workflow yet — but the schema anticipates it: an action gains
  `requires_approval` and an `approvals` table, and the executor refuses to run
  an unapproved action. Designed for, not built.

---

## 9. Observability

- Every evaluation produces an `automation_runs` row, including the ones that
  did not fire and why. "Why didn't I get an alert?" is a question the owner
  will ask, and it must be answerable.
- Rule health: last evaluated, last fired, consecutive failures.
- A rule that has never fired in 90 days is worth surfacing — it is usually
  either mis-thresholded or watching something that never happens.

---

## 10. Open decisions

1. **Inventory-days and receivables metrics do not exist.** Both examples need
   new analytics. Inventory days needs stock levels plus a sales rate;
   receivables needs invoices, which the universal data model does not have.
   Decide whether Phase 11 includes them or waits.
2. **Notification channel.** In-app only for V1, or email? Email introduces a
   provider, deliverability, and figures in transit.
3. **Cooldown semantics** — per rule, or per rule-and-severity.
4. **Evaluation cadence** — after each sync, on a schedule, or both.
5. Whether thresholds should support a currency-relative form ("below 15% *or*
   below AED 5,000 gross profit").

---

## 11. Manual steps for the owner

- Write the rules. There are no defaults: a threshold BizMind chose would be a
  guess about someone else's business.
- If email is adopted, configure the provider and verify a sending domain.

---

## 12. Testing, cost, scalability, rollback

**Testing:** thresholds at, just above and just below the line; NULL metrics
never fire; cooldown suppresses; suppression when coverage is incomplete; role
restrictions by attempted violation; audit entries for every mutation.

**Cost:** one query per rule per evaluation. Negligible until thousands of
rules; then evaluate in batches per business rather than per rule.

**Scalability:** rule evaluation is per-tenant and embarrassingly parallel. The
limit is the same worker throughput as Phase 10.

**Rollback:** additive tables. Disabling every rule stops the feature dead and
leaves the analytics, dashboard and integrations untouched.
