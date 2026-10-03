import Link from "next/link"
import { ArrowLeft, Info, Mail } from "lucide-react"
import type { ReactNode } from "react"

/**
 * "Check your inbox": shown after a confirmation or reset email has been sent.
 * `children` is the resend control.
 */
export function CheckInbox({
  heading,
  sentTo,
  intro,
  children,
}: {
  heading: string
  sentTo: string | undefined
  intro: string
  children: ReactNode
}) {
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <Mail className="size-7" aria-hidden />
      </div>

      <div className="space-y-2">
        <h2 className="font-heading text-2xl font-semibold">{heading}</h2>
        <p className="text-sm text-muted-foreground">
          {intro}
          {sentTo && (
            <>
              {" "}
              <span className="font-semibold break-all text-foreground">{sentTo}</span>
            </>
          )}
          .
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3 text-left text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
        <div>
          <p className="font-medium">Didn&apos;t receive the email?</p>
          <p className="text-muted-foreground">Check your spam folder or try again.</p>
        </div>
      </div>

      {children}

      <Link
        href="/login"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to sign in
      </Link>
    </div>
  )
}
