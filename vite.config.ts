import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // MapLibre alone is ~1 MB minified.
  build: { chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Borders · North America',
        short_name: 'Borders',
        description: 'Country, state and province borders of North America.',
        theme_color: '#F4F5F1',
        background_color: '#F4F5F1',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell and the boundary data so the borders work offline.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,geojson}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // Basemap style, sprites and glyphs change rarely.
            urlPattern: ({ url }) =>
              url.origin === 'https://tiles.openfreemap.org' && /^\/(styles|sprites|fonts)\//.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'basemap-assets', expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 } },
          },
          {
            // Vector tiles: keep what the user has viewed for offline use.
            urlPattern: ({ url }) => url.origin === 'https://tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-tiles',
              expiration: { maxEntries: 1500, maxAgeSeconds: 14 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
});
