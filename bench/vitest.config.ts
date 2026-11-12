import { defineConfig } from 'vitest/config'

// Its own config, so a run from this folder never picks up a parent project's config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
})
