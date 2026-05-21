/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  async rewrites() {
    const apiTarget = process.env.GRADLAUNCH_API_BASE_URL ?? "http://127.0.0.1:4000";

    return [
      {
        source: "/api/:path*",
        destination: `${apiTarget}/:path*`
      }
    ];
  }
};

export default nextConfig;
