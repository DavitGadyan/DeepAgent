import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // The dev badge sits on top of the theme toggle at the bottom of the nav rail.
  devIndicators: false,
};

export default nextConfig;
