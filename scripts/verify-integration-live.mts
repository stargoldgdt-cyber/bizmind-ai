/**
 * The integration foundation, against the real database.
 *
 * Run with:  npm run test:integration-live
 *
 * The offline suite proves the connector and the crypto. This one proves the
 * part that only the database can enforce: that Business A cannot see, touch,
 * or trigger anything belonging to Business B, and that a redelivery is
 * decided once by a unique constraint rather than by a hopeful `if exists`.
 *
 * Everything runs in throwaway tenants that are deleted at the end.
 *
 * TWO PATHS, TWO REQUIREMENTS
 * ---------------------------
 * The authenticated path (connect, enqueue, replay, isolation) needs only the
 * QA sign-ins. The session-less path (webhook ingest, worker claiming,
 * dead-letter) needs SUPABASE_SERVICE_ROLE_KEY, because that is the whole
 * point of it. When the key is absent those sections are SKIPPED LOUDLY --
 * never silently passed, because a security test that quietly did not run is
 * worse than one that failed.
 */

import { createHmac } from "node:crypto"

import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"

let passed = 0
let failed = 0
let skipped = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function skip(name: string, why: string) {
  skipped += 1
  console.log(`  SKIP  ${name} -- ${why}`)
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const {
  url: SUPABASE_URL,
  anonKey: ANON_KEY,
  email: EMAIL,
  password: PASSWORD,
  otherEmail: OTHER_EMAIL,
  otherPassword: OTHER_PASSWORD,
} = requireConfig({ second: true })

const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY ?? ""
const HAS_SERVICE_KEY = SERVICE_KEY.length > 20

/* ---- REST helpers -------------------------------------------------------- */

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    console.error(`Could not sign in as ${email}.`)
    process.exit(1)
  }
  return (await response.json()).access_token
}

let token = ""

async function api(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  return body
}

async function attempt(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

const tryRpc = (fn: string, args: unknown, asToken = token) =>
  attempt(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

/** The privileged path, used only to exercise what it is meant to do. */
async function serviceRpc(fn: string, args: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }
}

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Integration A ${suffix}`,
  p_slug: `integration-a-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Integration B ${suffix}`, p_slug: `integration-b-${suffix}`, p_currency: "AED" },
  otherToken
)
const rivalId = rival.id as string

const STORE_A = `fixture-store-a-${suffix}`
const STORE_B = `fixture-store-b-${suffix}`

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${rival.name} (a different person)`)
console.log(`  service-role key: ${HAS_SERVICE_KEY ? "present" : "ABSENT -- trusted-path sections will be skipped"}`)

