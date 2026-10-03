# Setup

How to get BizMind AI running on a machine. Written to be followed by someone
who is not a developer.

---

## 1. What you need installed

| Tool | Version | What it is |
| --- | --- | --- |
| Node.js | 24 LTS | The engine that runs the app |
| npm | 11+ | Installs the app's building blocks (comes with Node) |
| Git | 2.x | Keeps the history of every change |

Check what you have — open a terminal in the project folder and run:

```bash
node --version && npm --version && git --version
```

You should see three version numbers. If `node` is not found, install Node.js
24 LTS from <https://nodejs.org> and reopen the terminal.

---

## 2. Get the project running

From the project folder:

```bash
npm install
```

This downloads the building blocks. It takes a minute or two the first time and
creates a `node_modules` folder — that folder is generated, never edited, and
never committed.

Then start it:

```bash
npm run dev
```

Open <http://localhost:3000> in a browser.

`localhost` means "this computer" — the site is running on your machine only.
Nobody else can reach it. Press `Ctrl + C` in the terminal to stop it.

---

## 3. The commands you will use

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app locally while you work. Reloads on save |
| `npm run build` | Builds the production version. **Must pass before committing** |
| `npm run start` | Runs the built production version locally |
| `npm run lint` | Checks code quality. **Must pass before committing** |
| `npm run verify` | All of the above plus the offline test suites, in one go |
| `npm run test:analytics-data` | Tests the numbers against the real database |
| `npm run test:costs` | Proves a past order's profit cannot move |
| `npm run test:source-truth` | Proves blank is never turned into zero |
| `npm run test:mapping` | Proves BizMind never guesses what a column means |
| `npm run test:mapping-data` | The same, against the real database |
| `npm run test:migration-0010` | Checks the newest database change really holds |
| `npm run test:money-guard` | Stops anyone doing money sums in the app code |
| `npm run test:money-boundary` | Proves no penny is lost between database and screen |
| `npm run verify:integrations` | Proves one business cannot touch another's integrations |
| `npm run test:woocommerce` | Proves the WooCommerce mapping never invents a figure |
| `npm run test:automation` | Proves an alert rule that could never fire cannot be saved |
| `npm run test:automation-live` | Proves an alert stays quiet on a figure it cannot trust |
| `npm run test:ai` | Proves the AI can never show you an invented number |
| `npm run ai:check` | Checks your OpenAI key and writes one real explanation |

Before any commit:

```bash
npm run lint && npm run build
```

---

## 4. Secrets and environment variables

**No password, key or token is ever written into the code.** They live in a
file called `.env.local`, which Git is configured to ignore, so it never leaves
your machine.

`.env.example` lists which values are needed. It contains **names only, never
real values** — it is safe to commit and is the reference for what to fill in.

To set secrets up:

1. Copy `.env.example` to a new file named `.env.local`.
2. Fill in the real values.
3. Restart `npm run dev` — environment variables are read at startup.

Rules that protect you:

- Never paste a real key into a chat, a screenshot, or a code file.
- Never commit `.env.local`.
- Anything named `NEXT_PUBLIC_...` is visible to anyone who visits the site.
  Only genuinely public values go there.
- If a secret is ever exposed, rotate it (generate a new one) rather than
  hoping nobody saw it.

### The OpenAI key (optional)

BizMind works completely without it. Every figure, chart and import is
unaffected; the dashboard simply says written explanations are switched off.

If you want the plain-language explanations:

1. Go to https://platform.openai.com/api-keys and create a key.
2. Add it to `.env.local` as `OPENAI_API_KEY=sk-...`
3. Run `npm run ai:check`. It checks the key, checks the model, and writes one
   real explanation so you can see it working before a customer does.

The key is read in exactly one file on the server and is never sent to the
browser. **The AI never produces a number** -- it only explains figures the
database already calculated, and any explanation containing a figure that is
not in your records is thrown away rather than shown. See [AI.md](AI.md).

Supabase is set up below.

### Keys the integration engine needs

Two more secrets, both server-side only.

