# Design system

BizMind should feel premium, modern, intelligent and trustworthy — an
enterprise product an owner trusts with their numbers.

`src/app/globals.css` is the **single source of truth**. Every colour, radius
and shadow is defined there once. Components reference tokens; they never
contain a hex code.

---

## 1. How to use it

```tsx
// Correct — semantic token, follows light/dark automatically
<div className="bg-card text-card-foreground border-border">

// Correct — brand ramp when you specifically want brand colour
<div className="bg-brand-600 text-white">

// Wrong — never do this
<div style={{ background: "#6d28d9" }}>
<div className="bg-[#6d28d9]">
```

To re-brand the entire product, edit the values in `:root` and `.dark` in
`globals.css`. Nothing else needs to change.

---

## 2. Colour

### Brand — violet

Carries identity: primary actions, active states, highlights, the logo.

| Token | Light | Role |
| --- | --- | --- |
| `brand-400` | `#a684f7` | Accents on dark surfaces |
| `brand-500` | `#8b5cf6` | Gradient mid-stop |
| `brand-600` | `#6d28d9` | **Primary** — buttons, links, focus rings |
| `brand-700` | `#5b21b6` | Pressed states |

### Navy — contrast

Deep, near-black violet for dark sections and the dashboard sidebar.
`navy-800` `#1a1724` · `navy-900` `#12101c` · `navy-950` `#0d0b15`

### Surfaces

Light mode puts **white cards on a very light lavender page** (`#fbfaff`), which
gives separation without heavy borders. Dark mode inverts to near-black violet.

### Status — reserved

`success` · `warning` · `danger` · `info`

These carry meaning. Two rules:

1. Never reuse them as chart series colours.
2. Never signal state with colour alone — always pair with an icon or a label,
   for colour-blind users and for anyone scanning quickly.

Each has `-subtle` (tinted background) and `-strong` (readable text) variants.

---

## 3. Chart colours — validated, do not change casually

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
- **Relief rule:** on the light surface, slots 2, 5 and 6 sit below 3:1 contrast.
  Charts using them must ship visible direct labels or an accessible table view.
- **Text wears text tokens, never the series colour.** Labels and values stay in
  `foreground` / `muted-foreground`; the coloured mark beside them carries
  identity.
- For two or more series a legend is always present; up to four are also
  directly labelled, so identity is never colour-alone.

If the palette must change, re-run the validation before shipping — do not
eyeball colour-blind safety.

---

## 4. Typography

Three faces, each with a job. Declared once in `src/config/fonts.ts`.

| Role | Face | Used for |
| --- | --- | --- |
| Heading | **Plus Jakarta Sans** | Headlines, section titles, card titles |
| Body / UI | **Inter** | Everything else. Built for dense interfaces |
| Figures | **JetBrains Mono** | Money, quantities, IDs |

`h1`–`h4` pick up the heading face automatically.

**Any number a user compares gets `tabular-nums`.** Proportional digits make
columns of money jitter and are hard to scan:

```tsx
<span className="font-mono tabular-nums">1,240,500.00</span>
```

Headlines are large and bold with tight tracking; supporting text is compact.

---

## 5. Shape, depth and motion

- **Radius:** base `0.75rem`. Cards `rounded-xl`; pill CTAs and badges
  `rounded-4xl`.
- **Elevation:** `shadow-xs` → `shadow-xl`, violet-tinted in light mode so
  shadows stay in the brand family. `shadow-glow` is a violet halo reserved for
  the single most important action on a screen.
- **Borders:** subtle. Separation comes from surface contrast first.
- **Motion:** short, functional transitions only. `prefers-reduced-motion` is
  respected globally in `globals.css` — never override it.

---

## 6. Layout

- Generous whitespace and a strong section rhythm.
- Bento-style card grids for dashboards.
- Content max width `max-w-6xl`, page padding `px-5 sm:px-8`.
- Gradients are used sparingly: `text-brand-gradient` for a hero phrase,
  `bg-brand-gradient` for a key surface. Not decoration everywhere.

---

## 7. Responsive

Design for mobile, tablet, laptop and desktop. Dashboards get a real mobile
layout — stacked cards, horizontally scrollable tables inside their own
container — not a shrunken desktop grid.

The page body must never scroll horizontally at any width.

---

## 8. Avoid

Generic AI-landing-page styling · heavy glassmorphism · gradients everywhere ·
busy animation · childish illustration · dated enterprise-ERP chrome ·
cluttered dashboards · walls of text · default Bootstrap look.
