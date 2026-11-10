import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: 'assets', replacement: path.resolve(__dirname, 'src/assets') },
      { find: /^~(.*)$/, replacement: '$1' },
    ],
  },
});
