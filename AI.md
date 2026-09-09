# AI

**Compute first, then narrate.**

BizMind uses a language model for exactly one thing: turning figures it has
already calculated into sentences a business owner can act on.

It is never used to produce a figure. Not a total, not a difference, not a
percentage. That is not a guideline in a prompt — it is enforced by code that
throws away any reply which breaks it.

---

## 1. Why this is the strictest part of the product

If BizMind tells an owner their profit is 4,102.88 and it is 4,898.46, the
product is not merely unhelpful. It is harmful: they will price, buy and hire
against a number that does not exist, and the mistake is invisible because the
sentence around it reads perfectly well.

A language model is very good at producing that sentence. So the design starts
from the assumption that it will try.

---

## 2. The pipeline

```
analytics engine   figures calculated in SQL, in exact decimal
      ↓
fact sheet         formatted, labelled, with definitions and reliability notes
      ↓
model              writes prose about the fact sheet, and nothing else
      ↓
guard              every number in the reply checked against the fact sheet
      ↓
dashboard          the paragraph, or nothing at all
```

"Or nothing at all" is a normal outcome, not a failure state.

---

## 3. The model has nothing to calculate with

It never sees an order, a line item, a customer, or a raw row of anything. It
sees a fact sheet: a block of text listing the figures BizMind computed, each
with a label, its value formatted exactly as the dashboard shows it, what the
figure means, and — where it applies — why it cannot be fully trusted.

There are no operands. Arithmetic is not merely forbidden; there is nothing to
perform it on.

A figure the database could not calculate is written as **"not calculated"**
with the reason, never omitted. An absent line would invite the model to assume
zero. A line saying the figure does not exist cannot be misread that way.

---

## 4. The number guard

After the model replies, every number in the reply is compared against the
numbers in the fact sheet it was given.

A number that was not in the sheet is a number BizMind never supplied — and
there is nowhere else it could legitimately have come from.

When one is found, **the entire reply is discarded.** Not edited, not
annotated. A paragraph containing one invented figure is not salvageable: the
invented figure is usually load-bearing for the sentence around it, and an
owner reading a confident explanation has no way to tell which half to believe.

Tolerances, because being pedantic is not the same as being safe:

| The sheet says | The model may write |
| --- | --- |
| `51.29%` | `51.3%`, `51%` |
| `AED 9,550.50` | `9,550.50`, `9550.5` |
| `8` | `8` |

### What the guard does not catch

It is worth being straight about the limit. The allowlist is built from every
number in the fact sheet, so a **small integer that appears anywhere in the
sheet is allowed anywhere in the reply**. If three orders have no recorded fee,
the model may write "your top 3 channels" and pass.

That hole admits a stray count. It does not admit a money figure or a
percentage, because those do not collide by accident — and those are the ones
that cost somebody money. A test asserts this limit explicitly rather than
leaving it as folklore.

### Two more refusals

- A reply that **claims to have calculated** something ("adding these up gives",
  "which works out to") is discarded. BizMind's credibility rests on figures
  coming from the database; an explanation must never imply otherwise.
- A reply that **claims to have acted**, or gives tax or investment advice, is
  discarded. V1 does not act on anyone's behalf.

---

## 5. It degrades safely, always

The dashboard renders every figure before the AI layer is asked for a single
word. The explanation loads afterwards, separately.

If there is no API key, if OpenAI is down, slow, out of credit, rate-limited,
or if the guard rejects the reply, the owner sees a short line saying what
happened — always ending with **"Your figures above are unaffected."**

**Out of credit is told apart from rate limiting.** OpenAI returns HTTP 429 for
both, and the right response to each is the opposite of the other: waiting
clears a rate limit and will never clear an empty balance. Collapsing the two
would send an owner off to wait for something that is not going to happen. A
test asserts the distinction and the wording of both messages.

Silence would invite the reading that something is wrong with the numbers. The
truth is the opposite: the numbers are fine, and the prose about them was not
good enough to show.

---

## 6. One door

`src/services/ai/client.ts` is the only file in the entire codebase that
contacts OpenAI, and the only one that reads `OPENAI_API_KEY`. Both facts are
asserted by a test that walks the source tree.

Every feature goes through `narrate()` in `analyst.ts`, which is the only
caller of `complete()`. A new feature therefore cannot skip the guard by
calling the client directly — there is one door out and one door through.

The AI modules are marked `server-only`, so importing one into a browser bundle
is a build error rather than a leaked key.

### No SDK

The OpenAI SDK is not a dependency. This is one HTTP POST; a package would add
supply-chain surface and a second thing to keep current, in exchange for retry
behaviour we want to control. See DECISIONS.md.

---

## 7. Files

| Path | Holds |
| --- | --- |
| `client.ts` | The only OpenAI call. Timeouts, errors, the key |
| `facts.ts` | Builds the fact sheet. No raw data reaches it |
| `guard.ts` | The number guard and the two other refusals |
| `prompts.ts` | Everything BizMind asks a model to do, readable in full |
| `analyst.ts` | The features, and the single checked path |
| `index.ts` | What the rest of the app may use |

`src/features/analytics/actions.ts` holds the server actions. **They accept a
period key and nothing else** — every figure is fetched server-side for the
business in the session. If the browser could post the numbers to be explained,
a tampered request could have BizMind narrate figures that were never in
anyone's records, and the resulting paragraph would look entirely genuine.

---

## 8. Setup

```bash
npm run ai:check
```

Verifies the key, confirms the configured model exists on the account (and
lists ones that do if it does not), then writes a real explanation of a sample
month and puts it through the guard. It costs a fraction of a penny.

`OPENAI_MODEL` overrides the default in `.env.local`. Model names change faster
than this codebase will, which is why `ai:check` verifies rather than assumes.

---

## 9. Tests

```bash
npm run test:ai
```

63 assertions, no network and no key — the key is deleted from the environment
before anything is imported, so a test that accidentally reached OpenAI would
fail rather than quietly spend money.

The suite covers: what the fact sheet contains and what it must never contain,
the guard accepting supplied figures and rejecting invented ones (including a
correct subtraction the model performed itself, which is still refused), the
known limit above, the two other refusals, safe degradation with no key, that
the prompt says what the code enforces, and the one-door architecture.

---

## 10. What is deliberately not here

- **No chat.** An open text box invites questions the figures cannot answer.
- **No autonomous actions.** Nothing writes, sends or orders. V1 automation is
  rule-based and logged; approval-based actions come later.
- **No AI-generated insights.** The findings on the dashboard come from
  deterministic rules in `src/services/analytics/insights.ts`. A finding that
  says "profit fell while revenue rose" must be true because the arithmetic
  says so, not because a model found the sentence plausible. The AI explains
  those findings. It does not produce them.
