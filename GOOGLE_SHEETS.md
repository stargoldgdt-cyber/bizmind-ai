# Google Sheets

**Steps 1, 2, 3 and 5 of 6 built: the database foundation, the Google
sign-in, applying a sheet's rows, and the connect screen. Change notifications
(step 4) are not built, so a sheet is read when it is connected and when the
owner presses Sync now — not automatically yet.** This records the decisions
made and what each step does.

Official documentation consulted 2026-09-11:
[Drive push notifications](https://developers.google.com/workspace/drive/api/guides/push) ·
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) ·
[Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes) ·
[Sheets limits](https://developers.google.com/workspace/sheets/api/limits) ·
[OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)

---

## 1. Decisions approved by the owner

| Decision | Why |
| --- | --- |
| **Scope `drive.file` + Google Picker** | The only non-sensitive option: BizMind sees only files the user picks. `spreadsheets.readonly` is sensitive and covers *every* spreadsheet; `drive.readonly` is restricted and needs a paid security assessment. The cost: the Picker needs a short-lived (≤ 1 hour) access token in the browser. The refresh token never leaves the server |
| **One tab feeds one business** | A connection's identity is `spreadsheetId:sheetId`, unique across the platform. Keeps notification routing unambiguous |
| **Live-synced expenses need a Reference column** | Without one there is no stable identity. A row number is not an identity — rows move when someone sorts |
| **Order numbers are unique per source** | A website order #1001 and an Amazon order #1001 are different orders. Before 0020 the second was refused, and a page is written all-or-nothing, so everything beside it was lost too |

`drive.file` technically allows *editing* a picked file; Google has no per-file
read-only scope. BizMind will never call a write endpoint.

## 2. How a change reaches BizMind

```
Edit in Sheets → Google calls our webhook (headers only, empty body)
  → token checked in constant time → connection found from the channel row
  → recorded once (channel + message number) → sync queued 20 s later
  → worker re-reads the tab → only new and changed records are written
```

- **Channels expire.** Google caps a `files.watch` channel at one day, so
  channels are renewed before expiry (`watch_renewals_due`).
- **No delivery guarantee.** Google documents none, so a **reconciliation**
  check runs every ~15 minutes. It compares the file's Drive `version` first,
  so an unchanged sheet costs one small API call and no read. It is a safety
  net, not the way changes normally arrive.
- **Bursts collapse.** One queued job per connection and resource, plus the
  20-second grace, means a burst of edits becomes one sync. An edit made while
  a sync is running sets `rerun_requested` and is picked up the moment it ends.
- **Public HTTPS required.** Google only calls a URL with a valid certificate,
  so notifications cannot reach `localhost` without a tunnel. Reconciliation
  works locally.

The UI must never promise a latency. Google publishes none, and it has not
been measured yet.

## 3. Incremental sync — the honest version

Google Sheets cannot say which rows changed, so **every sync re-reads the tab**.
What is incremental is the *writing*. Each business record keeps a fingerprint
of the source content it was built from, **including the mapping it was read
with** — so editing the mapping forces a full re-apply. An unchanged record is
counted and skipped rather than rewritten.

The fingerprint is written only **after** the record is applied. Written first,
a crash in between would leave an edit marked "unchanged" and never applied.

## 4. Deletions

**Not applied.** A record missing from the sheet is marked not present and
reported ("12 orders are in BizMind but no longer in your sheet"). A row that
disappeared is not proof the sale never happened. Same rule as WooCommerce.

## 5. Connection states

| State | Set by | Meaning |
| --- | --- | --- |
| `CONNECTED` | connect, resume, recovery | Syncing normally |
| `ERROR` | the worker, after repeated failure | Provider failing; data intact |
| `PAUSED` | **the owner only** | Nothing syncs until resumed |
| `REAUTH_REQUIRED` | the worker | Google access expired or was revoked |
| `MAPPING_REVIEW_REQUIRED` | the worker | A mapped column was renamed or removed |
| `DISCONNECTED` | **the owner only** | Revoked |

The worker may never pause or disconnect, and never overrides the owner's
choice. Resuming only turns `PAUSED` back into `CONNECTED` — it cannot paper
over a connection that needs attention. Syncing / synced / partial are job and
run states, not connection states, so the screen never has two answers.

## 6. What step 1 built

| Migration | What |
| --- | --- |
| 0019 | `GOOGLE_SHEETS` provider, three connection states, `sync_trigger` |
| 0020 | Pages continue; per-source order numbers; `EXPENSES` resource; source from the connection's channel; running jobs never stolen; pause and worker-set states; sync history counters; batch lineage |
| 0021 | `integration_watch_channels`, `integration_record_state`, and their trusted functions |

Every new function takes a job, account or channel id and derives its tenant.
None takes a business id.

## 6a. What step 2 built — the Google connection

One Google sign-in per business, stored on the business's `GOOGLE_SHEETS`
integration row. Every sheet the business connects uses it.

**The sign-in, in order** (`/api/v1/integrations/google/start` → Google →
`/callback`):

1. Only a signed-in owner or admin can start it.
2. A random state value is sealed into a short-lived, http-only cookie, bound to
   that user and business. The callback refuses anything that does not open for
   the same user and business, has expired (10 minutes), or does not match what
   Google echoed back (compared in constant time). The cookie is cleared on
   every outcome, so it works once.
3. The code is exchanged for tokens **on the server**, with the client secret.
   Only `oauth.ts` reads `GOOGLE_CLIENT_SECRET`.
4. `integration_google_authorize()` records the connection as the signed-in
   owner, under their role check. It never returns the stored credential.
5. The refresh token is sealed to the business and written by the one confined
   writer in `security/`. It is never logged, never returned, never sent to the
   browser.

The browser outcome is only a word in the address bar:
`/integrations?google=connected|denied|expired|forbidden|failed|not_configured|missing_refresh_token|scope_not_granted|rejected|unavailable`.

**Scope** is `drive.file` only — BizMind can open only the files the owner picks
in Google's own file picker. It is a non-sensitive scope, so Google does not
require a security review.

**Choosing a sheet.** The Picker runs in the browser with a short-lived access
token that Google's own script gives the browser. The server never hands a
token to the browser. Listing tabs and previewing rows while connecting
(`google-actions.ts`) uses that same short-lived browser token, owner or admin
only, and never touches the stored refresh token.

**The connector** (`connectors/google-sheets/`) reads only, never writes:

| Step | What happens |
| --- | --- |
| Pass start | Checks the Drive file `version`. Unchanged since last pass → an empty page, no rows read. Trashed → `SOURCE_GONE` |
| Tab identity | Tabs are found by their permanent `sheetId`, so renaming a tab does not break the connection. Deleted → `SOURCE_GONE` |
| Rows | 1,000 rows a page, with the heading row, as `UNFORMATTED_VALUE`. Numbers keep Google's exact digits (`ExactNumber`), never a rounded JavaScript number |
| Headings | The same rules as an Excel upload. No headings → `MAPPING_REVIEW_REQUIRED` |
| Errors | 429 and quota → wait and retry; 401 → `REAUTH_REQUIRED`; 403 → `ACCESS_DENIED`; 404 → `SOURCE_GONE`; 5xx → retry |

**Reconnecting heals every sheet at once.** When a sign-in expires, the worker
marks the sheets `REAUTH_REQUIRED`. Signing in again flips every one of them
back to `CONNECTED`.

**Setup values** — placeholders only, set in `.env.local`, never in chat or in
code: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
`NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER` (public by design — the Picker needs it),
`GOOGLE_WEBHOOK_BASE_URL`, `CRON_SECRET`. See `.env.example`.

**Step 3 (6b) applies the rows, and step 5 (6c) is the connect screen.** Push
notifications (step 4) are still to come.

## 6b. What step 3 built — a sheet's rows into BizMind

A sheet's rows go through **the same checks as an Excel upload**: the same
`validate()`, the same date and number rules, the same apply functions. There
is one mapping engine, not one per source. On top of that, a live sheet follows
these rules (`sync/tabular.ts`, `applyTabularPage()` in `sync/worker.ts`):

| Rule | Why |
| --- | --- |
| **Every record needs an identity** — Order ID, SKU or Reference | A sheet is read again and again, and row numbers move whenever someone sorts or inserts. A row without one is reported and skipped, never given an invented key |
| **An expenses tab must have a Reference column** | Otherwise an edited expense would be counted as a second one (approved decision 3) |
| **All or nothing per record** | If any row of an order has a problem, the order is not written at all and BizMind keeps the version it already has. Writing only the good lines would quietly change cost of goods |
| **Only changes are written** | Each record has a fingerprint. A pass after one edit writes only that edit; an unchanged sheet writes nothing |
| **A page never ends inside an order** | Applying an order replaces its lines, so a page boundary inside an order would drop half of it. The page stops before that order and the next page starts on it |
| **An order split across the sheet is refused** | If one order's rows are far apart and read in separate pages, the later part is refused and reported — never allowed to replace the earlier part's lines |
| **Gone from the sheet = marked, not deleted** | A record missing from a finished pass is marked "no longer in the sheet". Nothing in BizMind is deleted |
| **Exact numbers** | A number cell keeps Google's exact digits and never goes through the thousands/decimal separator rules — with a comma-decimal setting, `1234.56` would otherwise become `123456`. Dates arrive as the same serial number Excel uses and are read the same way |
| **Other currencies are refused** | As in an upload. Nothing is converted |

Problems are recorded in `import_issues` at the **real sheet row**, where an
upload's problems go. A problem is reported when its record is new or changed,
not again on every pass while nobody has touched the row.

**Waiting for a person is not a failure.** If Google needs reconnecting, or a
chosen column has left the sheet, the connection shows `REAUTH_REQUIRED` or
`MAPPING_REVIEW_REQUIRED` and its job waits. Reconnecting Google, or confirming
the columns again, turns it back on and the job simply continues.

**When syncing runs:**

| Trigger | What happens |
| --- | --- |
| Connecting a tab | The first import starts straight after the owner's request, in the background (`after()`), for up to 50 seconds |
| "Sync now" | The same, for one tab |
| The schedule | `/api/v1/integrations/sync/run`, protected by `CRON_SECRET`. Queues every sheet quiet for 15 minutes (the safety net for missed notifications), then works through the queue for up to 45 seconds. **No schedule is set up yet** — that is part of deployment |

Anything not finished in one run is picked up by the next. The background work
uses the worker's privileged path: nothing it does is returned to the owner's
request, and the worker takes no business id.

## 6c. What step 5 built — the connect screen

On **Integrations**, a Google Sheets section:

1. **Connect Google** — the step-2 sign-in. Owner or admin only.
2. **Add a sheet** — Google's own picker, showing native Google Sheets files
   only. The browser gets a short-lived token from Google's script for this;
   it is held in memory while connecting and never stored. The picker needs a
   browser API key: see DECISIONS.md, 2026-09-11.
3. **Choose the tab and what it holds** — orders, products or expenses.
4. **Match columns** — the same fields, importance levels and warnings as an
   upload. Suggestions come from the headings, and every one is shown for
   checking. The worker's own checks run on the server before anything is
   saved, so a missing Reference column on an expenses tab is refused here, not
   a minute later.
5. **Connect and import** — the first import starts at once, in the background.

Each connected sheet shows its state in words and an icon (never colour
alone), its last successful sync, what is running now, its recent syncs (why
each ran; rows added, updated, unchanged and skipped), the latest row problems
with their real sheet rows, and how many records are no longer in the sheet —
with "nothing was deleted" said plainly.

Actions: **Sync now**, **Pause / Resume**, **Change columns** (reads the sheet
again with a fresh Google sign-in), and **Disconnect** (behind a confirmation;
records already imported stay).

While a sheet is syncing, the page refreshes itself every few seconds, for at
most three minutes. It shows what is known — queued, running, rows written —
never a percentage or a time estimate.

**Not in this step:** automatic updates (step 4, and a schedule at deployment),
and the "what does this column mean?" questions an upload asks about columns
it does not map (see Known limits).

## 7. Known limits

1. **While the Google app is in "Testing", refresh tokens expire after 7 days.**
   Test connections will break weekly until the app is published.
2. Google allows 60 read requests per minute per user. A very large sheet takes
   minutes per change.
3. Volatile formulas (`NOW()`, `RAND()`) may bump the file version constantly.
   Mitigated by the grace period and fingerprints, but it spends quota.
4. Sheets stores numbers as binary doubles. BizMind will import Google's exact
   stored digits, which can differ from the rounded value a cell displays.
5. Google allows 100 refresh tokens per account per OAuth client.
6. Money is stored to 4 decimal places, as for uploads: a cell holding a
   formula's floating-point residue such as `0.30000000000000004` is stored as
   `0.3000`.
7. A figure too large for the database (more than 16 digits before the point)
   makes its whole page fail, and after repeated failures the sheet stops with
   an error. The same value fails an upload too. Fix the cell, then Sync now.
8. Dates are read as Excel reads them: the sheet's time zone is not applied.
9. One Google account per business (V1).
10. A sheet's unmapped columns are not kept, so the upload's "what does this
    column mean?" step is not offered for sheets yet.

## 8. Tests

`npm run test:integration-live`, section 10: connecting a tab, one tab per
business, a products tab without a sales channel, channel lookup and token
secrecy, handshake / change / duplicate / forged / unknown notifications,
renewal, fingerprint classification, missing-record reporting without
deletion, reconciliation, and that no signed-in user can reach any of it.

`npm run test:integration-live`, section 11 (migration 0022): an owner can
record a Google sign-in, the response carries no credential, the stored
credential can be neither read nor written by a signed-in user, `select *` is
refused, another business cannot connect Google on this one's behalf,
reconnecting repairs every sheet waiting for it, and the worker falls back to
the business's sign-in only when a connection has none of its own.

`npm run test:integration-live`, section 12 (migration 0023): the REAL worker
writes pages into the real database, with only Google absent. It proves the
worker is told the business's currency; a figure stays exact under comma
decimals; each problem is reported at its real sheet row; an order whose only
row is unreadable is not written; an order met again later in the same pass
is refused and its lines are not replaced; an unchanged sheet writes nothing;
one changed cell updates only its order; a record gone from a finished pass
is marked, never deleted; a sheet whose columns changed waits for its owner
and comes back when they are confirmed; a job cannot attach problems to
another connection's import; and a DEAD_LETTER from the worker is final.

`npm run test:google-sheets` — 127 assertions, no network, no database. It runs
against a **clearly labelled fake Google** (`fakeGoogle`), kept separate from
the real integration: consent URL, code exchange and its failures, token
refresh, sealed state (wrong user, wrong business, expired, tampered), range
quoting, exact numbers, heading rules, pagination, the version shortcut,
renamed and deleted tabs, error classification, and that no token or secret
appears in any result or log line.
