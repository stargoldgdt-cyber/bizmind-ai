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

**Phase 1 needs no secrets at all.** Supabase values arrive in Phase 2, and the
OpenAI key in Phase 8.

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
