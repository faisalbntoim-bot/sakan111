/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Image Optimizer attack surface: locked down.
  //
  // The flagged Next.js CVE on 14.x (DoS via Image Optimizer
  // remotePatterns) requires an attacker-controllable remotePatterns
  // entry. We ship an empty allowlist and ALSO set `unoptimized: true`
  // so the /_next/image route produces no optimizer work regardless of
  // what a request asks for. The marketing site uses plain <img> tags
  // against a trusted CDN; no feature loses behaviour from this.
  images: {
    remotePatterns: [],
    unoptimized: true,
  },

  // Codespaces single-port preview — opt-in via SAKAN_PREVIEW_PROXY=1.
  //
  // Only port 3000 is forwarded publicly on the Codespace. The backend
  // runs on 127.0.0.1:4000 inside the container; Next.js proxies
  // /v1/*  (REST API + /v1/media/local-stream/* signed media reads)
  // to it, so Safari on an iPhone sees ONE HTTPS origin and no CORS
  // round-trips. Range headers for <video> playback pass through
  // untouched.
  //
  // Non-preview builds (local dev, CI) leave SAKAN_PREVIEW_PROXY unset,
  // the rewrite list is empty, and the app behaves exactly as before.
  async rewrites() {
    if (process.env.SAKAN_PREVIEW_PROXY !== '1') return [];
    const backend = process.env.SAKAN_PREVIEW_BACKEND || 'http://127.0.0.1:4000';
    return [
      { source: '/v1/:path*', destination: `${backend}/v1/:path*` },
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
