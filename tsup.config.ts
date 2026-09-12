import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Deps ficam externas: bundlar express quebra em `require` dinâmico
  // (body-parser -> debug -> tty). O runtime instala node_modules de produção.
});
