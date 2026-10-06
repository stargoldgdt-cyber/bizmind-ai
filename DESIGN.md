# Design system

BizMind should feel premium, modern, intelligent and trustworthy — an
enterprise product an owner trusts with their numbers.

The guiding idea is **calm surface, sharp signal**. The interface around the
data stays quiet; colour and weight are spent almost entirely on the numbers,
the changes and the recommendations. Premium comes from **restraint and real
product UI**, not from added effects.

`src/app/globals.css` is the **single source of truth**. Every colour, radius,
shadow and section measure is defined there once. Components reference tokens;
they never contain a hex code.

---

## 1. How to use it

```tsx
// Correct — semantic token, follows light/dark automatically
<div className="bg-card text-card-foreground border-border">

// Correct — a whole section on a band surface, with matching foregrounds
<section className="bg-surface-3 text-surface-3-foreground py-section-md">
  <p className="text-surface-3-muted">Supporting copy</p>
</section>

// Wrong — never do these
<div style={{ background: "#6d28d9" }}>
<div className="bg-[#6d28d9]">
<section className="bg-surface-3 text-white">   {/* use the token */}
```

If you find yourself writing `text-white` inside a section, a token is missing.
Add it to `globals.css` rather than hard-coding.

To re-brand the entire product, edit the values in `:root` and `.dark`.

---

## 2. Two registers

BizMind has two visual registers. Confusing them is the most likely way to get
this wrong: marketing spaciousness inside a dashboard produces a product that
demos well and works badly.

| | **Marketing** (public pages) | **Product** (logged-in app) |
| --- | --- | --- |
| Rhythm | Alternating full-bleed bands | One calm surface; no bands |
| Density | Generous, spacious | Compact, information-dense |
| Violet | Section fills and CTAs | **Actions and active state only** |
| Radius | Larger, softer | Tighter |
| Hero element | Product screenshots | The data itself |
| Section padding | `py-section-md` / `lg` | Normal spacing utilities |
| Container | `max-w-marketing` | Full width, sidebar-constrained |

Both registers draw from the same tokens. They differ in how much space and
colour they spend.

---

## 3. Surfaces and section rhythm

Rhythm comes from switching the background of **whole sections**, never from
decorating inside them. This is the primary premium mechanism.

Four band levels. Each carries its own foreground, muted and border tokens, so
a dark or violet section is built entirely from tokens.

| Level | Light | Role |
| --- | --- | --- |
| `surface-1` | White | Dense content, card grids. The default |
| `surface-2` | Tinted lavender | The alternating band |
| `surface-3` | Near-black | **Gravity** — the problem, trust, security |
| `surface-brand` | Saturated violet | **The promise and the close** |

Available on each: `bg-surface-N`, `text-surface-N-foreground`,
`text-surface-N-muted`, `border-surface-N-border`. Levels 3 and brand also
provide `-raised` for panels sitting on top of them.

### Rules

- Alternate **1 → 2 → 1 → 2**, and drop in level 3 or brand only where the
  message earns it.
- **Levels 3 and brand are rare: roughly one section in five.** They mark
  emotional beats. Used often, they stop meaning anything.
- A band is **full-bleed**. The colour spans the viewport; an inner
  `max-w-marketing` container holds the content.
- Bands are **flat colour fields**, not gradients.
- Inside a dark or brand band, panels use the `-raised` token with a hairline
  `-border`, never a glass or blur effect.

### Section spacing

Use the scale, not judgement:

| Token | Value | Use |
| --- | --- | --- |
| `py-section-sm` | 4rem / 64px | Tight bands, footers |
| `py-section-md` | 6rem / 96px | The default section |
| `py-section-lg` | 8rem / 128px | Hero, major closing sections |

Whitespace **above** a heading is deliberately larger than below it, so each
heading binds visually to its own content.

---

## 4. Colour

### Brand — violet

Carries identity: primary actions, active states, highlights, the logo.

| Token | Light | Role |
| --- | --- | --- |
| `brand-400` | `#a684f7` | Accents on dark surfaces |
| `brand-500` | `#8b5cf6` | Gradient mid-stop |
| `brand-600` | `#6d28d9` | **Primary** — buttons, links, focus rings |
| `brand-700` | `#5b21b6` | Pressed states, brand band fill |

