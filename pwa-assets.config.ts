import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates favicon.ico, apple-touch-icon and the PWA icons in public/ from public/icon.svg.
// Run with `npm run icons` after changing the source icon.
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: '#1F2A24' } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: '#1F2A24' } },
  },
  images: ['public/icon.svg'],
});
