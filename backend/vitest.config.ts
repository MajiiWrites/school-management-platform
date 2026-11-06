import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The OCR module has its own tsx/NodeNext harness (node:test) under
    // src/modules/ocr/tests — vitest cannot collect node:test suites, so
    // exclude them here. Run them with the harness instead:
    //   cd src/modules/ocr/tests && npx tsx --test *.test.ts
    // (see backend/INTEGRATION.md for the counts).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      'src/modules/ocr/tests/**',
    ],
  },
});