### Navy — contrast

Deep, near-black violet for the dashboard sidebar and dark panels.
`navy-800` `#1a1724` · `navy-900` `#12101c` · `navy-950` `#0d0b15`

### Surfaces

Light mode puts **white cards on a very light lavender page** (`#fbfaff`),
which gives separation without heavy borders. Dark mode inverts to near-black
violet.

### Status — reserved

`success` · `warning` · `danger` · `info`

Two rules:

1. Never reuse them as chart series colours.
2. **Never signal state with colour alone** — always pair with an icon or a
   label, for colour-blind users and for anyone scanning quickly.

Each has `-subtle` (tinted background) and `-strong` (readable text) variants.

### Colour hierarchy — how much colour, and where

Inside the product, colour is spent in this strict order:

```
1. Status colour   → something needs attention        (rarest, strongest)
2. Violet          → an action you can take
3. Chart series    → identity inside a visualisation
4. Neutral ink     → everything else                  (most of the screen)
```

The point: if a dashboard is mostly neutral, a single amber chip becomes
genuinely informative. This is how BizMind's alerting becomes *visual* rather
than merely textual. A colourful dashboard cannot alert.

**One brand hue only.** There is no secondary decorative colour. All other
colour on screen is functional — status or data.

---

## 5. Chart colours — validated, do not change casually

Six categorical series, defined for both themes:

| Slot | Light | Dark | Hue |
| --- | --- | --- | --- |
| 1 | `#7c3aed` | `#8b72e6` | violet (brand) |
| 2 | `#1baf7a` | `#1fa878` | aqua |
| 3 | `#eb6834` | `#e2703a` | orange |
| 4 | `#2a78d6` | `#4a90e8` | blue |
| 5 | `#e87ba4` | `#d55c8b` | magenta |
| 6 | `#eda100` | `#bc8200` | yellow |

Both sets were run through a colour-blind separation and contrast validator and
pass every gate on the adjacent-pair list:

- **Light** (surface `#ffffff`): worst adjacent CVD ΔE **9.2**, worst
  normal-vision ΔE **19.6**.
- **Dark** (surface `#1a1a24`): worst adjacent CVD ΔE **9.5**, worst
  normal-vision ΔE **18.9**.

### Rules

- **Assign in fixed order, never cycled.** A seventh series is not a new hue —
  fold the remainder into "Other", split into small multiples, or use a
  different form. `getSeriesColor()` in `src/config/design-tokens.ts` throws
  rather than wrapping around, because two series sharing a colour is a
  correctness bug in a business chart.
- **Colour follows the entity, not its rank.** Filtering a chart must not
  repaint the series that remain.
- **One y-axis.** Never a dual-axis chart. Two measures at different scales get
  two charts, or index both to a common base.
- **Sequential** encoding is one hue light→dark. **Diverging** is two hues with
  a neutral grey midpoint. Never a rainbow.
- **Relief rule:** on the light surface, slots 2, 5 and 6 sit below 3:1
  contrast. Charts using them must ship visible direct labels or an accessible
  table view.
- **Text wears text tokens, never the series colour.** Labels and values stay in
  `foreground` / `muted-foreground`; the coloured mark beside them carries
  identity.
- For two or more series a legend is always present; up to four are also
  directly labelled, so identity is never colour-alone.
- **Charts live inside a framed panel**, never floating loose on the page.

If the palette must change, re-run the validation before shipping — do not
eyeball colour-blind safety.

---

## 6. Typography

Three faces, each with a job. Declared once in `src/config/fonts.ts`.

| Role | Face | Used for |
| --- | --- | --- |
| Heading | **Plus Jakarta Sans** | Headlines, section titles, card titles |
| Body / UI | **Inter** | Everything else. Built for dense interfaces |
| Figures | **JetBrains Mono** | Money, quantities, IDs |

### Rules

- **Two weights do almost all the work:** bold (700) for headings, regular (400)
  for body. Use medium/semibold sparingly, for labels and card titles. A ladder
  of five weights reads as amateur.
