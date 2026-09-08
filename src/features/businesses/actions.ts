"use server"

import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { DASHBOARD_ROUTE } from "@/config/routes"
import { createClient } from "@/lib/supabase/server"

import { ACTIVE_BUSINESS_COOKIE, getUserBusinesses } from "./queries"
import { createBusinessSchema, slugify, type BusinessFormState } from "./schemas"

/** How long the active-business cookie survives. */
const ACTIVE_BUSINESS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505"

async function setActiveBusinessCookie(businessId: string) {
  const cookieStore = await cookies()
  cookieStore.set(ACTIVE_BUSINESS_COOKIE, businessId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACTIVE_BUSINESS_COOKIE_MAX_AGE,
  })
}

export async function createBusinessAction(
  _previous: BusinessFormState,
  formData: FormData
): Promise<BusinessFormState> {
  const parsed = createBusinessSchema.safeParse({
    name: formData.get("name"),
    currency: formData.get("currency"),
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "")
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message
    }
    return { fieldErrors }
  }

  const supabase = await createClient()

  const baseSlug = slugify(parsed.data.name) || "business"
  let created: { id: string } | null = null

  // The slug is unique across all businesses, so two owners choosing the same
  // name will collide. Retry with a short random suffix rather than showing
  // the owner a database error about a name that is perfectly reasonable.
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    const slug =
      attempt === 0
        ? baseSlug
        : `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`

    // Business creation goes through this function so that the business and
    // its owner membership are written in ONE transaction. Inserting the
    // business directly could leave one with no owner if the second write
    // failed. See migration 0001, section 8.
    const { data, error } = await supabase.rpc("create_business", {
      p_name: parsed.data.name,
      p_slug: slug,
      p_currency: parsed.data.currency,
    })

    if (!error) {
      created = data
      break
    }

    if (error.code !== UNIQUE_VIOLATION) {
      return { formError: `Could not create the business: ${error.message}` }
    }
  }

  if (!created) {
    return {
      formError:
        "That business name is already taken. Try a slightly different name.",
    }
  }

  await setActiveBusinessCookie(created.id)

  revalidatePath("/", "layout")
  redirect(DASHBOARD_ROUTE)
}

/**
 * Switch which business the user is viewing.
 *
 * Membership is re-checked here rather than trusting the submitted id. Without
 * this check a crafted request could point the cookie at any business id —
 * RLS would still block the data, but the interface would misleadingly claim
 * to be showing another company.
 */
export async function switchBusinessAction(formData: FormData) {
  const businessId = formData.get("businessId")?.toString()
  if (!businessId) return

  const businesses = await getUserBusinesses()
  if (!businesses.some((business) => business.id === businessId)) {
    // Not a member. Say nothing useful about whether the business exists.
    return
  }

  await setActiveBusinessCookie(businessId)
  revalidatePath("/", "layout")
}
