# Alerts and automation

**Built. Migrations 0016 and 0017.**

The ALERT step of `CONNECT → UNDERSTAND → ANALYZE → ALERT → RECOMMEND →
AUTOMATE`, and the first one where being wrong has consequences rather than
being merely embarrassing. A wrong number on a dashboard is read by somebody
who is already looking. A wrong alert arrives unprompted and claims something
is happening.

---

## 1. What V1 does, and what it refuses to do

It raises alerts. That is the entire list of actions.

Nothing prices, buys, emails a customer, changes stock, or touches a
merchant's store. `requires_approval` exists on every rule and is always
`true`, because there is no executor for it to gate — it is there so the
approval workflow has somewhere to land rather than requiring a schema change
later.

**No model is involved anywhere in this path.** A rule fires because a number
crossed a line an owner chose, compared by PostgreSQL. Same inputs, same
outcome, every time. Phase 12 adds AI *narration* of what fired; it does not
get a vote in whether something fires.

---

## 2. The comparison happens in SQL

`automation_evaluate_rule()` reads `analytics_financials()` and compares in the
database. No threshold, no metric value, and no comparison ever enters
TypeScript.

This is not only the money rule from [MONEY.md](MONEY.md) being obeyed
mechanically. An alert is a claim about a figure the owner can also see on
their own dashboard. If the two were computed by different code, they could
disagree — and an alert that contradicts the screen it came from destroys
trust in both.

The worker's whole job is to react to the *outcome*:

```
automation_claim_due()   →  which rules are due? (rule IDs only)
automation_evaluate_rule →  read, compare, record, maybe alert
worker                   →  count FIRED / NOT_MATCHED / SKIPPED / FAILED
```

`scripts/verify-automation.mts` asserts that `worker.ts` contains neither the
word `threshold` nor `metric_value`.

---

## 3. Silence has to be explainable

`automation_runs` records **every** evaluation, including the ones that
produced nothing, with a reason:

| Reason | What happened |
| --- | --- |
| `COOLDOWN` | It fired recently and stayed quiet rather than repeat itself |
| `METRIC_NULL` | There was nothing to measure — no orders, or no denominator |
| `INCOMPLETE_DATA` | Costs or fees are short, so the figure is overstated |
| `DISABLED` | The rule was off when the check ran |
| `NO_ANALYTICS_KEY` | The metric is defined but the dashboard does not publish it |
| `NO_COMPARISON` | The metric has no period-on-period change |

A table of alerts records what fired. It cannot answer *"why didn't I hear
about this?"*, and that is the question an owner asks after the fact — usually
after something went wrong. An owner who cannot tell "nothing was wrong" from
"the check never ran" learns to distrust the quiet, and an alerting system
nobody trusts is worse than none, because it was relied on.

`SKIP_REASON_EXPLANATIONS` turns each into a sentence for the screen.

---

## 4. The four decisions that keep alerts worth reading

### A missing number never becomes zero

If a period has no orders, gross margin is `NULL`, not `0`. Treating it as zero
would fire a "margin collapsed" alert every public holiday. Phase 7.1
established that a blank never becomes a zero; this is the same rule applied
where the consequence is somebody's phone.

### An unreliable figure does not raise an alarm

`suppress_when_incomplete` defaults to `true` and gates the four profit
metrics. With cost coverage below 100%, gross profit is overstated by an
unknown amount — a margin that "collapses" because cost data finally arrived is
not a business event.

The rule that reports the coverage gap **itself** sets it to `false`. It exists
to report incomplete data; gating it would silence the one alert that explains
why the others went quiet.

### A rule does not repeat itself

`cooldown_hours` defaults to 24. Without it, a margin resting at 14.99% pages
somebody on every worker run. Zero is permitted — it is a legitimate choice for
a genuinely critical rule — and it is not the default, because alerts that cry
wolf stop being read, which costs more than the alert was worth.

### A rule that could never fire cannot be saved

`automation_rules.metric` is a foreign key to `canonical_metrics`, so a rule
cannot be written against a figure BizMind does not define. On top of that,
`canWatch()` refuses a metric with no `analytics_key`, and refuses a
percentage-change rule on a metric `analytics_compare()` produces no row for.

Both would otherwise save happily, appear correct in the list, and never fire.

---

## 5. Thresholds are exact text

A threshold is `numeric(20,4)` in PostgreSQL and a **string** everywhere else,
validated by regex rather than parsed:

```ts
threshold: z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/)
```

`z.number()` would turn `15.15` into an IEEE-754 double before it ever reached
SQL, and a rule would then fire on the wrong side of a boundary somebody chose
deliberately. `"1,500"` is refused rather than loosely parsed, because loose
parsing makes it `1` — a threshold 1500× too low, with no error.

A ratio metric with a threshold in the thousands is also refused. That is
almost always somebody typing a money figure into a margin rule, and it is
checked by **digit count**, never by arithmetic.

---

## 6. The alert row is self-contained

Metric, value, threshold, period and operator are **copied** onto the alert
rather than joined from the rule. A rule can be edited or deleted afterwards,
and an alert that re-read its rule would rewrite its own history — an owner
reviewing last month's alert would be shown today's threshold.

