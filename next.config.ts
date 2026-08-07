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

const nextConfig: NextConfig = {
  // Native / driver packages that must stay outside the bundle.
  serverExternalPackages: ["better-sqlite3", "pg"],

  // The usual private ranges, so "open the panel from my phone" works without
  // anyone having to configure anything.
  allowedDevOrigins: [...devOrigins, "127.0.0.1", "192.168.*.*", "10.*.*.*"],
};

export default nextConfig;
