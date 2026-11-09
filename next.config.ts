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
  serverExternalPackages: ['sajuengine', '@js-temporal/polyfill', 'manseryeok', 'pdfkit'],
  outputFileTracingIncludes: {
    '/*': [
      './node_modules/@js-temporal/polyfill/package.json',
      './node_modules/@js-temporal/polyfill/dist/**/*',
      './assets/fonts/**/*',
      './node_modules/pdfkit/js/data/**/*',
    ],
  },
};

export default nextConfig;