**`BIZMIND_ENCRYPTION_KEY`** encrypts integration credentials before they are
stored. Generate one and put it in `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Changing this key makes every stored credential unreadable** and every store
would have to be reconnected. Treat it like a database password.

**`SUPABASE_SERVICE_ROLE_KEY`** is on your Supabase dashboard under
Settings → API. It is needed because a webhook arrives with no signed-in user,
so the usual security cannot work out whose data it is. It is read in exactly
two files and a test fails the build if it appears anywhere else.

Both go in `.env.local`, which Git ignores. Never paste either into a chat.

### Credentials for the test suites

Three of the test commands sign in to the real database, so they need a
throwaway account to sign in as. Those live in `.env.test.local`, which Git
ignores exactly like `.env.local`:

```
BIZMIND_TEST_EMAIL=...
BIZMIND_TEST_PASSWORD=...
BIZMIND_OTHER_EMAIL=...
BIZMIND_OTHER_PASSWORD=...
```

The second pair exists so the tests can prove one business genuinely cannot
read another's data — that needs two different people signed in at once.

These are disposable QA accounts in your own Supabase project. **Never put a
real customer's password here**, and delete the QA users before launch.

---

## 4a. Connecting Supabase (needed from Phase 2 onward)

Supabase provides the database and the login system. The free tier is enough
for development; no card is required.

### Create the project

1. Go to <https://supabase.com> and click **Start your project**
2. Sign in with GitHub, or with an email and password
3. Click **New project**
4. Fill in:
   - **Name:** `bizmind-ai`
   - **Database Password:** click **Generate a password**, then
     **save it in your password manager**. You will not be shown it again.
     It is not needed for day-to-day work, but it cannot be recovered.
   - **Region:** the one closest to you or your customers
5. Click **Create new project** and wait — it takes a minute or two

### Copy the connection values

1. In the left sidebar click **Project Settings** (the gear icon)
2. Click **API Keys**
3. Copy these two values:

| On the Supabase page | Into `.env.local` as |
| --- | --- |
| **Project URL** | `NEXT_PUBLIC_SUPABASE_URL` |
| **anon** / **publishable** key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

**Ignore the `service_role` key for now.** It bypasses every security rule in
the database. It is not needed yet, and it must never appear in the browser or
in a screenshot.

The anon key is *meant* to be public — it identifies the project, it does not
grant access. Row Level Security is what actually protects the data.

### Create the database tables

1. In the left sidebar click **SQL Editor**
2. Click **New query**
3. Open `supabase/migrations/0001_identity_and_tenancy.sql` in this project
4. Copy the whole file and paste it into the editor
5. Click **Run**

Expected result: **Success. No rows returned**

### Point confirmation emails at your app

1. Left sidebar → **Authentication** → **URL Configuration**
2. Set **Site URL** to `http://localhost:3000`
3. Under **Redirect URLs**, add `http://localhost:3000/**`
4. Click **Save**

Without this, the link in the confirmation email points at the wrong place and
signing up appears to hang.

The same list governs the password-reset and "send a new confirmation link"
emails. They ask Supabase to send people back to `<your site>/auth/confirm`, and
Supabase only honours an address on **Redirect URLs** (otherwise it falls back
to the Site URL). For a live domain add both spellings, for example
`https://example.com/**` and `https://www.example.com/**`.

`/auth/confirm` accepts both link shapes Supabase can send: the default
templates' `code` link, and a `token_hash` link.

**The default `code` link only works in the browser that asked for the email**
(it needs a one-time secret stored there), so a reset or confirmation opened on
a phone, or in a different browser, fails with "That link did not work".
Customers do this all the time, so switch both emails to the `token_hash`
shape under **Authentication → Email Templates**. Change only the link or
button address and keep the rest of the template:

- **Confirm signup:** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`
- **Reset Password:** `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery`

`{{ .RedirectTo }}` is the address the app asked for (`<this site>/auth/confirm`,
plus `?next=/reset-password` for a reset), so the same templates work on
localhost and on the live domain, with no domain written into them.

### Turn on "Continue with Google"

The button is in the code. Until Google is enabled in Supabase, pressing it
shows `Unsupported provider: provider is not enabled`.

1. **Google Cloud Console** → **APIs & Services** → **Credentials** → open (or
   create) an **OAuth client ID** of type *Web application*. The one used for
   Google Sheets works too.
2. Under **Authorized redirect URIs** add
   `https://<your-project-ref>.supabase.co/auth/v1/callback`. This is
   Supabase's address, not the site's. Save.
3. **Google Auth Platform** (or *OAuth consent screen*) → set the publishing
   status to **In production**. While it says *Testing*, only listed test users
   can sign in. Sign-in only asks for email, name and picture, which Google
   approves without a review.
4. **Supabase** → **Authentication** → **Sign In / Providers** → **Google** →
   switch it on and paste the client ID and client secret from step 1. The
   secret goes only into this Supabase screen: never into the repo, chat or
   `.env` files.
5. **Authentication** → **URL Configuration**: the Redirect URLs from the
   section above must already include your site (`https://example.com/**`);
   Google sign-in returns through `/auth/confirm`.

A person who already has an account under the same verified email is signed
into it; Supabase links the Google identity to that account. Keep **Confirm
email** switched on.

### Restart

```bash
npm run dev
```

Environment variables are only read at startup, so a restart is required after
editing `.env.local`.

---

## 5. Project structure at a glance

```
bizmind-ai/
├── src/
│   ├── app/          The pages people see
│   ├── components/   Reusable interface pieces
│   ├── config/       Product constants, fonts, design tokens
│   └── lib/          Shared helpers
├── CLAUDE.md         Permanent build rules — read first
├── ARCHITECTURE.md   How the system fits together
├── DESIGN.md         Colours, fonts, spacing
├── DECISIONS.md      Why things were chosen
└── SETUP.md          This file
```

---

## 6. If something goes wrong

**`npm run dev` says the port is in use** — another copy is already running.
Close the other terminal, or run `npm run dev -- -p 3001` to use a different
port.

**A change does not appear in the browser** — hard-refresh with
`Ctrl + Shift + R`. If it still does not, check the terminal for a red error.

**The build fails** — read the first error, not the last. Later errors are
usually knock-on effects of the first one.

**Something is badly broken after installing** — delete the `node_modules`
folder and run `npm install` again. This is safe; nothing you wrote lives there.
