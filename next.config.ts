import type { NextConfig } from "next";

/**
 * Hosts allowed to load dev-only resources (HMR, the dev overlay).
 *
 * Next blocks these cross-origin by default, which is right: a page on another
 * origin should not be able to read your dev server. But a panel is routinely
 * reached at something other than localhost — a LAN address, a tunnel, a
 * hostname on your own domain — and there the block only breaks hot reload.
 *
 * Configured rather than hardcoded: whoever runs the panel knows their own
 * hostnames, and this file should not.
 *
 *   RUNPANEL_DEV_ORIGINS=panel.example.com,*.example.com,192.168.1.50
 *
 * Patterns are matched segment by segment with `*` / `**` wildcards
 * (next/dist/server/app-render/csrf-protection.js) — CIDR notation is NOT
 * supported and a range like 192.168.0.0/16 would silently never match, so the
 * private-network defaults below are written as wildcards. `localhost` and
 * `**.localhost` are allowed by Next itself.
 *
 * Development only: Next ignores this in production builds.
 */
const devOrigins = (process.env.RUNPANEL_DEV_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

/**
 * Sent on every response.
 *
 * The panel had none of these. The one that matters most is the framing pair:
 * this UI has a "Delete project" button and a terminal, and without them any
 * page on the internet could load it in an invisible iframe and collect clicks
 * from an operator who is already signed in.
 *
 * `frame-ancestors` is the only CSP directive set here on purpose. It governs
 * who may embed the page and nothing else, so it cannot break HeroUI or the
 * bundled icons — unlike `script-src`, which wants a report-only period first.
 *
 * HSTS is inert over plain HTTP, so it costs nothing on a LAN install and is
 * already in place the day the panel is put behind TLS.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Native / driver packages that must stay outside the bundle.
  serverExternalPackages: ["better-sqlite3", "pg"],

  // The version is not a secret worth keeping, but it is a free hint for
  // anyone scanning for a Next release with a known advisory.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  // The usual private ranges, so "open the panel from my phone" works without
  // anyone having to configure anything.
  allowedDevOrigins: [...devOrigins, "127.0.0.1", "192.168.*.*", "10.*.*.*"],
};

export default nextConfig;