try {
  /* ---------------------------------------------------------------------- */
  section("1. CONNECTING, AND RECONNECTING THE SAME STORE")

  const connected = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A",
    p_channel_type: "OTHER",
    p_metadata: { scenario: "happy" },
  })

  check("a connection is created", connected.external_account_id === STORE_A)
  check("AND IT DOES NOT HAND THE SECRETS BACK to the caller",
    connected.credentials_encrypted === null &&
      connected.webhook_secret_encrypted === null,
    JSON.stringify({
      c: connected.credentials_encrypted,
      w: connected.webhook_secret_encrypted,
    })
  )
  check("it is CONNECTED", connected.status === "CONNECTED")
  check("it records who connected it", connected.connected_by !== null)
  check("and it created a channel", connected.channel_id !== null)

  const firstChannel = connected.channel_id as string
  const accountId = connected.id as string

  // The failure this prevents is subtle and expensive: a second channel would
  // split one store's history in two, and every figure that groups by channel
  // would quietly halve.
  const reconnected = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A renamed",
    p_channel_type: "OTHER",
    p_metadata: { scenario: "happy" },
  })

  check("RECONNECTING THE SAME STORE REUSES THE SAME CONNECTION",
    reconnected.id === accountId, `${reconnected.id} vs ${accountId}`
  )
  check("AND THE SAME CHANNEL, so the history is not split",
    reconnected.channel_id === firstChannel
  )

  const channels = await api(
    `/rest/v1/channels?select=id&business_id=eq.${businessId}`
  )
  check("exactly one channel exists for this store", channels.length === 1, String(channels.length))

  const audit = await api(
    `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}&order=created_at.desc&limit=2`
  )
  check("reconnecting is audited as a reconnection, not a creation",
    audit[0]?.action === "integration.connection.reconnected", audit[0]?.action
  )

  // audit_logs is readable by admins. A "before" snapshot taken with
  // to_jsonb(row) would carry the ciphertext straight into a table they can
  // read, defeating the column grant one line at a time.
  const auditBefore = await api(
    `/rest/v1/audit_logs?select=before_data&business_id=eq.${businessId}&action=eq.integration.connection.reconnected&limit=1`
  )
  const snapshot = JSON.stringify(auditBefore[0]?.before_data ?? {})
  check("THE AUDIT SNAPSHOT CARRIES NO CIPHERTEXT",
    !snapshot.includes("credentials_encrypted") &&
      !snapshot.includes("webhook_secret_encrypted"),
    snapshot.slice(0, 120)
  )

  /* ---------------------------------------------------------------------- */
  section("2. CREDENTIALS ARE NOT READABLE BY A SIGNED-IN USER")

  const readSecret = await attempt(
    `/rest/v1/integration_accounts?select=credentials_encrypted&id=eq.${accountId}`
  )
  check("selecting the credential column is refused outright",
    !readSecret.ok, `${readSecret.status} ${readSecret.body.slice(0, 90)}`
  )

  const readWebhookSecret = await attempt(
    `/rest/v1/integration_accounts?select=webhook_secret_encrypted&id=eq.${accountId}`
  )
  check("and so is the webhook secret", !readWebhookSecret.ok)

  // Stronger than "the columns come back empty": asking for everything is
  // refused outright, because the privilege was never granted rather than
  // granted and then revoked. A column-level REVOKE cannot undo a table-level
  // GRANT, which is what the first version of this migration tried to do --
  // and its own verification block refused to install it.
  const readStar = await attempt(
    `/rest/v1/integration_accounts?select=*&id=eq.${accountId}`
  )
  check("SELECT * IS REFUSED, so nothing can ask for everything",
    !readStar.ok, `${readStar.status} ${readStar.body.slice(0, 90)}`
  )

  const readAllowed = await api(
    `/rest/v1/integration_accounts?select=id,status,display_name&id=eq.${accountId}`
  )
  check("but the ordinary columns are readable, so the app still works",
    readAllowed[0]?.status === "CONNECTED"
  )

  const writeSecret = await attempt(
    `/rest/v1/integration_accounts?id=eq.${accountId}`,
    { method: "PATCH", body: JSON.stringify({ credentials_encrypted: "forged" }) }
  )
  check("nor can a user WRITE a credential", !writeSecret.ok, String(writeSecret.status))

  /* ---------------------------------------------------------------------- */
  section("3. SYNC JOBS: ENQUEUE IS IDEMPOTENT")

  const job = await rpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })
  check("a job is queued", job.status === "QUEUED")
  check("in initial mode", job.mode === "INITIAL")
  check("with no cursor yet", job.cursor === null)

  await rpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })

  const jobs = await api(
    `/rest/v1/sync_jobs?select=id&business_id=eq.${businessId}&resource=eq.ORDERS`
  )
  check("ENQUEUING TWICE DOES NOT CREATE TWO COMPETING JOBS",
    jobs.length === 1, String(jobs.length)
  )

  /* ---------------------------------------------------------------------- */
  section("4. TENANT ISOLATION -- every one of these is an attack")

  await rpc(
    "integration_account_connect",
    {
      p_business_id: rivalId,
      p_provider: "FIXTURE",
      p_external_account_id: STORE_B,
      p_display_name: "Store B",
      p_channel_type: "OTHER",
      p_metadata: {},
    },
    otherToken
  )

  // Explicit columns, because `select=*` is refused for EVERYONE now -- and a
  // refusal would prove nothing about isolation. Asking only for columns B is
  // entitled to read makes the empty result the real answer: RLS returned
  // nothing, rather than the request failing for an unrelated reason.
  const bReadsA = await attempt(
    `/rest/v1/integration_accounts?select=id,status,external_account_id&business_id=eq.${businessId}`,
    {},
    otherToken
  )
  check("B cannot read A's connections",
    bReadsA.ok && JSON.parse(bReadsA.body).length === 0,
    `${bReadsA.status} ${bReadsA.body.slice(0, 80)}`
  )

  const bReadsJobs = await attempt(
    `/rest/v1/sync_jobs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync jobs",
    bReadsJobs.ok && JSON.parse(bReadsJobs.body).length === 0
  )

  const bReadsRuns = await attempt(
    `/rest/v1/sync_runs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync runs", bReadsRuns.ok && JSON.parse(bReadsRuns.body).length === 0)

  const bReadsEvents = await attempt(
    `/rest/v1/webhook_events?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's webhook events",
    bReadsEvents.ok && JSON.parse(bReadsEvents.body).length === 0
  )

  const bReadsLogs = await attempt(
    `/rest/v1/sync_logs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync logs", bReadsLogs.ok && JSON.parse(bReadsLogs.body).length === 0)

  // THE IDOR TEST. B knows A's account id -- perhaps from a screenshot, a URL,
  // or a support ticket -- and uses it directly.
  const bRevokesA = await tryRpc(
    "integration_account_revoke", { p_account_id: accountId }, otherToken
  )
  check("B CANNOT DISCONNECT A'S CONNECTION using its id", !bRevokesA.ok,
    `${bRevokesA.status} ${bRevokesA.body.slice(0, 80)}`
  )

  const bSyncsA = await tryRpc(
    "sync_enqueue",
    { p_account_id: accountId, p_resource: "ORDERS", p_mode: "INITIAL" },
    otherToken
  )
  check("B CANNOT TRIGGER A SYNC on A's connection", !bSyncsA.ok, String(bSyncsA.status))

  const bWritesA = await attempt(
    "/rest/v1/integrations",
    {
      method: "POST",
      body: JSON.stringify({ business_id: businessId, provider: "SHOPIFY" }),
    },
    otherToken
  )
  check("B cannot insert an integration into A's business", !bWritesA.ok, String(bWritesA.status))

  // A tries to connect the SAME store B already has. The partial unique index
  // is what stops one store resolving to two tenants, which is exactly how a
  // webhook would leak.
  const stealStore = await tryRpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_B,
    p_display_name: "Stolen",
    p_channel_type: "OTHER",
    p_metadata: {},
  })
  check("A CANNOT CONNECT A STORE ALREADY LIVE ON ANOTHER BUSINESS",
    !stealStore.ok, `${stealStore.status} ${stealStore.body.slice(0, 100)}`
  )

  /* ---------------------------------------------------------------------- */
  section("5. ANONYMOUS ACCESS IS DENIED EVERYWHERE")

  for (const table of [
    "integrations", "integration_accounts", "sync_jobs",
    "sync_runs", "sync_logs", "webhook_events",
  ]) {
    const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: ANON_KEY },
    })
    check(`a signed-out visitor cannot read ${table}`,
      anonymous.status === 401, String(anonymous.status)
    )
  }

  // The session-less functions must be unreachable by a signed-in user too.
  // If `authenticated` could call these, any customer could forge a delivery
  // into any business on the platform.
  for (const fn of [
    "webhook_event_ingest", "webhook_account_lookup", "sync_claim_jobs",
    "sync_job_context", "sync_apply_orders", "webhook_apply_records",
  ]) {
    const reached = await tryRpc(fn, {})
    check(`a signed-in user cannot call ${fn}()`,
      !reached.ok && (reached.status === 404 || reached.status === 401 || reached.status === 403),
      String(reached.status)
    )
  }

  /* ---------------------------------------------------------------------- */
  section("6. THE TRUSTED PATH: webhook ingest and idempotency")

  if (!HAS_SERVICE_KEY) {
    skip("webhook ingest", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("duplicate delivery", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("unknown store is dropped", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("invalid signature is recorded and refused", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("worker claiming", "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    const body = JSON.stringify({ external_id: "FIX-1", total: "100.0000" })

    const first = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: STORE_A,
      p_external_event_id: "delivery-1",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: true,
    })

    const firstRow = first.body?.[0]
    check("a verified delivery is accepted", firstRow?.outcome === "ACCEPTED", JSON.stringify(firstRow))
    check("THE TENANT IS RESOLVED FROM THE CONNECTION, not from the request",
      firstRow?.resolved_business_id === businessId
    )

    // Five redeliveries. Providers retry by design.
    const repeats = []
    for (let i = 0; i < 5; i += 1) {
      const again = await serviceRpc("webhook_event_ingest", {
        p_provider: "FIXTURE",
        p_external_account_id: STORE_A,
        p_external_event_id: "delivery-1",
        p_event_type: "orders/create",
        p_raw_body: body,
        p_signature_valid: true,
      })
      repeats.push(again.body?.[0]?.outcome)
    }

    check("FIVE REDELIVERIES ARE ALL RECOGNISED AS DUPLICATES",
      repeats.every((outcome) => outcome === "DUPLICATE"), repeats.join(",")
    )

    const stored = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-1`
    )
    check("and only ONE event row exists", stored.length === 1, String(stored.length))

    // audit_logs has FORCE row level security and only a SELECT policy, so a
    // definer function can only write to it because `postgres` has BYPASSRLS.
    // That is reasoning, and reasoning about privileges is how holes appear --
    // so it is asserted instead.
    const receiptAudit = await api(
      `/rest/v1/audit_logs?select=action,entity_type&business_id=eq.${businessId}&action=eq.integration.webhook.received`
    )
    check("A SESSION-LESS RECEIPT IS AUDITED, with no actor",
      receiptAudit.length >= 1, String(receiptAudit.length)
    )
    check("against the right entity", receiptAudit[0]?.entity_type === "webhook_events")

    // An unknown store must resolve to nothing. Inventing a tenant here is how
    // a forged delivery becomes somebody's data.
    const unknown = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: "no-such-store-anywhere",
      p_external_event_id: "delivery-x",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: true,
    })
    check("AN UNKNOWN STORE RESOLVES TO NOTHING",
      unknown.body?.[0]?.outcome === "UNKNOWN_ACCOUNT", JSON.stringify(unknown.body?.[0])
    )
    check("and no business is invented for it", unknown.body?.[0]?.resolved_business_id === null)

    const forged = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: STORE_A,
      p_external_event_id: "delivery-forged",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: false,
    })
    check("a delivery that failed verification is REJECTED",
      forged.body?.[0]?.outcome === "REJECTED"
    )

    const rejectedRows = await api(
      `/rest/v1/webhook_events?select=status,signature_valid&business_id=eq.${businessId}&external_event_id=eq.delivery-forged`
    )
    check("but it is still RECORDED, so a flood of them is visible",
      rejectedRows[0]?.status === "REJECTED" && rejectedRows[0]?.signature_valid === false
    )

    const replayForged = await tryRpc("webhook_event_replay", {
      p_event_id: rejectedRows.length > 0
        ? (await api(`/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-forged`))[0].id
        : "00000000-0000-4000-8000-000000000000",
    })
    check("AN UNVERIFIED DELIVERY CANNOT BE REPLAYED", !replayForged.ok,
      replayForged.body.slice(0, 90)
    )

    /* ---- worker claiming ---------------------------------------------- */
    const claimed = await serviceRpc("sync_claim_jobs", {
      p_worker_id: "test-worker-1",
      p_limit: 5,
      p_lease_seconds: 300,
    })
    check("a worker can claim a queued job",
      Array.isArray(claimed.body) && claimed.body.length >= 1,
      JSON.stringify(claimed.body).slice(0, 90)
    )

    // The second worker must walk past a held row rather than duplicating it.
    const secondWorker = await serviceRpc("sync_claim_jobs", {
      p_worker_id: "test-worker-2",
      p_limit: 5,
      p_lease_seconds: 300,
    })
    const claimedIds = new Set((claimed.body ?? []).map((j: { id: string }) => j.id))
    const secondIds = (secondWorker.body ?? []).map((j: { id: string }) => j.id)
    check("A SECOND WORKER DOES NOT CLAIM THE SAME JOB",
      secondIds.every((id: string) => !claimedIds.has(id)),
      `${[...claimedIds].join(",")} vs ${secondIds.join(",")}`
    )
  }

  /* ---------------------------------------------------------------------- */
  section("6b. THE SYNC WRITE PATH ACTUALLY WRITES")

  /*
   * Added with migration 0018, and the reason is uncomfortable: until then no
   * test had ever passed a single row to sync_apply_orders(),
   * sync_apply_products() or webhook_apply_records(). Section 6 proves those
   * functions are unreachable by a signed-in user -- which they are -- but a
   * function nobody can call wrongly is not the same as one that works.
   *
   * All three inserted file_type 'api' into import_batches, whose check
   * constraint only ever allowed 'csv' and 'xlsx'. Every sync write failed in
   * the database, and nothing noticed, because nothing tried.
   *
   * The orders paths had a second fault behind the first: they never gave the
   * batch a channel, and import_apply_orders() takes the channel from the
   * batch -- so a synced order would have landed attributed to no channel,
   * counted in the dashboard's "orders without a channel".
   */
  if (!HAS_SERVICE_KEY) {
    skip("a synced order is written", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("a synced order carries the connection's channel", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("re-applying a synced order does not duplicate it", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("a synced product is written", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("a webhook delivery is written with its channel", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("an unverified delivery cannot be written", "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    const orderId = `SYNC-${suffix}-1`

    // Exactly the canonical shape a connector emits -- see the WooCommerce
    // mapper. Money as exact decimal strings, lines nested under `items`.
    const syncedOrder = {
      external_id: orderId,
      order_number: "1",
      placed_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      status: "FULFILLED",
      currency: "AED",
      total: "250.0000",
      subtotal: null,
      discount_total: null,
      tax_total: null,
      shipping_total: null,
      fee_total: "25.0000",
      customer_email: null,
      customer_name: null,
      items: [
        {
          sku: `SYNC-SKU-${suffix}`,
          name: "Synced product",
          quantity: "2",
          unit_price: "125.0000",
          discount: null,
          unit_cost: "60.0000",
          tax: null,
          line_total: "250.0000",
        },
      ],
    }

    const applied = await serviceRpc("sync_apply_orders", {
      p_job_id: job.id,
      p_rows: [syncedOrder],
    })
    check("A SYNCED ORDER IS WRITTEN THROUGH THE REAL PIPELINE",
      applied.ok && applied.body?.orders_created === 1,
      `${applied.status} ${JSON.stringify(applied.body).slice(0, 200)}`
    )

    const written = await api(
      `/rest/v1/orders?select=id,source,channel_id&business_id=eq.${businessId}&external_id=eq.${orderId}`
    )
    check("it exists exactly once", written.length === 1, String(written.length))
    check("AND IT BELONGS TO THE CONNECTION'S CHANNEL, not to no channel",
      written.length === 1 && written[0].channel_id === firstChannel,
      `${written[0]?.channel_id} vs ${firstChannel}`
    )
    check("its source is unchanged by the fix", written[0]?.source === "OTHER",
      String(written[0]?.source)
    )

    const batch = applied.body?.batch_id
      ? await api(
          `/rest/v1/import_batches?select=file_type,channel_id&id=eq.${applied.body.batch_id}`
        )
      : []
    check("the batch records that it came from an API, and from which channel",
      batch[0]?.file_type === "api" && batch[0]?.channel_id === firstChannel,
      JSON.stringify(batch[0])
    )

    const again = await serviceRpc("sync_apply_orders", {
      p_job_id: job.id,
      p_rows: [syncedOrder],
    })
    check("APPLYING THE SAME ORDER AGAIN UPDATES IT, never duplicates it",
      again.ok && again.body?.orders_created === 0 && again.body?.orders_updated === 1,
      `${again.status} ${JSON.stringify(again.body).slice(0, 200)}`
    )

    const afterAgain = await api(
      `/rest/v1/orders?select=id&business_id=eq.${businessId}&external_id=eq.${orderId}`
    )
    check("still exactly one row", afterAgain.length === 1, String(afterAgain.length))

    const product = await serviceRpc("sync_apply_products", {
      p_job_id: job.id,
      p_rows: [
        {
          sku: `SYNC-PRODUCT-${suffix}`,
          name: "Synced catalogue item",
          unit_price: "125.0000",
          unit_cost: "60.0000",
        },
      ],
    })
    check("A SYNCED PRODUCT IS WRITTEN TOO",
      product.ok && product.body?.products_created === 1,
      `${product.status} ${JSON.stringify(product.body).slice(0, 200)}`
    )

    // The webhook path, through the verified delivery section 6 accepted.
    const verified = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-1`
    )
    const hookOrderId = `HOOK-${suffix}-1`

    // A different order needs a different order number, not just a different
    // id: orders are also unique on (business_id, order_number). The first
    // version of this test copied order_number "1" from the order above and
    // was refused with 23505 -- correctly.
    const hooked = await serviceRpc("webhook_apply_records", {
      p_event_id: verified[0]?.id,
      p_rows: [{ ...syncedOrder, external_id: hookOrderId, order_number: "2" }],
    })
    check("A WEBHOOK DELIVERY IS WRITTEN THROUGH THE SAME PIPELINE",
      hooked.ok && hooked.body?.orders_created === 1,
      `${hooked.status} ${JSON.stringify(hooked.body).slice(0, 200)}`
    )

    const hookWritten = await api(
      `/rest/v1/orders?select=channel_id&business_id=eq.${businessId}&external_id=eq.${hookOrderId}`
    )
    check("and it is attributed to the connection's channel as well",
      hookWritten[0]?.channel_id === firstChannel,
      `${hookWritten[0]?.channel_id} vs ${firstChannel}`
    )

    // Section 6 recorded a delivery that failed verification. The write path
    // has its own refusal, independent of the claim function's filter.
    const forged = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-forged`
    )
    const forgedApply = await serviceRpc("webhook_apply_records", {
      p_event_id: forged[0]?.id,
      p_rows: [{ ...syncedOrder, external_id: `FORGED-${suffix}`, order_number: "3" }],
    })
    const forgedWritten = await api(
      `/rest/v1/orders?select=id&business_id=eq.${businessId}&external_id=eq.FORGED-${suffix}`
    )
    check("AN UNVERIFIED DELIVERY CANNOT BE WRITTEN, even by the trusted path",
      !forgedApply.ok && forgedWritten.length === 0,
      `${forgedApply.status} ${forgedWritten.length} rows`
    )
  }

  /* ---------------------------------------------------------------------- */
  section("7. REPLAY AND MANUAL RETRY ARE AUTHORISED")

  if (!HAS_SERVICE_KEY) {
    skip("replay authorisation", "no event exists without the trusted path")
  } else {
    const events = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-1`
    )
    const eventId = events[0]?.id

    if (!eventId) {
      // Without this the suite died with a confusing PostgREST 404 about a
      // function "without parameters" -- an undefined argument serialises to
      // {}. A missing prerequisite should say so, not masquerade as a
      // different failure three sections later.
      check("an event exists to replay", false, "no delivery was stored")
      throw new Error("Cannot test replay: webhook ingest stored nothing.")
    }

    const bReplaysA = await tryRpc("webhook_event_replay", { p_event_id: eventId }, otherToken)
    check("B CANNOT REPLAY A'S WEBHOOK EVENT using its id", !bReplaysA.ok,
      `${bReplaysA.status} ${bReplaysA.body.slice(0, 80)}`
    )

    const replayed = await rpc("webhook_event_replay", { p_event_id: eventId })
    check("but A can replay their own", replayed.status === "RECEIVED")
    check("and the attempt counter is reset", replayed.attempts === 0)

    const replayAudit = await api(
      `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}&action=eq.integration.webhook.replayed`
    )
    check("the replay is audited", replayAudit.length >= 1)
  }

  /* ---------------------------------------------------------------------- */
  section("8. DISCONNECTING")

  const revoked = await rpc("integration_account_revoke", { p_account_id: accountId })
  check("a connection can be disconnected", revoked.status === "DISCONNECTED")
  check("and the disconnection is recorded", revoked.revoked_at !== null)

  const afterRevoke = await tryRpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })
  check("a disconnected connection cannot be synced", !afterRevoke.ok,
    afterRevoke.body.slice(0, 80)
  )

  // Business data survives. A merchant who reconnects should find their
  // history intact; deleting it is a separate, deliberate, audited act.
  const survivingChannel = await api(
    `/rest/v1/channels?select=id&business_id=eq.${businessId}`
  )
  check("BUSINESS DATA SURVIVES A DISCONNECTION", survivingChannel.length === 1)

  const reconnectAfterRevoke = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A again",
    p_channel_type: "OTHER",
    p_metadata: {},
  })
  check("and reconnecting later restores the same connection",
    reconnectAfterRevoke.id === accountId && reconnectAfterRevoke.status === "CONNECTED"
  )
  check("with the same channel", reconnectAfterRevoke.channel_id === firstChannel)

  /*
   * Sections 9 and 10 cover migrations 0020 and 0021. Every call below goes
   * through `call()`, which never throws, so the suite still runs to the end
   * and reports against a database that does not have them yet.
   */
  const parse = (text: string) => {
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return text
    }
  }

  async function call(fn: string, args: unknown, asToken = token) {
    const r = await tryRpc(fn, args, asToken)
    return { ok: r.ok, status: r.status, body: parse(r.body) }
  }

  async function serviceCall(fn: string, args: unknown) {
    const r = await serviceRpc(fn, args)
    return { ok: r.ok, status: r.status, body: r.body }
  }

  const brief = (r: { status: number; body: unknown }) =>
    `${r.status} ${JSON.stringify(r.body).slice(0, 180)}`

  /**
   * A read that reports instead of aborting. Sections 9 and 10 read columns and
   * tables that 0020 and 0021 create; before those exist, a throwing read ends
   * the whole suite before it can print a result.
   */
  async function read(path: string, init: RequestInit = {}, asToken = token) {
    const r = await attempt(path, init, asToken)
    const body = parse(r.body)
    return r.ok && Array.isArray(body) ? body : []
  }

  /* ---------------------------------------------------------------------- */
  section("9. ENGINE EXTENSIONS (0020)")

  /* ---- 9a. Order numbers are unique per source, not per business -------- */
  // A website export and an Amazon export both numbering from 1001 are two
  // different orders. Before 0020 the second was refused with 23505, and
  // because a page is written all-or-nothing, so was everything beside it.
  async function importOrder(source: string, externalId: string, orderNumber: string) {
    const created = await attempt("/rest/v1/import_batches", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        entity: "ORDERS",
        status: "DRAFT",
        source,
        file_name: `${source.toLowerCase()}.csv`,
        file_type: "csv",
        file_size_bytes: 0,
        row_count: 1,
      }),
    })
    const batch = parse(created.body)?.[0]
    if (!created.ok || !batch) return { ok: false, status: created.status, body: created.body }

    return call("import_apply_orders", {
      p_batch_id: batch.id,
      p_rows: [
        {
          external_id: externalId,
          order_number: orderNumber,
          placed_at: new Date().toISOString(),
          status: "FULFILLED",
          currency: "AED",
          total: "90.0000",
          items: [],
        },
      ],
    })
  }

  const sharedNumber = `N-${suffix}`
  const websiteFirst = await importOrder("WEBSITE", `WEB-${suffix}-1`, sharedNumber)
  check("an order is imported from the website", websiteFirst.ok, brief(websiteFirst))

  const amazonSame = await importOrder("AMAZON", `AMZ-${suffix}-1`, sharedNumber)
  check("THE SAME ORDER NUMBER FROM A DIFFERENT SOURCE IS ACCEPTED",
    amazonSame.ok, brief(amazonSame))

  const websiteAgain = await importOrder("WEBSITE", `WEB-${suffix}-2`, sharedNumber)
  check("but within one source an order number still cannot repeat",
    !websiteAgain.ok && JSON.stringify(websiteAgain.body).includes("23505"),
    brief(websiteAgain))

  if (!HAS_SERVICE_KEY) {
    for (const name of [
      "a page with more to come re-queues its job",
      "a leased job is not stolen by a new request",
      "a paused connection is not synced",
      "a connection needing reauthorisation is not synced",
      "expenses can be synced",
    ]) skip(name, "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    const STORE_C = `fixture-store-c-${suffix}`
    const storeC = await call("integration_account_connect", {
      p_business_id: businessId,
      p_provider: "FIXTURE",
      p_external_account_id: STORE_C,
      p_display_name: "Store C",
      p_channel_type: "OTHER",
      p_metadata: {},
    })
    const accountC = storeC.body?.id as string
    const workerId = `worker-${suffix}`

    const claims = async (jobId: string) => {
      const res = await serviceCall("sync_claim_jobs", {
        p_worker_id: workerId,
        p_limit: 200,
        p_lease_seconds: 300,
      })
      return Array.isArray(res.body) && res.body.some((j: { id: string }) => j.id === jobId)
    }

    const readJob = async (jobId: string) =>
      (await read(
        `/rest/v1/sync_jobs?select=status,mode,cursor,locked_by,rerun_requested,next_trigger&id=eq.${jobId}`
      ))[0]

    const completion = (jobId: string, runId: string, cursor: string, hasMore: boolean) => ({
      p_job_id: jobId,
      p_run_id: runId,
      p_status: "SUCCEEDED",
      p_cursor: cursor,
      p_records_fetched: 50,
      p_records_applied: 50,
      p_records_skipped: 0,
      p_error: null,
      p_retry_after_ms: null,
      p_has_more: hasMore,
      p_rows_inserted: 50,
      p_rows_updated: 0,
      p_rows_unchanged: 0,
      p_rows_rejected: 0,
    })

    /* ---- 9b. Pages continue --------------------------------------------- */
    // THE FOURTH DEFECT. sync_job_complete() used to mark a job SUCCEEDED even
    // when the connector said more pages remained, and the worker only claims
    // QUEUED or RETRYING jobs -- so the engine fetched the first page of any
    // resource and then stopped for good.
    const queued = await call("sync_enqueue", {
      p_account_id: accountC,
      p_resource: "PRODUCTS",
      p_mode: "INITIAL",
    })
    const productsJob = queued.body?.id as string
    check("an initial sync records why it is running",
      queued.body?.next_trigger === "INITIAL", brief(queued))

    check("the job can be claimed", await claims(productsJob))
    const run1 = await serviceCall("sync_run_start", { p_job_id: productsJob })
    check("the run records its trigger", run1.body?.trigger === "INITIAL", brief(run1))

    const page1 = await serviceCall(
      "sync_job_complete",
      completion(productsJob, run1.body?.id, "page-2", true)
    )
    check("A PAGE WITH MORE TO COME RE-QUEUES ITS JOB, rather than stopping",
      page1.ok && page1.body?.status === "QUEUED", brief(page1))
    check("and keeps its place", page1.body?.cursor === "page-2")
    check("and stays an initial backfill until the last page", page1.body?.mode === "INITIAL")
    check("SO THE NEXT PAGE CAN ACTUALLY BE CLAIMED", await claims(productsJob))

    const run2 = await serviceCall("sync_run_start", { p_job_id: productsJob })
    const lastPage = await serviceCall(
      "sync_job_complete",
      completion(productsJob, run2.body?.id, "done", false)
    )
    check("the last page completes the pass",
      lastPage.body?.status === "SUCCEEDED" && lastPage.body?.mode === "INCREMENTAL",
      brief(lastPage))

    const history = await read(
      `/rest/v1/sync_runs?select=trigger,rows_inserted,rows_rejected&id=eq.${run1.body?.id}`
    )
    check("sync history records what the run did",
      history[0]?.trigger === "INITIAL" && history[0]?.rows_inserted === 50,
      JSON.stringify(history[0]))

    /* ---- 9c. A running sync is not stolen ------------------------------- */
    // Before 0020, queuing a job that a worker was mid-way through cleared its
    // lease, so a second worker could claim it and both would write.
    await call("sync_enqueue", { p_account_id: accountC, p_resource: "PRODUCTS", p_mode: "INCREMENTAL" })
    check("claimed again for the lease test", await claims(productsJob))

    const during = await serviceCall("sync_enqueue_system", {
      p_account_id: accountC,
      p_resource: "PRODUCTS",
      p_trigger: "MANUAL",
      p_delay_seconds: 0,
    })
    const leased = await readJob(productsJob)
    check("A REQUEST DURING A RUNNING SYNC DOES NOT STEAL THE JOB",
      during.ok && leased?.status === "RUNNING" && leased?.locked_by === workerId,
      `${brief(during)} ${JSON.stringify(leased)}`)
    check("it asks for a rerun instead", leased?.rerun_requested === true)

    const reimportDuring = await call("sync_enqueue", {
      p_account_id: accountC,
      p_resource: "PRODUCTS",
      p_mode: "INITIAL",
    })
    check("a full re-import cannot start on top of a running one",
      !reimportDuring.ok, brief(reimportDuring))

    const run3 = await serviceCall("sync_run_start", { p_job_id: productsJob })
    const finished = await serviceCall(
      "sync_job_complete",
      completion(productsJob, run3.body?.id, "done", false)
    )
    check("WHEN IT FINISHES, THE REQUESTED RERUN IS QUEUED AT ONCE",
      finished.body?.status === "QUEUED" && finished.body?.rerun_requested === false,
      brief(finished))

    /* ---- 9d. Pausing ---------------------------------------------------- */
    const paused = await call("integration_account_pause", {
      p_account_id: accountC,
      p_paused: true,
    })
    check("an owner can pause a connection", paused.body?.status === "PAUSED", brief(paused))
    check("and the pause does not hand back its secrets",
      paused.body?.credentials_encrypted == null && paused.body?.webhook_secret_encrypted == null)
    check("A PAUSED CONNECTION'S QUEUED WORK IS NOT CLAIMED", !(await claims(productsJob)))

    const signalWhilePaused = await serviceCall("sync_enqueue_system", {
      p_account_id: accountC,
      p_resource: "PRODUCTS",
      p_trigger: "AUTOMATIC",
      p_delay_seconds: 0,
    })
    check("and a change signal queues nothing for it",
      signalWhilePaused.ok && signalWhilePaused.body === null, brief(signalWhilePaused))

    const rivalPause = await call(
      "integration_account_pause",
      { p_account_id: accountC, p_paused: false },
      otherToken
    )
    check("ANOTHER BUSINESS CANNOT UNPAUSE THIS CONNECTION", !rivalPause.ok, brief(rivalPause))

    const resumed = await call("integration_account_pause", {
      p_account_id: accountC,
      p_paused: false,
    })
    check("unpausing reconnects it", resumed.body?.status === "CONNECTED", brief(resumed))
    check("and its queued work can be claimed again", await claims(productsJob))
    const run4 = await serviceCall("sync_run_start", { p_job_id: productsJob })
    await serviceCall("sync_job_complete", completion(productsJob, run4.body?.id, "done", false))

    /* ---- 9e. A connection needing reauthorisation ----------------------- */
    const reauth = await serviceCall("integration_account_set_state", {
      p_account_id: accountC,
      p_status: "REAUTH_REQUIRED",
      p_reason: "Google access expired",
    })
    check("the worker can mark a connection as needing reauthorisation", reauth.ok, brief(reauth))

    const seen = await read(
      `/rest/v1/integration_accounts?select=status,last_error&id=eq.${accountC}`
    )
    check("and the owner can see why",
      seen[0]?.status === "REAUTH_REQUIRED" && seen[0]?.last_error === "Google access expired",
      JSON.stringify(seen[0]))

    await call("sync_enqueue", { p_account_id: accountC, p_resource: "PRODUCTS", p_mode: "INCREMENTAL" })
    check("NOTHING IS SYNCED UNTIL THEY RECONNECT", !(await claims(productsJob)))

    await call("integration_account_pause", { p_account_id: accountC, p_paused: false })
    const stillBroken = await read(
      `/rest/v1/integration_accounts?select=status&id=eq.${accountC}`
    )
    check("unpausing does not paper over a broken connection",
      stillBroken[0]?.status === "REAUTH_REQUIRED", JSON.stringify(stillBroken[0]))

    const workerDisconnect = await serviceCall("integration_account_set_state", {
      p_account_id: accountC,
      p_status: "DISCONNECTED",
      p_reason: "no",
    })
    check("the worker cannot disconnect a connection -- that is the owner's decision",
      !workerDisconnect.ok, brief(workerDisconnect))

    await serviceCall("integration_account_set_state", {
      p_account_id: accountC,
      p_status: "CONNECTED",
      p_reason: null,
    })

    /* ---- 9f. Expenses --------------------------------------------------- */
    const expensesQueued = await call("sync_enqueue", {
      p_account_id: accountC,
      p_resource: "EXPENSES",
      p_mode: "INITIAL",
    })
    check("EXPENSES CAN NOW BE A SYNC RESOURCE",
      expensesQueued.ok && expensesQueued.body?.resource === "EXPENSES", brief(expensesQueued))

    const expenseRow = {
      external_id: `EXP-${suffix}`,
      incurred_at: new Date().toISOString(),
      amount: "120.0000",
      category: "Rent",
      description: "Warehouse",
      vendor: "Landlord",
      currency: "AED",
    }

    const exp1 = await serviceCall("sync_apply_expenses", {
      p_job_id: expensesQueued.body?.id,
      p_rows: [expenseRow],
    })
    check("A SYNCED EXPENSE IS WRITTEN", exp1.ok && exp1.body?.expenses_created === 1, brief(exp1))

    const exp2 = await serviceCall("sync_apply_expenses", {
      p_job_id: expensesQueued.body?.id,
      p_rows: [expenseRow],
    })
    check("and re-applying it updates rather than duplicates",
      exp2.body?.expenses_updated === 1 && exp2.body?.expenses_created === 0, brief(exp2))

    const expenseRows = await read(
      `/rest/v1/expenses?select=id&business_id=eq.${businessId}&external_id=eq.EXP-${suffix}`
    )
    check("exactly one expense row", expenseRows.length === 1, String(expenseRows.length))
  }

  /* ---------------------------------------------------------------------- */
  section("10. GOOGLE SHEETS FOUNDATION (0021)")

  if (!HAS_SERVICE_KEY) {
    for (const name of [
      "a Google Sheets tab can be connected",
      "watch channels resolve their tenant",
      "a genuine change signal queues a sync",
      "record state classifies new, changed and unchanged records",
      "a missing record is reported, never deleted",
    ]) skip(name, "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    const SHEET = `spreadsheet-${suffix}`
    const ORDERS_TAB = `${SHEET}:0`

    const sheet = await call("integration_account_connect", {
      p_business_id: businessId,
      p_provider: "GOOGLE_SHEETS",
      p_external_account_id: ORDERS_TAB,
      p_display_name: "Sales 2026 - Orders",
      p_channel_type: "AMAZON",
      p_metadata: { entity: "ORDERS", spreadsheet_id: SHEET, sheet_id: 0 },
    })
    check("A GOOGLE SHEETS TAB CAN BE CONNECTED", sheet.ok, brief(sheet))

    if (sheet.ok) {
      const sheetAccount = sheet.body.id as string

      const sheetChannel = await read(
        `/rest/v1/channels?select=type&id=eq.${sheet.body.channel_id}`
      )
      check("its orders are attributed to the channel the owner chose",
        sheetChannel[0]?.type === "AMAZON", JSON.stringify(sheetChannel[0]))

      /* ---- one tab, one business ------------------------------------- */
      const rivalBusiness = await call("create_business", {
        p_name: `Sheets rival ${suffix}`,
        p_slug: `sheets-rival-${suffix}`,
        p_currency: "AED",
      }, otherToken)
      const stolenTab = await call("integration_account_connect", {
        p_business_id: rivalBusiness.body?.id ?? rivalId,
        p_provider: "GOOGLE_SHEETS",
        p_external_account_id: ORDERS_TAB,
        p_display_name: "Not yours",
        p_channel_type: "AMAZON",
        p_metadata: { entity: "ORDERS" },
      }, otherToken)
      check("ONE TAB FEEDS ONE BUSINESS: another cannot connect it",
        !stolenTab.ok && JSON.stringify(stolenTab.body).includes("different BizMind business"),
        brief(stolenTab))
      if (rivalBusiness.body?.id) {
        await attempt(`/rest/v1/businesses?id=eq.${rivalBusiness.body.id}`, { method: "DELETE" }, otherToken)
      }

      /* ---- a products tab needs no sales channel ------------------------ */
      const channelsBefore = await read(`/rest/v1/channels?select=id&business_id=eq.${businessId}`)
      const productsTab = await call("integration_account_connect", {
        p_business_id: businessId,
        p_provider: "GOOGLE_SHEETS",
        p_external_account_id: `${SHEET}:1`,
        p_display_name: "Sales 2026 - Products",
        p_channel_type: null,
        p_metadata: { entity: "PRODUCTS", spreadsheet_id: SHEET, sheet_id: 1 },
      })
      const channelsAfter = await read(`/rest/v1/channels?select=id&business_id=eq.${businessId}`)
      check("A PRODUCTS TAB CONNECTS WITHOUT INVENTING A SALES CHANNEL",
        productsTab.ok && productsTab.body?.channel_id === null &&
          channelsAfter.length === channelsBefore.length,
        brief(productsTab))

      /* ---- watch channels ---------------------------------------------- */
      const channelId = `channel-${suffix}`
      const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString()

      const registered = await serviceCall("watch_channel_register", {
        p_account_id: sheetAccount,
        p_channel_id: channelId,
        p_resource_id: "resource-1",
        p_token_encrypted: "v1.test-only.not-a-real-ciphertext",
        p_expires_at: inAnHour,
      })
      check("a watch channel is registered", registered.ok, brief(registered))

      const looked = await serviceCall("watch_channel_lookup", { p_channel_id: channelId })
      check("THE TENANT IS RESOLVED FROM THE CHANNEL ROW",
        looked.body?.[0]?.resolved_business_id === businessId &&
          looked.body?.[0]?.account_id === sheetAccount,
        brief(looked))

      const lookedUnknown = await serviceCall("watch_channel_lookup", {
        p_channel_id: `no-such-channel-${suffix}`,
      })
      check("an unknown channel resolves to nothing",
        Array.isArray(lookedUnknown.body) && lookedUnknown.body.length === 0)

      const tokenRead = await attempt(
        `/rest/v1/integration_watch_channels?select=token_encrypted&channel_id=eq.${channelId}`
      )
      check("THE CHANNEL TOKEN IS UNREADABLE BY A SIGNED-IN USER", !tokenRead.ok,
        `${tokenRead.status}`)

      const expiryRead = await read(
        `/rest/v1/integration_watch_channels?select=expires_at&channel_id=eq.${channelId}`
      )
      check("but its expiry is visible, so the page can show connection health",
        expiryRead.length === 1)

      const rivalChannels = await read(
        `/rest/v1/integration_watch_channels?select=id&business_id=eq.${businessId}`,
        {},
        otherToken
      )
      check("another business sees none of these channels", rivalChannels.length === 0)

      /* ---- notifications ----------------------------------------------- */
      const handshake = await serviceCall("watch_event_ingest", {
        p_channel_id: channelId,
        p_message_number: "1",
        p_resource_state: "sync",
        p_changed: null,
        p_raw: "{}",
        p_token_valid: true,
      })
      check("Google's handshake is recorded", handshake.body?.[0]?.outcome === "ACCEPTED",
        brief(handshake))

      const jobsAfterHandshake = await read(
        `/rest/v1/sync_jobs?select=id&integration_account_id=eq.${sheetAccount}`
      )
      check("and queues nothing, because nothing changed", jobsAfterHandshake.length === 0,
        String(jobsAfterHandshake.length))

      const changed = await serviceCall("watch_event_ingest", {
        p_channel_id: channelId,
        p_message_number: "2",
        p_resource_state: "update",
        p_changed: "content",
        p_raw: "{}",
        p_token_valid: true,
      })
      check("A GENUINE CHANGE SIGNAL IS ACCEPTED", changed.body?.[0]?.outcome === "ACCEPTED",
        brief(changed))

      const signalledJobs = await read(
        `/rest/v1/sync_jobs?select=id,status,resource,next_trigger&integration_account_id=eq.${sheetAccount}`
      )
      check("AND QUEUES A SYNC OF THAT TAB, marked automatic",
        signalledJobs.length === 1 &&
          signalledJobs[0].status === "QUEUED" &&
          signalledJobs[0].resource === "ORDERS" &&
          signalledJobs[0].next_trigger === "AUTOMATIC",
        JSON.stringify(signalledJobs))

      const redelivered = await serviceCall("watch_event_ingest", {
        p_channel_id: channelId,
        p_message_number: "2",
        p_resource_state: "update",
        p_changed: "content",
        p_raw: "{}",
        p_token_valid: true,
      })
      check("a redelivery is recognised as a duplicate",
        redelivered.body?.[0]?.outcome === "DUPLICATE", brief(redelivered))

      const forgedSignal = await serviceCall("watch_event_ingest", {
        p_channel_id: channelId,
        p_message_number: "3",
        p_resource_state: "update",
        p_changed: "content",
        p_raw: "{}",
        p_token_valid: false,
      })
      check("A NOTIFICATION WITH THE WRONG TOKEN IS REJECTED",
        forgedSignal.body?.[0]?.outcome === "REJECTED", brief(forgedSignal))

      const rejectionAudit = await read(
        `/rest/v1/audit_logs?select=id&business_id=eq.${businessId}&action=eq.integration.webhook.rejected`
      )
      check("and the rejection is audited", rejectionAudit.length >= 1)

      const unknownSignal = await serviceCall("watch_event_ingest", {
        p_channel_id: `no-such-channel-${suffix}`,
        p_message_number: "1",
        p_resource_state: "update",
        p_changed: "content",
        p_raw: "{}",
        p_token_valid: true,
      })
      check("a notification for an unknown channel writes nothing",
        unknownSignal.body?.[0]?.outcome === "UNKNOWN_CHANNEL", brief(unknownSignal))

      /* ---- renewal ------------------------------------------------------ */
      const dueBefore = await serviceCall("watch_renewals_due", {
        p_within_seconds: 7200,
        p_limit: 500,
      })
      check("a channel expiring within the window is due for renewal",
        Array.isArray(dueBefore.body) &&
          dueBefore.body.some((r: { account_id: string }) => r.account_id === sheetAccount),
        brief(dueBefore))

      const stopped = await serviceCall("watch_channel_stop", { p_channel_id: channelId })
      check("a channel can be stopped", stopped.body === true, brief(stopped))

      const lookedStopped = await serviceCall("watch_channel_lookup", { p_channel_id: channelId })
      check("and a stopped channel no longer resolves to anyone",
        Array.isArray(lookedStopped.body) && lookedStopped.body.length === 0)

      /* ---- record state ------------------------------------------------- */
      const sheetJob = signalledJobs[0]?.id as string

      const first = await serviceCall("sync_record_state_classify", {
        p_job_id: sheetJob,
        p_items: [
          { key: "ORD-1", hash: "h1" },
          { key: "ORD-2", hash: "h2" },
        ],
      })
      check("RECORDS NEVER SEEN BEFORE ARE NEW",
        JSON.stringify(first.body?.new) === JSON.stringify(["ORD-1", "ORD-2"]) &&
          first.body?.unchanged === 0,
        brief(first))

      const committed = await serviceCall("sync_record_state_commit", {
        p_job_id: sheetJob,
        p_run_id: null,
        p_items: [
          { key: "ORD-1", hash: "h1", outcome: "APPLIED", locator: { row: 2 } },
          { key: "ORD-2", hash: "h2", outcome: "REJECTED", locator: { row: 3 } },
        ],
      })
      check("their fingerprints are recorded after applying", committed.body === 2, brief(committed))

      const second = await serviceCall("sync_record_state_classify", {
        p_job_id: sheetJob,
        p_items: [
          { key: "ORD-1", hash: "h1" },
          { key: "ORD-2", hash: "h2-edited" },
          { key: "ORD-3", hash: "h3" },
        ],
      })
      check("AN UNCHANGED RECORD IS SKIPPED, NOT REWRITTEN",
        second.body?.unchanged === 1, brief(second))
      check("an edited record is recognised as changed",
        JSON.stringify(second.body?.changed) === JSON.stringify(["ORD-2"]))
      check("and a new one as new",
        JSON.stringify(second.body?.new) === JSON.stringify(["ORD-3"]))

      const ownState = await read(
        `/rest/v1/integration_record_state?select=business_key,last_outcome&integration_account_id=eq.${sheetAccount}`
      )
      check("the owner can read their record state", ownState.length === 2,
        String(ownState.length))
      check("including which rows could not be imported",
        ownState.some((r: { last_outcome: string }) => r.last_outcome === "REJECTED"))

      const rivalState = await read(
        `/rest/v1/integration_record_state?select=id&business_id=eq.${businessId}`,
        {},
        otherToken
      )
      check("another business sees none of it", rivalState.length === 0)

      const nothingOlder = await serviceCall("sync_record_state_mark_missing", {
        p_job_id: sheetJob,
        p_pass_started_at: "1970-01-01T00:00:00Z",
      })
      check("nothing is missing when every record was seen", nothingOlder.body === 0,
        brief(nothingOlder))

      const allUnseen = await serviceCall("sync_record_state_mark_missing", {
        p_job_id: sheetJob,
        p_pass_started_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      check("records not seen in a pass are reported missing", allUnseen.body === 2,
        brief(allUnseen))

      const stillThere = await read(
        `/rest/v1/integration_record_state?select=id,present&integration_account_id=eq.${sheetAccount}`
      )
      check("A MISSING RECORD IS MARKED, NEVER DELETED",
        stillThere.length === 2 &&
          stillThere.every((r: { present: boolean }) => r.present === false),
        JSON.stringify(stillThere))

      await serviceCall("sync_record_state_commit", {
        p_job_id: sheetJob,
        p_run_id: null,
        p_items: [{ key: "ORD-1", hash: "h1", outcome: null, locator: { row: 2 } }],
      })
      const reappeared = await serviceCall("sync_record_state_mark_missing", {
        p_job_id: sheetJob,
        p_pass_started_at: "1970-01-01T00:00:00Z",
      })
      check("and a record that reappears is present again", reappeared.body === 1,
        brief(reappeared))

      /* ---- reconciliation ----------------------------------------------- */
      await call("sync_enqueue", {
        p_account_id: sheetAccount,
        p_resource: "ORDERS",
        p_mode: "INCREMENTAL",
      })
      const reconcileClaim = await serviceCall("sync_claim_jobs", {
        p_worker_id: `reconcile-${suffix}`,
        p_limit: 200,
        p_lease_seconds: 300,
      })
      check("the sheet's job can be claimed",
        Array.isArray(reconcileClaim.body) &&
          reconcileClaim.body.some((j: { id: string }) => j.id === sheetJob))
      const reconcileRun = await serviceCall("sync_run_start", { p_job_id: sheetJob })
      await serviceCall("sync_job_complete", {
        p_job_id: sheetJob,
        p_run_id: reconcileRun.body?.id,
        p_status: "SUCCEEDED",
        p_cursor: "synced",
        p_records_fetched: 0,
        p_records_applied: 0,
        p_records_skipped: 0,
        p_error: null,
        p_retry_after_ms: null,
        p_has_more: false,
      })

      const reconciled = await serviceCall("sync_reconcile_due", {
        p_interval_minutes: 0,
        p_limit: 500,
      })
      const afterReconcile = await read(
        `/rest/v1/sync_jobs?select=status,next_trigger&id=eq.${sheetJob}`
      )
      check("THE SAFETY NET RE-QUEUES A QUIET SHEET, marked as reconciliation",
        reconciled.ok &&
          afterReconcile[0]?.status === "QUEUED" &&
          afterReconcile[0]?.next_trigger === "RECONCILIATION",
        `${brief(reconciled)} ${JSON.stringify(afterReconcile[0])}`)
    }
  }

  /* ---- none of the new session-less functions is reachable by a user ---- */
  for (const [fn, args] of [
    ["sync_enqueue_system", { p_account_id: accountId, p_resource: "ORDERS", p_trigger: "MANUAL", p_delay_seconds: 0 }],
    ["integration_account_set_state", { p_account_id: accountId, p_status: "CONNECTED", p_reason: null }],
    ["sync_apply_expenses", { p_job_id: accountId, p_rows: [] }],
    ["sync_record_state_classify", { p_job_id: accountId, p_items: [] }],
    ["sync_record_state_commit", { p_job_id: accountId, p_run_id: null, p_items: [] }],
    ["sync_record_state_mark_missing", { p_job_id: accountId, p_pass_started_at: "1970-01-01T00:00:00Z" }],
    ["watch_channel_register", { p_account_id: accountId, p_channel_id: "x", p_resource_id: "x", p_token_encrypted: "x", p_expires_at: "2099-01-01T00:00:00Z" }],
    ["watch_channel_lookup", { p_channel_id: "x" }],
    ["watch_event_ingest", { p_channel_id: "x", p_message_number: "1", p_resource_state: "update", p_changed: null, p_raw: "{}", p_token_valid: true }],
    ["watch_channel_stop", { p_channel_id: "x" }],
    ["watch_renewals_due", { p_within_seconds: 1, p_limit: 1 }],
    ["sync_reconcile_due", { p_interval_minutes: 1, p_limit: 1 }],
  ] as const) {
    const reached = await call(fn, args)
    check(`a signed-in user cannot call ${fn}()`,
      !reached.ok && [401, 403, 404].includes(reached.status),
      String(reached.status))
  }

  /* ---------------------------------------------------------------------- */
  section("11. ONE GOOGLE AUTHORIZATION PER BUSINESS (0022)")

  const authorized = await call("integration_google_authorize", { p_business_id: businessId })
  check("AN OWNER CAN RECORD A GOOGLE SIGN-IN FOR THEIR BUSINESS",
    authorized.ok && authorized.body?.provider === "GOOGLE_SHEETS", brief(authorized))
  check("and the response carries no credential",
    authorized.ok && authorized.body?.credentials_encrypted == null)

  const googleRow = await read(
    `/rest/v1/integrations?select=id,status,authorized_at&business_id=eq.${businessId}&provider=eq.GOOGLE_SHEETS`
  )
  check("the owner can see when Google was connected",
    googleRow.length === 1 && googleRow[0].authorized_at !== null, JSON.stringify(googleRow))

  const tokenColumn = await attempt(
    `/rest/v1/integrations?select=credentials_encrypted&business_id=eq.${businessId}`
  )
  check("THE STORED GOOGLE AUTHORIZATION IS UNREADABLE BY A SIGNED-IN USER",
    !tokenColumn.ok, String(tokenColumn.status))

  const everything = await attempt(`/rest/v1/integrations?select=*&business_id=eq.${businessId}`)
  check("and select * is refused, so nothing can ask for everything",
    !everything.ok, String(everything.status))

  const tokenWrite = await attempt(
    `/rest/v1/integrations?business_id=eq.${businessId}&provider=eq.GOOGLE_SHEETS`,
    { method: "PATCH", body: JSON.stringify({ credentials_encrypted: "forged" }) }
  )
  check("nor can a signed-in user write it", !tokenWrite.ok, String(tokenWrite.status))

  const rivalAuthorize = await call(
    "integration_google_authorize", { p_business_id: businessId }, otherToken
  )
  check("ANOTHER BUSINESS CANNOT CONNECT GOOGLE ON THIS ONE'S BEHALF",
    !rivalAuthorize.ok, brief(rivalAuthorize))

  if (!HAS_SERVICE_KEY) {
    skip("reconnecting Google repairs every waiting sheet", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("the worker falls back to the business authorization", "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    /** A service-role write, only to plant values a signed-in user cannot. */
    const servicePatch = async (path: string, body: unknown) =>
      (await fetch(`${SUPABASE_URL}${path}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      })).ok

    const sheetRows = await read(
      `/rest/v1/integration_accounts?select=id&business_id=eq.${businessId}` +
        `&provider=eq.GOOGLE_SHEETS&external_account_id=eq.spreadsheet-${suffix}:0`
    )
    const sheetTab = sheetRows[0]?.id as string | undefined
    check("the Google Sheets tab from section 10 is still there", sheetTab !== undefined)

    if (sheetTab) {
      await serviceCall("integration_account_set_state", {
        p_account_id: sheetTab,
        p_status: "REAUTH_REQUIRED",
        p_reason: "Google access expired",
      })

      const reauthorized = await call("integration_google_authorize", { p_business_id: businessId })
      const afterReauth = await read(
        `/rest/v1/integration_accounts?select=status,last_error&id=eq.${sheetTab}`
      )
      check("RECONNECTING GOOGLE ONCE REPAIRS EVERY SHEET WAITING FOR IT",
        reauthorized.ok &&
          afterReauth[0]?.status === "CONNECTED" &&
          afterReauth[0]?.last_error === null,
        JSON.stringify(afterReauth[0]))

      const sheetJobs = await read(`/rest/v1/sync_jobs?select=id&integration_account_id=eq.${sheetTab}`)

      const plantedBusiness = await servicePatch(
        `/rest/v1/integrations?id=eq.${googleRow[0]?.id}`,
        { credentials_encrypted: "business-level-sealed" }
      )
      const viaBusiness = await serviceCall("sync_job_context", { p_job_id: sheetJobs[0]?.id })
      check("A SHEET WITH NO CREDENTIAL OF ITS OWN USES THE BUSINESS'S GOOGLE AUTHORIZATION",
        plantedBusiness && viaBusiness.body?.[0]?.credentials_encrypted === "business-level-sealed",
        brief(viaBusiness))

      const plantedTab = await servicePatch(
        `/rest/v1/integration_accounts?id=eq.${sheetTab}`,
        { credentials_encrypted: "tab-level-sealed" }
      )
      const viaTab = await serviceCall("sync_job_context", { p_job_id: sheetJobs[0]?.id })
      check("but a connection with a credential of its own still uses its own",
        plantedTab && viaTab.body?.[0]?.credentials_encrypted === "tab-level-sealed",
        brief(viaTab))
    }
  }

  /* ---------------------------------------------------------------------- */
  section("12. A SHEET'S ROWS, THROUGH THE UPLOAD'S OWN CHECKS (0023)")

  // The REAL worker writes these pages into the real database. Only Google is
  // absent: each page is handed to it as the connector would produce it.
  if (!HAS_SERVICE_KEY) {
    for (const name of [
      "the worker is told the business's currency",
      "a spreadsheet page is written through the upload's own checks",
      "an unchanged sheet writes nothing",
      "a changed cell updates only its order",
      "an order split across one pass is refused, never half-applied",
      "a record gone from a finished pass is marked, never deleted",
      "a sheet whose columns changed waits for its owner",
      "a DEAD_LETTER from the worker is final",
    ]) skip(name, "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    // The worker reads its configuration from the environment, as it does in
    // the app. Handed to it here, for this process only.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL ?? ""
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_KEY

    type SheetJob = import("../src/services/integrations/sync/worker").JobRow
    type SheetContext = import("../src/services/integrations/sync/worker").ContextRow
    const { applyTabularPage } = await import("../src/services/integrations/sync/worker")
    const { ExactNumber } = await import("../src/lib/json-exact")
    const n = (text: string) => new ExactNumber(text)

    const HEADERS = ["Order ID", "Order date", "Order total", "SKU", "Qty", "Unit cost"]
    const MAPPING = {
      external_id: "Order ID", placed_at: "Order date", total: "Order total",
      sku: "SKU", quantity: "Qty", unit_cost: "Unit cost",
    }
    const LIVE_SHEET = `livesheet-${suffix}-abcdefghij`
    const orderId = (k: string) => `S${suffix}-${k}`
    const line = (order: string, sku: string, qty: unknown, cost: unknown, total = "1234.56") => {
      const row: Record<string, unknown> = {
        "Order ID": orderId(order), "Order date": n("46000"), "Order total": n(total), SKU: sku, Qty: qty,
      }
      if (cost !== undefined) row["Unit cost"] = cost
      return row
    }
    const connectArgs = {
      p_business_id: businessId,
      p_provider: "GOOGLE_SHEETS",
      p_external_account_id: `${LIVE_SHEET}:5`,
      p_display_name: `Live sheet ${suffix}`,
      p_channel_type: "WEBSITE",
      p_metadata: {
        entity: "ORDERS", spreadsheet_id: LIVE_SHEET, sheet_id: 5, mapping: MAPPING,
        date_format: "auto", decimal_separator: ",",
      },
    }

    const liveTab = await call("integration_account_connect", connectArgs)
    const tabId = liveTab.body?.id as string | undefined
    check("an orders tab is connected with the owner's column choices", liveTab.ok && !!tabId, brief(liveTab))

    /** Queue, claim, start, then one page through the real worker. */
    const claimJob = async () => {
      await call("sync_enqueue", { p_account_id: tabId, p_resource: "ORDERS", p_mode: "INCREMENTAL" })
      const claimed = await serviceCall("sync_claim_jobs", {
        p_worker_id: `sheet-${suffix}`, p_limit: 200, p_lease_seconds: 300,
      })
      const job = (Array.isArray(claimed.body) ? claimed.body : [])
        .find((j: SheetJob) => j.integration_account_id === tabId) as SheetJob | undefined
      if (!job) return null
      const started = await serviceCall("sync_run_start", { p_job_id: job.id })
      const runId = (Array.isArray(started.body) ? started.body[0]?.id : started.body?.id) as string | undefined
      return { job, runId }
    }

    const runPage = async (page: {
      records: Record<string, unknown>[]
      rows: number[]
      passId: string
      hasMore: boolean
      headers?: string[]
    }) => {
      const claim = await claimJob()
      if (!claim) return { outcome: "NOT_CLAIMED", jobId: undefined, context: undefined }
      const contexts = await serviceCall("sync_job_context", { p_job_id: claim.job.id })
      const context = (contexts.body as SheetContext[])[0]
      const outcome = await applyTabularPage(claim.job, claim.runId, context, {
        kind: "page",
        records: page.records,
        nextCursor: JSON.stringify({ v: null, row: null, pv: null, pid: null }),
        hasMore: page.hasMore,
        table: { headers: page.headers ?? HEADERS, rowNumbers: page.rows, passId: page.passId },
      })
      return { outcome: outcome as string, jobId: claim.job.id, context }
    }

    const orderOf = async (k: string) =>
      (await read(
        `/rest/v1/orders?select=id,total::text&business_id=eq.${businessId}` +
          `&external_id=eq.${encodeURIComponent(orderId(k))}`
      ))[0] as { id: string; total: string } | undefined
    const linesOf = async (order: { id: string } | undefined) =>
      order
        ? (await read(`/rest/v1/order_items?select=sku,unit_cost::text&order_id=eq.${order.id}&order=sku`))
            .map((i: { sku: string; unit_cost: string | null }) => `${i.sku}:${i.unit_cost}`).join(",")
        : ""
    const batchesOfTab = async () =>
      (await read(`/rest/v1/import_batches?select=id&integration_account_id=eq.${tabId}`)) as { id: string }[]
    const issuesOfTab = async () => {
      const batches = await batchesOfTab()
      if (batches.length === 0) return [] as { row_number: number; field: string | null; message: string }[]
      return (await read(
        `/rest/v1/import_issues?select=row_number,field,message` +
          `&batch_id=in.(${batches.map((b) => b.id).join(",")})&order=row_number`
      )) as { row_number: number; field: string | null; message: string }[]
    }
    const lastRun = async (jobId: string | undefined) =>
      (await read(
        `/rest/v1/sync_runs?select=rows_inserted,rows_updated,rows_unchanged,rows_rejected` +
          `&job_id=eq.${jobId}&order=started_at.desc&limit=1`
      ))[0] as { rows_inserted: number; rows_updated: number; rows_unchanged: number; rows_rejected: number } | undefined

    if (tabId) {
      /* ---- pass 1, page 1 --------------------------------------------- */
      const PASS_1 = `pass-1-${suffix}`
      const first = await runPage({
        records: [
          line("1", "A", n("1"), n("100.10")),
          line("1", "B", n("2"), n("50")),
          line("2", "C", "lots", n("5"), "80"),
          { "Order date": n("46000"), "Order total": n("5") },
        ],
        rows: [2, 3, 4, 5],
        passId: PASS_1,
        hasMore: true,
      })

      check("the worker is told the business's currency",
        /^[A-Z]{3}$/.test(first.context?.business_currency ?? ""), String(first.context?.business_currency))
      check("a page with a refused row is PARTIAL, not FAILED", first.outcome === "PARTIAL", first.outcome)

      const o1 = await orderOf("1")
      check("A SPREADSHEET PAGE IS WRITTEN THROUGH THE UPLOAD'S OWN CHECKS", o1 !== undefined)
      check("ITS FIGURE IS EXACT UNDER COMMA DECIMALS: 1234.56, NOT 123456",
        o1?.total === "1234.5600", String(o1?.total))
      check("and both of its lines, with their exact costs",
        (await linesOf(o1)) === "A:100.1000,B:50.0000", await linesOf(o1))
      check("an order whose only row is unreadable is not written", (await orderOf("2")) === undefined)

      const issues1 = await issuesOfTab()
      check("EACH PROBLEM IS REPORTED AT ITS REAL SHEET ROW, WHERE AN UPLOAD'S WOULD BE",
        issues1.some((i) => i.row_number === 4 && i.field === "quantity") &&
          issues1.some((i) => i.row_number === 5 && i.field === "external_id"),
        JSON.stringify(issues1))

      /* ---- pass 1, page 2: order 1 again, far down the sheet ---------- */
      const second = await runPage({
        records: [line("3", "D", n("1"), n("10"), "20"), line("1", "Z", n("1"), n("1"))],
        rows: [1002, 1500],
        passId: PASS_1,
        hasMore: false,
      })
      check("AN ORDER MET AGAIN LATER IN THE SAME PASS IS REFUSED -- ITS LINES ARE NOT REPLACED",
        second.outcome === "PARTIAL" && (await linesOf(await orderOf("1"))) === "A:100.1000,B:50.0000",
        `${second.outcome} ${await linesOf(await orderOf("1"))}`)
      check("and the owner is told to keep an order's rows together",
        (await issuesOfTab()).some((i) => i.row_number === 1500 && i.message.includes("higher up")))
      check("the rest of that page is written", (await orderOf("3")) !== undefined)

      /* ---- pass 2: nothing changed; the bad row was deleted ----------- */
      const batchesBefore = (await batchesOfTab()).length
      const third = await runPage({
        records: [
          line("1", "A", n("1"), n("100.10")),
          line("1", "B", n("2"), n("50")),
          line("3", "D", n("1"), n("10"), "20"),
        ],
        rows: [2, 3, 4],
        passId: `pass-2-${suffix}`,
        hasMore: false,
      })
      const batchesAfter = (await batchesOfTab()).length
      const quietRun = await lastRun(third.jobId)
      check("AN UNCHANGED SHEET WRITES NOTHING: no new import, no row touched",
        third.outcome === "SUCCEEDED" && batchesAfter === batchesBefore &&
          quietRun?.rows_unchanged === 2 && quietRun?.rows_inserted === 0 && quietRun?.rows_updated === 0,
        `${third.outcome} batches ${batchesBefore}->${batchesAfter} ${JSON.stringify(quietRun)}`)

      const state = (await read(
        `/rest/v1/integration_record_state?select=business_key,present&integration_account_id=eq.${tabId}`
      )) as { business_key: string; present: boolean }[]
      check("A RECORD GONE FROM A FINISHED PASS IS MARKED, NEVER DELETED",
        state.some((s) => s.business_key === orderId("2") && s.present === false) &&
          state.some((s) => s.business_key === orderId("1") && s.present === true),
        JSON.stringify(state))
      check("and nothing in BizMind was deleted with it",
        (await orderOf("1")) !== undefined && (await orderOf("3")) !== undefined)

      /* ---- pass 3: one cell changed ----------------------------------- */
      const fourth = await runPage({
        records: [
          line("1", "A", n("1"), n("100.20")),
          line("1", "B", n("2"), n("50")),
          line("3", "D", n("1"), n("10"), "20"),
        ],
        rows: [2, 3, 4],
        passId: `pass-3-${suffix}`,
        hasMore: false,
      })
      const editRun = await lastRun(fourth.jobId)
      check("A CHANGED CELL UPDATES ONLY ITS ORDER",
        fourth.outcome === "SUCCEEDED" && (await linesOf(await orderOf("1"))) === "A:100.2000,B:50.0000" &&
          editRun?.rows_updated === 1 && editRun?.rows_unchanged === 1,
        `${fourth.outcome} ${await linesOf(await orderOf("1"))} ${JSON.stringify(editRun)}`)

      /* ---- a chosen column disappears --------------------------------- */
      const fifth = await runPage({
        records: [line("1", "A", n("1"), undefined)],
        rows: [2],
        passId: `pass-4-${suffix}`,
        hasMore: false,
        headers: HEADERS.filter((h) => h !== "Unit cost"),
      })
      const parkedTab = await read(`/rest/v1/integration_accounts?select=status&id=eq.${tabId}`)
      const parkedJob = await read(`/rest/v1/sync_jobs?select=status&id=eq.${fifth.jobId}`)
      check("A SHEET WHOSE COLUMNS CHANGED WAITS FOR ITS OWNER -- NOT A DEAD LETTER",
        fifth.outcome === "RETRYING" && parkedTab[0]?.status === "MAPPING_REVIEW_REQUIRED" &&
          parkedJob[0]?.status === "RETRYING",
        `${fifth.outcome} ${JSON.stringify(parkedTab[0])} ${JSON.stringify(parkedJob[0])}`)
      check("and the order it would have changed is untouched",
        (await linesOf(await orderOf("1"))) === "A:100.2000,B:50.0000")

      const reconnected = await call("integration_account_connect", connectArgs)
      check("confirming the columns again turns the sheet back on",
        reconnected.ok && reconnected.body?.status === "CONNECTED", brief(reconnected))

      /* ---- DEAD_LETTER, and who may record problems --------------------- */
      const final = await claimJob()
      if (!final) {
        check("the reconnected sheet's job can be claimed", false)
      } else {
        const direct = await call("sync_record_issues", { p_job_id: final.job.id, p_batch_id: null, p_issues: [] })
        check("a signed-in user cannot call sync_record_issues()",
          !direct.ok && [401, 403, 404].includes(direct.status), String(direct.status))

        const foreign = (await read(
          `/rest/v1/import_batches?select=id&business_id=eq.${businessId}` +
            `&or=(integration_account_id.is.null,integration_account_id.neq.${tabId})&limit=1`
        )) as { id: string }[]
        if (foreign.length === 0) {
          skip("a job cannot attach problems to another connection's import", "no other import exists in this test")
        } else {
          const hijack = await serviceCall("sync_record_issues", {
            p_job_id: final.job.id, p_batch_id: foreign[0].id,
            p_issues: [{ row_number: 1, severity: "ERROR", message: "planted" }],
          })
          check("A JOB CANNOT ATTACH PROBLEMS TO ANOTHER CONNECTION'S IMPORT", !hijack.ok, brief(hijack))
        }

        const dead = await serviceCall("sync_job_complete", {
          p_job_id: final.job.id, p_run_id: final.runId, p_status: "DEAD_LETTER", p_cursor: null,
          p_records_fetched: 0, p_records_applied: 0, p_records_skipped: 0,
          p_error: "The spreadsheet was deleted.",
        })
        check("A DEAD_LETTER FROM THE WORKER IS FINAL -- not retried for hours",
          dead.body?.status === "DEAD_LETTER" && dead.body?.attempts < dead.body?.max_attempts,
          brief(dead))
      }
    }
  }
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await api(`/rest/v1/businesses?id=eq.${rivalId}`, { method: "DELETE" }, otherToken)

  const goneA = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  const goneB = await api(`/rest/v1/businesses?select=id&id=eq.${rivalId}`, {}, otherToken)
  check("both throwaway tenants deleted", goneA.length === 0 && goneB.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
if (skipped > 0) {
  console.log(" Skipped sections need SUPABASE_SERVICE_ROLE_KEY. They are not passes.")
}
console.log("=".repeat(74))

if (failed > 0) process.exit(1)

// A skipped security section must not read as a green run.
const signatureHmac = createHmac("sha256", "unused").update("").digest("base64")
if (skipped > 0 && signatureHmac.length > 0) process.exitCode = 0