`operator` was missed in 0016 and added in **0017**. Without it, a `CHANGE_PCT`
alert on revenue and a value alert on revenue are indistinguishable on the row:
one stores a percentage, the other stores money, and both say
`metric: "revenue"`. The display layer was reduced to reading the alert's own
prose to decide whether to print a currency symbol, and formatting a 20% fall
as `AED -20.00` is exactly the plausible-wrong number this product exists not
to produce. The row was missing a fact, so the fix was to store the fact.

---

## 7. Security

### Roles

| | OWNER / ADMIN | STAFF / VIEWER |
| --- | --- | --- |
| Read rules, runs, alerts | ✅ | ✅ |
| Create, edit, delete rules | ✅ | ❌ |
| Acknowledge an alert | ✅ | ✅ |

A rule is a standing instruction about somebody's business — closer to a
financial setting than a ticket. Acknowledging is not: the people who see an
alert are the people who deal with it, and routing that through an owner means
alerts stay open and the open count stops meaning anything.

RLS is **enabled and forced** on all three tables, and migration 0016 refuses
to install if `anon` can read any of them.

### The worker has no session, and never names a tenant

`automation_claim_due()` is the one function here that reads across every
business, because "which rules are due?" has no per-business form. It is safe
because it returns **nothing but rule IDs**, and `automation_evaluate_rule()`
then resolves each rule's tenant from the rule row itself.

Neither takes a business id, so `callTrusted()`'s refusal of any privileged
call carrying one still holds — see
[INTEGRATION_ENGINE.md](INTEGRATION_ENGINE.md). `automation_claim_due` is
granted to `service_role` alone, is deliberately **absent from
`src/types/database.ts`** so it is not reachable from a session-scoped client,
and migration 0016 refuses to install if `authenticated` can execute it.

`automation_evaluate_rule()` is `SECURITY DEFINER` and checks membership itself
whenever `auth.uid()` is not null — so a signed-in user cannot run somebody
else's rule, and the sessionless worker still can.

### Auditing

Raising an alert writes to `audit_logs` directly rather than through
`write_audit_log()`, which requires a session the scheduled path does not have.
The actor is `null` for a worker-raised alert and the real user for a manual
run. Same pattern as `webhook_event_ingest()`.

---

## 8. Scheduling

`POST /api/v1/automation/run`, authenticated by `CRON_SECRET` in an
`Authorization: Bearer` header, compared in constant time.

It **fails closed**: with the secret unset it returns 503 and refuses
everything. The tempting alternative — "no secret configured, so allow it" —
turns a missing environment variable into an endpoint the whole internet can
call, and the mistake is invisible because everything appears to work.

The route is excluded from `src/proxy.ts` for the same reason the webhook
routes are: a cron service carries no session, so the auth round trip buys
nothing.

The Vercel cron schedule itself is a deployment task and is **not yet
configured** — see ROADMAP.md.

---

## 9. Starter rules

Five templates in `src/services/automation/templates.ts`: margin floor, revenue
drop, expense spike, refunds rising, cost coverage.

**None is enabled automatically.** Every threshold in them is a guess — a 15%
gross margin is comfortable for one business and a crisis for another, and
BizMind has no customer data to calibrate against. Silently switching on rules
built from guesses would produce alerts that feel authoritative and are
arbitrary. So each carries its `rationale` in plain language, the owner sees
the number BizMind chose, and changes it.

### What is deliberately missing

**Inventory days-of-cover** and **receivables ageing** were both in the Phase 11
design and are not built. Days-of-cover needs a per-SKU sales rate the universal
model does not carry; receivables ageing needs invoices, which BizMind does not
model at all. A rule that cannot be computed from verified figures does not get
a plausible substitute.

**Refund rate** is not watchable either. `refund_rate` exists in
`analytics_financials()` but is not in the canonical vocabulary, so no rule can
target it. The refunds template watches the month-on-month *change* instead — a
fixed threshold on the refund amount would mean something different for every
business, and something different for the same business after a good month.

---

## 10. Tests

```bash
npm run test:automation        # 62 assertions, no database
npm run test:automation-live   # 47 assertions against real Postgres
```

The offline suite cannot test the comparison, because the comparison is in SQL
— which is the point of putting it there. It tests everything around it: that a
rule which could never fire is refused, that a threshold survives as exact
text, that the TypeScript and SQL vocabularies agree, that no arithmetic has
crept into the service, and that the migrations still guard themselves.

**The live suite's important assertions are the ones about silence.** Anyone
can make an alert fire. The failures that would hurt a business are the quiet
ones — a rule firing on an inflated margin, an empty period read as a collapse
to zero, forty pages in an afternoon — so sections 3, 4 and 5 exist for those,
alongside full cross-tenant isolation.

Section 4 demonstrates the inflation rather than describing it: adding a single
order with no recorded cost **raises** the reported gross margin, because
revenue grows and cost does not. The owner's margin appears to improve at the
moment their data got worse. That is what `suppress_when_incomplete` is for,
and the test asserts the figure moved.
