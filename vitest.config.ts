import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (name: string, entry = 'src/index.ts') =>
  fileURLToPath(new URL(`./packages/${name}/${entry}`, import.meta.url))

export default defineConfig({
  resolve: {
    // Tests run against source, so a failure points at a line you can edit.
    // `npm run typecheck` builds the real entry points and is the type gate.
    alias: {
      '@spoor/core': pkg('core'),
      '@spoor/sinks/node': pkg('sinks', 'src/node.ts'),
      '@spoor/sinks': pkg('sinks'),
      '@spoor/middleware': pkg('middleware'),
      spoor: pkg('cli'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
})
