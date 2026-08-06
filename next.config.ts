import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / driver packages that must stay outside the bundle.
  serverExternalPackages: ["better-sqlite3", "pg"],
};

export default nextConfig;
