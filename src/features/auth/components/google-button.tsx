"use client"

import { useFormStatus } from "react-dom"

import { Button } from "@/components/ui/button"
import { signInWithGoogleAction } from "@/features/auth/actions"

/**
 * Google's own four-colour "G". It is a third-party mark, which the design
 * system allows to keep its brand colours (DESIGN.md, "third-party logos"), so
 * its fills are the one place colours are written out rather than taken from
 * tokens. Google's guidelines require the mark unaltered.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant="outline"
      size="lg"
      disabled={pending}
      className="h-11 w-full gap-3 rounded-4xl text-sm"
    >
      <GoogleMark />
      {pending ? "Opening Google…" : "Continue with Google"}
    </Button>
  )
}

/** "Continue with Google", followed by an "or" divider for the form below it. */
export function GoogleButton({ redirectTo }: { redirectTo?: string }) {
  return (
    <div className="space-y-5">
      <form action={signInWithGoogleAction}>
        {redirectTo && <input type="hidden" name="next" value={redirectTo} />}
        <SubmitButton />
      </form>

      <div className="flex items-center gap-3 text-xs text-muted-foreground" role="separator" aria-label="or">
        <span className="h-px flex-1 bg-border" />
        <span>or continue with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  )
}
