import { trust } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Trust, without borrowing anyone else's.
 *
 * The usual furniture here is customer logos, a user count, a rating and a
 * compliance badge. BizMind has none of those honestly available, and inventing
 * them would contradict the product's entire argument — that a plausible wrong
 * number is worse than no number.
 *
 * What it does have is unusual and checkable: six properties of how the thing
 * is built, each enforced by a test that fails the build. A buyer comparing
 * dashboards has read a hundred pages of logos and none that said "a blank
 * cell never becomes a zero". This is the more persuasive page anyway.
 *
 * Numbered, hairline-separated, no icons. Six icon tiles would turn six
 * engineering commitments into decoration.
 */
export function Trust() {
  return (
    <Band level="3" id="trust">
      <SectionHeader
        level="3"
        eyebrow={trust.eyebrow}
        headline={trust.headline}
        support={trust.support}
      />

      <ul className="mt-14 grid gap-x-12 gap-y-px sm:grid-cols-2 lg:grid-cols-3">
        {trust.guarantees.map((item, index) => (
          <li key={item.title} className="border-t border-surface-3-border pt-6 pb-8">
            <p className="font-mono text-[11px] tabular-nums text-brand-300">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-2 font-heading text-base font-semibold tracking-tight text-balance">
              {item.title}
            </h3>
            <p className="mt-2 text-sm text-pretty text-surface-3-muted">{item.body}</p>
          </li>
        ))}
      </ul>
    </Band>
  )
}
