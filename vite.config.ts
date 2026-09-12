import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    alias: {
      'aws-amplify/auth': new URL('./src/test/mocks/aws-amplify-auth.ts', import.meta.url).pathname,
    },
  },
});
