import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true, // lets @testing-library/react auto-register afterEach(cleanup)
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
