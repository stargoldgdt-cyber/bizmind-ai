# Google Sheets

**Foundation built — step 1 of 6. There is no Google connector yet, and nothing
in BizMind talks to Google.** This records the decisions already made and what
the database now does, so the connector is built against a settled design.

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

## 8. Tests

`npm run test:integration-live`, section 10: connecting a tab, one tab per
business, a products tab without a sales channel, channel lookup and token
secrecy, handshake / change / duplicate / forged / unknown notifications,
renewal, fingerprint classification, missing-record reporting without
deletion, reconciliation, and that no signed-in user can reach any of it.
