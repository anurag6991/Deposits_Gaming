/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@deposits/shared'],
  // The API runs as a separate process behind the same Nginx in production.
  // In development this proxies /api to it so the browser sees one origin and
  // the refresh cookie works without CORS exceptions.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://127.0.0.1:4000'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
