import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Perf pass (2026-11-20): split the React runtime into a stable
        // `vendor` chunk. Before this, react + react-dom + react-router-dom
        // rode inside the entry chunk, so every deploy changed the entry
        // hash AND re-downloaded ~180 kB of framework code that had not
        // changed. Total first-visit bytes are unchanged; the vendor hash
        // now only moves when React/router upgrade, so repeat visits and
        // later deploys re-download only the small app chunk. Hashed
        // filenames + the immutable /assets/* cache headers in vercel.json
        // make the vendor chunk effectively permanent in the browser.
        // (Function form: this Vite version types manualChunks as a
        // function only.)
        manualChunks: (id) => {
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/@remix-run/router') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
})
