"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createMarketplaceAccountAction } from "@/features/marketplaces/actions"

/**
 * Adding a marketplace account (owner only).
 *
 * The currency is chosen, never derived: the country only pre-selects the
 * usual one, and the owner can change it before saving. Once a file has been
 * recorded against the account its currency cannot change (decision A12), and
 * the form says so before it is saved.
 */

const COUNTRIES = [
  { code: "AE", name: "United Arab Emirates", currency: "AED" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR" },
  { code: "KW", name: "Kuwait", currency: "KWD" },
  { code: "QA", name: "Qatar", currency: "QAR" },
  { code: "BH", name: "Bahrain", currency: "BHD" },
  { code: "OM", name: "Oman", currency: "OMR" },
  { code: "EG", name: "Egypt", currency: "EGP" },
] as const

const CURRENCIES = ["AED", "SAR", "KWD", "QAR", "BHD", "OMR", "EGP"] as const

const STATUS_NOTE: Record<string, string> = {
  AVAILABLE: "Settlement files can be uploaded",
  SAMPLES_REQUIRED: "Files not supported yet",
  CONTRACT_ONLY: "Files not supported yet",
}

export function MarketplaceAccountForm({
  marketplaces,
}: {
  marketplaces: { code: string; name: string; adapter_status: string }[]
}) {
  const router = useRouter()
  const [marketplace, setMarketplace] = useState(
    marketplaces.find((m) => m.adapter_status === "AVAILABLE")?.code ?? marketplaces[0]?.code ?? ""
  )
  const [country, setCountry] = useState<string>("AE")
  const [currency, setCurrency] = useState<string>("AED")
  const [label, setLabel] = useState("")
  const [sellerRef, setSellerRef] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const chosen = marketplaces.find((m) => m.code === marketplace)

  return (
    <form
      className="grid gap-4 rounded-xl border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          setError(null)
          setSaved(false)
          const result = await createMarketplaceAccountAction({
            marketplaceCode: marketplace,
            label,
            country,
            currency,
            externalSellerRef: sellerRef || undefined,
          })
          if (!result.ok) {
            setError(result.error)
            return
          }
          setSaved(true)
          setLabel("")
          setSellerRef("")
          router.refresh()
        })
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">Add a marketplace account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One account per store, per marketplace, per country. Every settlement
          you upload is recorded against an account, in its currency.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="account-marketplace">Marketplace</Label>
          <Select value={marketplace} onValueChange={setMarketplace}>
            <SelectTrigger id="account-marketplace" className="w-full">
              <SelectValue placeholder="Choose a marketplace" />
            </SelectTrigger>
            <SelectContent>
              {marketplaces.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.name} — {STATUS_NOTE[m.adapter_status] ?? m.adapter_status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosen && chosen.adapter_status !== "AVAILABLE" && (
            <p className="text-xs text-muted-foreground">
              You can add this account now; uploading its files arrives in a later phase.
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-label">Name</Label>
          <Input
            id="account-label"
            value={label}
            maxLength={80}
            placeholder="Amazon.ae"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-country">Country</Label>
          <Select
            value={country}
            onValueChange={(value) => {
              setCountry(value)
              const usual = COUNTRIES.find((c) => c.code === value)?.currency
              if (usual) setCurrency(usual)
            }}
          >
            <SelectTrigger id="account-country" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-currency">Currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="account-currency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Locked once a file is recorded. BizMind never converts currencies.
          </p>
        </div>

        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="account-seller-ref">Seller or merchant ID (optional)</Label>
          <Input
            id="account-seller-ref"
            value={sellerRef}
            maxLength={120}
            onChange={(event) => setSellerRef(event.target.value)}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-strong">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-success-strong">
          Account added.
        </p>
      )}

      <div>
        <Button type="submit" className="rounded-4xl" disabled={pending || label.trim() === ""}>
          <Plus className="size-4" aria-hidden />
          {pending ? "Adding…" : "Add account"}
        </Button>
      </div>
    </form>
  )
}