- **Tracking tightens as type grows.** `tracking-tighter` (−0.035em) on display
  headings, `tracking-tight` (−0.02em) on section headings. `h1`–`h4` pick up
  the heading face and tight tracking automatically.
- **Headlines are short — 4 to 9 words.** If a headline needs more, it is doing
  the supporting line's job.
- **Body text is `muted`, not `foreground`.** Full-black body copy on white
  reads harsh and flattens hierarchy.
- **Running text is capped at `max-w-prose-comfortable`** (42rem). A paragraph
  wider than roughly 75 characters is measurably harder to read.
- **Any number a user compares gets `tabular-nums`.** Proportional digits make
  columns of money jitter:

```tsx
<span className="font-mono tabular-nums">1,240,500.00</span>
```

---

## 7. Section header pattern

Every marketing section opens with the same three-part unit. Consistency here
does more for the premium feel than any individual flourish.

```
[eyebrow]     small, uppercase, wide tracking, primary colour, low prominence
[headline]    large, bold, tight tracking, 4–9 words
[support]     1–2 lines, muted, capped at prose width
```

```tsx
<p className="text-xs font-semibold tracking-widest text-primary uppercase">
  Design system
</p>
<h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
  One token set, every surface
</h2>
<p className="mt-3 max-w-prose-comfortable text-surface-2-muted">
  Supporting line.
</p>
```

**Headings are left-aligned by default.** Centre only the hero and a final
closing section.

---

## 8. Cards and icons

- **Most cards carry no shadow.** Separation comes from surface contrast plus a
  hairline border. Reach for `shadow-none` on cards inside a tinted band.
- **Cards in a row are equal height.** Ragged card bottoms are the clearest
  signal of an unconsidered layout.
- Internal padding is generous — 24–32px.
- Anatomy: icon tile → title (semibold, small) → description (muted, 2–3 lines).

### Icon tiles

- Icons are **single-colour line icons with a uniform stroke weight**
  (lucide-react). No multicolour, no 3D, no emoji.
- An icon sits in a **small rounded-square tinted container** (~40px,
  `rounded-md`, `bg-accent`, `text-accent-foreground`), not as a floating
  coloured glyph.
- The only place multicoloured marks are acceptable is a third-party
  integration logo grid, where the logos are other companies' brands.

---

## 9. Metric and insight cards

The core product pattern. A metric card separates **what is true** from
**what the AI says about it** — which is also the honest expression of our
architecture rule: the figure is computed and verified; the narration is AI.

```
┌────────────────────────────────────────────┐
│ ▸ status chip    metric name        source │  ← where the number came from
│                                            │
│   ৳245,000            ▲ 8.4%               │  ← verified, computed
│   large mono, tabular   delta chip          │
│                                            │
│   Why: revenue rose but Amazon fees…       │  ← AI explanation
│   ─────────────────────────────────────    │
│   [ Recommended action ]            →      │  ← what to do
└────────────────────────────────────────────┘
```

Rules:

- The figure is **mono, tabular, large**. It is the loudest thing in the card.
- The **delta chip carries an arrow as well as a colour** — never colour alone.
- The AI explanation is visually separated from the figure. A reader must never
  be unsure which part is computed and which is generated.
- A **hero statistic** (a single large number with a short label, no chart) is
  often better than a chart. Reach for it when there is one number that matters.

### The home dashboard (`/overview`)

It follows the owner's reference layout, top to bottom:
- a status ribbon
- six headline cards
- what needs attention
- the waterfall
- the daily trend
- costs next to what changed
- the accounts
- expected payouts next to data health
- products
- observations
- quick actions

It is drawn only with this system's tokens. Charts use `chart-1` to `chart-4`.
A figure that is not final is hatched and labelled, never shown in a solid
"final" colour. On a phone the cards stack two, then one, per row, and the
tables scroll inside their card.

---

## 10. Buttons

- **Primary:** solid violet, white text, fully rounded pill, generous
  horizontal padding, often with a trailing arrow.
- **Secondary:** transparent with a hairline border, same pill shape.
- **Inverse:** on `surface-brand` or `surface-3`, the CTA flips — white fill,
  brand text:

```tsx
<Button className="bg-surface-brand-foreground text-surface-brand
                   hover:bg-surface-brand-foreground/90">
```

