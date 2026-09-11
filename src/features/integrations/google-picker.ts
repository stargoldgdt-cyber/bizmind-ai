/**
 * Google's file picker, in the browser.
 *
 * WHAT HAPPENS HERE, AND WHAT NEVER DOES
 * --------------------------------------
 * The owner signs in to Google in a popup run by Google's own script, which
 * hands THIS PAGE a short-lived access token (about an hour) covering only the
 * files BizMind is allowed to see -- the ones the owner picks. The token is
 * held in memory for the few minutes of connecting, and sent to BizMind's own
 * server only to read the chosen sheet's tabs and headings. It is never
 * stored: not in localStorage, not in a cookie, not in the database.
 *
 * The lasting Google authorisation never reaches the browser. It was sealed on
 * the server during the sign-in step, and only the background worker uses it.
 *
 * The picker also needs a browser API key and the Google Cloud project number.
 * Both are public by Google's design. The key is restricted in Google Cloud to
 * the Picker API and to BizMind's own web addresses, and cannot read a file by
 * itself. See DECISIONS.md, 2026-09-11.
 */

const GSI_SRC = "https://accounts.google.com/gsi/client"
const GAPI_SRC = "https://apis.google.com/js/api.js"

/** The one scope BizMind asks for. A test fails the build if any other appears. */
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"

/** Native Google Sheets only: the Sheets API cannot read an .xlsx stored in Drive. */
const GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet"

type TokenResponse = {
  access_token?: string
  error?: string
}

type TokenClient = { requestAccessToken: (overrides?: { prompt?: string }) => void }

type PickerData = Record<string, unknown>

type PickerBuilder = {
  addView(view: unknown): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(appId: string): PickerBuilder
  setTitle(title: string): PickerBuilder
  setCallback(callback: (data: PickerData) => void): PickerBuilder
  build(): { setVisible(visible: boolean): void }
}

type GoogleNamespace = {
  accounts?: {
    oauth2: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback?: (error: { type?: string }) => void
      }): TokenClient
    }
  }
  picker?: {
    PickerBuilder: new () => PickerBuilder
    DocsView: new (viewId?: unknown) => { setMimeTypes(types: string): unknown }
    ViewId: Record<string, unknown>
    Action: Record<string, string>
    Response: Record<string, string>
    Document: Record<string, string>
  }
}

type GapiNamespace = {
  load(name: string, config: { callback: () => void; onerror?: () => void }): void
}

declare global {
  interface Window {
    google?: GoogleNamespace
    gapi?: GapiNamespace
  }
}

export type GoogleProblem = "not_loaded" | "blocked" | "closed" | "denied" | "failed"

export class GooglePickerError extends Error {
  constructor(readonly problem: GoogleProblem) {
    super(problem)
    this.name = "GooglePickerError"
  }
}

const loading = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = loading.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loading.delete(src)
      reject(new GooglePickerError("not_loaded"))
    }
    document.head.appendChild(script)
  })

  loading.set(src, promise)
  return promise
}

/**
 * Loads Google's sign-in and picker scripts. Call it when the connect screen
 * opens, not on the click: the sign-in window is a popup, and a browser only
 * allows one that opens straight from a click.
 */
export async function prepareGoogle(): Promise<void> {
  await Promise.all([loadScript(GSI_SRC), loadScript(GAPI_SRC)])
  if (window.google?.picker) return

  const gapi = window.gapi
  if (!gapi) throw new GooglePickerError("not_loaded")

  await new Promise<void>((resolve, reject) => {
    gapi.load("picker", {
      callback: () => resolve(),
      onerror: () => reject(new GooglePickerError("not_loaded")),
    })
  })
}

/**
 * Asks Google for a short-lived token for the files the owner picks.
 *
 * Must be called directly from a click handler: it opens Google's popup
 * synchronously, before any await.
 */
export function requestDriveToken(clientId: string): Promise<string> {
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) return Promise.reject(new GooglePickerError("not_loaded"))

  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) reject(new GooglePickerError("denied"))
        else resolve(response.access_token)
      },
      error_callback: (error) => {
        reject(
          new GooglePickerError(
            error?.type === "popup_failed_to_open"
              ? "blocked"
              : error?.type === "popup_closed"
                ? "closed"
                : "failed"
          )
        )
      },
    })

    client.requestAccessToken({ prompt: "" })
  })
}

/** Opens Google's picker on Google Sheets files. Resolves null if the owner cancels. */
export function openSpreadsheetPicker(options: {
  token: string
  apiKey: string
  appId: string
}): Promise<{ id: string; name: string } | null> {
  const picker = window.google?.picker
  if (!picker) return Promise.reject(new GooglePickerError("not_loaded"))

  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS)
    view.setMimeTypes(GOOGLE_SHEETS_MIME_TYPE)

    const built = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(options.token)
      .setDeveloperKey(options.apiKey)
      // The project number. Tells Google that a file picked here is shared
      // with BizMind -- which is what `drive.file` then lets it read.
      .setAppId(options.appId)
      .setTitle("Choose the spreadsheet BizMind should read")
      .setCallback((data) => {
        const action = data[picker.Response.ACTION]

        if (action === picker.Action.PICKED) {
          const documents = data[picker.Response.DOCUMENTS]
          const first = Array.isArray(documents) ? (documents[0] as Record<string, unknown>) : undefined
          const id = first?.[picker.Document.ID]
          const name = first?.[picker.Document.NAME]
          resolve(typeof id === "string" ? { id, name: typeof name === "string" ? name : "Spreadsheet" } : null)
        } else if (action === picker.Action.CANCEL) {
          resolve(null)
        }
      })
      .build()

    built.setVisible(true)
  })
}

/** What to tell the owner when Google's side of connecting goes wrong. */
export function explainGoogleProblem(problem: unknown): string {
  const kind = problem instanceof GooglePickerError ? problem.problem : "failed"

  switch (kind) {
    case "blocked":
      return "Your browser blocked Google's sign-in window. Allow pop-ups for this site, then try again."
    case "closed":
    case "denied":
      return "Google sign-in was cancelled, so nothing was chosen."
    case "not_loaded":
      return (
        "Google's picker could not load. Check your internet connection, or allow " +
        "accounts.google.com and apis.google.com if a blocker is on, then reload the page."
      )
    default:
      return "Google's picker could not open. Try again."
  }
}
