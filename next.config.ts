import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent aggressive caching of HTML pages — forces fresh load after deploys
  async headers() {
    return [
      {
        source: '/',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, must-revalidate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
