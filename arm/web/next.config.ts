import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (copies only the node_modules the server needs); run as a systemd service.
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
