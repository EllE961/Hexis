import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    // Explicitly request the automatic JSX runtime so component files
    // don't need `import React` at the top. (Default in v4 but pinning
    // it here makes the behaviour immune to config drift / future
    // plugin updates.)
    react({ jsxRuntime: 'automatic' }),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/events': 'http://127.0.0.1:3001',
    },
  },
});
