import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    ignoreIssue: [
      { path: "**/data/**" },
    ],
  },
};

export default nextConfig;
