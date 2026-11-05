// Server entry point. Vercel runs this file automatically, and `npm start`
// runs it anywhere else (Render, Railway, your own computer).
// It starts the EBAAD runtime from ebaad-runtime.mjs and serves every request
// through it. The locked app.ebaad package is used exactly as shipped.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EbaadRuntime } from './ebaad-runtime.mjs';

// Literal file references so Vercel bundles these files with the server.
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL('./app.ebaad', import.meta.url));
const CONFIG_FILE = fileURLToPath(new URL('./config.json', import.meta.url));
const PUBLIC_KEY = fs.existsSync(new URL('./public.pem', import.meta.url))
  ? fs.readFileSync(new URL('./public.pem', import.meta.url), 'utf8')
  : null;
if (!fs.existsSync(new URL('./app.ebaad', import.meta.url))) {
  console.error('[ebaad] app.ebaad is missing from the deployment');
}

let runtime = null;
let handle = null;
let activating = null;

function hasFiles() {
  return runtime && runtime.files && Object.keys(runtime.files).length > 0;
}

async function ensureStarted() {
  if (hasFiles()) return;
  if (!activating) {
    activating = (async () => {
      runtime = runtime || new EbaadRuntime({
        rootDir: ROOT_DIR,
        packageFile: PACKAGE_FILE,
        configFile: CONFIG_FILE,
        publicKeyPem: PUBLIC_KEY
      });
      await runtime.activate();
      handle = runtime.createHandler();
      console.log('[ebaad] licence ACTIVE, files loaded:', Object.keys(runtime.files).length);
    })().finally(() => {
      activating = null;
    });
  }
  await activating;
}

const server = http.createServer(async (req, res) => {
  try {
    await ensureStarted();
  } catch (err) {
    console.error('[ebaad] activation failed:', err && err.message);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The site could not start: ' + (err && err.message ? err.message : 'licence activation failed'));
    return;
  }
  handle(req, res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`[ebaad] server listening on port ${port}`);
});
