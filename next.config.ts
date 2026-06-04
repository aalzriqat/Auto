import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // In Next.js 15, we define an array of IPs or hostnames allowed for HMR
  allowedDevOrigins: ["192.168.1.17", "localhost:3000", "0.0.0.0"],
};

export default nextConfig;