- **One primary CTA per section.** Never two competing primaries.
- **There is no glow token, and buttons never glow — inside the product.**
  See `DECISIONS.md`. The marketing homepage's hero is the one named
  exception (`DECISIONS.md`, 2026-09-29): a violet glow and soft gradient on
  its background, its product console and its own primary buttons, written
  as plain classes on marketing components only, never as a token, and never
  present on a screen behind sign-in.

---

## 11. Shape, depth and motion

- **Radius:** base `0.75rem`. Cards and panels `rounded-xl`; buttons, pills and
  badges fully rounded (`rounded-4xl`); icon tiles `rounded-md`.
  **Cards are deliberately not pill-rounded** — the contrast between
  rectangular cards and round buttons is what makes CTAs read as actions.
- **Borders:** hairline and low-contrast, present nearly everywhere. They do
  the structural work heavy shadows would otherwise do.
- **Elevation:** `shadow-xs` → `shadow-xl`, reserved for things that genuinely
  float — dialogs, popovers, dropdowns, layered product screenshots. Not
  ordinary cards.
- **Motion:** short, functional transitions on state change only. State is
  communicated by **colour and position**, not by movement. No parallax, no
  scroll-jacking. `prefers-reduced-motion` is respected globally in
  `globals.css` — never override it.
  **One exception, marketing register only (owner decision, 2026-10-06):**
  scroll reveals. A band's header and blocks fade and rise 18px once, as they
  enter the viewport, staggered 80ms apart (at most five steps), over 700ms;
  chart lines on the landing page draw themselves; the hero rises in order on
  load. Done with a `data-reveal` attribute and `ScrollReveal`
  (`src/features/marketing/components/scroll-reveal.tsx`); styles live in
  `globals.css`. Nothing is hidden until the script runs, nothing hides for a
  visitor who prefers reduced motion, each element plays once, and nothing
  shifts layout. **The product register never uses it**: a dashboard must not
  make anyone wait to read a number.

---

## 12. Layout

- **Uniform grids, not bento.** Rows of 3 or 4 equal cards. Variation comes from
  the *section layout* changing, not from cards changing size. This is calmer,
  more enterprise, and trivially responsive. Use a bento mosaic only where the
  content genuinely varies in importance — a dashboard overview, not a feature
  list.
- Recurring patterns: 3-across and 4-across grids; 50/50 text + product image;
  60/40 text + list.
- **Containers:** `max-w-marketing` (1280px) for marketing sections;
  `max-w-prose-comfortable` (42rem) for running text. Page padding
  `px-5 sm:px-8`.
- Gradients are used sparingly: `text-brand-gradient` for a single hero phrase.
  Band surfaces are flat, not gradient.

---

## 13. Product imagery

- **Show the real product interface.** Screenshots are the primary visual, and
  they are what make the value legible.
- Frame them: `rounded-xl`, hairline border, real elevation (`shadow-lg`/`xl`).
  Layering and overlapping panels are allowed here — this is the one place
  depth is welcome.
- **No abstract AI imagery.** No orbs, blobs, neural-network motifs, glowing
  brains, 3D shapes or mascots.
- Photography, if used at all, is real and muted. **No people photography inside
  the product** — BizMind's credibility comes from its numbers.

---

## 14. Responsive

Design for mobile, tablet, laptop and desktop. Grids collapse 4 → 2 → 1; split
sections stack with text above image.

Dashboards get a real mobile layout — stacked cards, tables scrolling inside
their own `overflow-x-auto` container — not a shrunken desktop grid.

**The page body must never scroll horizontally at any width.**

---

## 15. Avoid

Generic AI-landing-page styling · heavy glassmorphism · gradients everywhere ·
glowing effects · busy or decorative animation · centred AI hero sections ·
multicoloured icon sets · abstract "AI magic" visuals · childish illustration ·
dated enterprise-ERP chrome · cluttered dashboards · walls of text ·
everything-pill-rounded · template dashboards · default Inter-only typography ·
dual-axis charts.

**And the most important one:** do not let visual polish outrun correctness. A
beautiful card showing a wrong profit figure is worse than a plain one showing
the right figure. This design system exists to make verified numbers legible —
not to decorate them.
