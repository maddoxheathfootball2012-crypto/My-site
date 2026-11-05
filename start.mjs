// Long-running server entry point (Render, Railway, or `npm start` on any computer).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EbaadRuntime } from './ebaad-runtime.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8080;

const runtime = new EbaadRuntime({ rootDir });

try {
  await runtime.activate();
  console.log('[ebaad] licence ACTIVE, files loaded:', Object.keys(runtime.files).length);
} catch (err) {
  console.error('[ebaad] activation failed:', err.message);
  process.exit(1);
}

await runtime.listen(port);
console.log(`[ebaad] site running on port ${port}`);
