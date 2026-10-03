import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    /**
     * In development Next.js prints every Server Function call WITH ITS
     * ARGUMENTS. Connecting a Google Sheet passes the browser's short-lived
     * Google access token as one, so it was being written to the terminal.
     * A token must never reach a log -- not even a one-hour one, not even on
     * a laptop. A test fails the build if this is switched back on.
     */
    serverFunctions: false,
  },

  /**
   * Browser-side protections on every response. Without them the sign-in page
   * could be embedded in another site and overlaid with invisible buttons
   * (clickjacking), and a browser may guess a file's type instead of trusting
   * ours.
   *
   * The Content-Security-Policy is deliberately narrow: it forbids framing and
   * plugins and pins <base>, but sets no script-src or form-action, because
   * the first needs per-request nonces to coexist with Next.js and the second
   * would block the redirect to Google when connecting a sheet. Widen it only
   * with those in place.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
    ]
  },
};

export default nextConfig;
