/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Set a hard maximum on image optimization surface for the marketing site;
  // the app itself lives elsewhere and does not depend on this project.
  images: {
    remotePatterns: [],
  },

  // Serve the full SakanHub product design (public/design.html) at the
  // site root. Vercel still detects Next.js from package.json, so the
  // build succeeds; at request time the rewrite hands `/` to the static
  // HTML file. The middleware is neutralised below so it does not
  // intercept `/` before the rewrite fires.
  async rewrites() {
    return [
      { source: '/', destination: '/design.html' },
    ];
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default nextConfig;
