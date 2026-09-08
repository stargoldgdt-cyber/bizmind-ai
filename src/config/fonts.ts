import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google"

/**
 * BizMind typography.
 *
 * This is the ONLY place fonts are declared. To change a typeface across the
 * whole product, change it here — every component reads it through the CSS
 * variables below, never by importing a font directly.
 *
 * Roles:
 *   sans    — UI and body text. Optimised for dense dashboard reading.
 *   heading — headlines and section titles. Geometric, high-impact.
 *   mono    — financial figures, IDs, code. Fixed width so digits align.
 */

/** Body and interface text. Inter is the reference face for data-dense UI. */
export const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

/** Display face for headlines. Geometric and modern without being novelty. */
export const fontHeading = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
})

/** Monospace for figures, identifiers and code samples. */
export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
})

/** Every font variable, ready to spread onto the <html> element. */
export const fontVariables = [
  fontSans.variable,
  fontHeading.variable,
  fontMono.variable,
].join(" ")
