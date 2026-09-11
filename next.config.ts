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
};

export default nextConfig;
