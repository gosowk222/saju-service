import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  serverExternalPackages: ['sajuengine', '@js-temporal/polyfill', 'manseryeok'],
  outputFileTracingIncludes: {
    '/': [
      './node_modules/@js-temporal/polyfill/package.json',
      './node_modules/@js-temporal/polyfill/dist/**/',
    ],
  },
};

export default nextConfig;
