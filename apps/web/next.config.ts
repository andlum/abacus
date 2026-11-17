import type { NextConfig } from "next";

const config: NextConfig = {
  // pg is loaded at runtime by the Node server, not bundled.
  serverExternalPackages: ["pg"],
  // `next dev` keeps a Turbopack cache in .next/dev/cache between runs. One
  // left by earlier runs on other branches in the same checkout can make every
  // page reload itself in a loop, so a click never lands. Browser tests and
  // live checks (ABACUS_COLD_DEV=1) start cold instead, as CI always does.
  experimental: { turbopackFileSystemCacheForDev: process.env.ABACUS_COLD_DEV !== "1" },
  // Only frame-ancestors: a full CSP would break Next's inline scripts.
  async headers() {
    const headers = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    if (process.env.NODE_ENV === "production") {
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
    }
    return [{ source: "/(.*)", headers }];
  },
};

export default config;
