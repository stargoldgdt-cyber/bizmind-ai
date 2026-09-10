import { NextResponse } from "next/server"

import { receiveWebhook } from "@/services/integrations"

/**
 * The webhook endpoint.
 *
 * THE FIRST LINE IS THE IMPORTANT ONE.
 *
 * `request.text()` reads the body as the exact bytes the provider sent. Every
 * signature scheme in use -- Shopify's HMAC-SHA256, WooCommerce's -- is
 * computed over those bytes. Calling `request.json()` first and re-serialising
 * produces different bytes (different key order, different whitespace) and the
 * signature will never match: a bug that looks exactly like an attack, and
 * that a developer can waste a day on.
 *
 * There is no session here and there cannot be. This route is excluded from
 * the auth proxy, which is not the same as being public: its authentication is
 * the signature, checked against a secret only this business and the provider
 * share, and the tenant is resolved from a connection an owner created.
 *
 * It returns fast because it must. Shopify allows five seconds in total and
 * deletes the subscription after eight consecutive failures.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> }
) {
  // Raw first. Nothing may parse this body before it has been verified.
  const rawBody = await request.text()

  const { provider } = await context.params

  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })

  try {
    const outcome = await receiveWebhook({ provider, headers, rawBody })

    // The body is deliberately minimal. A provider needs a status code; an
    // attacker probing for which stores exist gets nothing to work with.
    return NextResponse.json({ status: outcome.kind }, { status: outcome.status })
  } catch (error) {
    // Never leak the reason. A 500 here means an operator has something to fix,
    // and the provider will redeliver -- which is exactly what should happen.
    console.error("[webhook] receive failed", error)
    return NextResponse.json({ status: "error" }, { status: 500 })
  }
}
