import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  trailingSlash: false,
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
