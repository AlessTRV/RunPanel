import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    // Expand filesystem root so Turbopack accepts symlinks (e.g. venv/bin/python → /usr/bin/python3)
    // inside data/repos/ that point to system paths outside the project directory.
    root: "/",
  },
};

export default nextConfig;
