// Vercel entry point: starts the EBAAD runtime from ebaad-runtime.mjs and serves every
// request through it. The locked app.ebaad package is used exactly as shipped.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EbaadRuntime } from '../ebaad-runtime.mjs';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let runtime = null;
let handle = null;
let activating = null;

function hasFiles() {
  return runtime && runtime.files && Object.keys(runtime.files).length > 0;
}

async function ensureStarted() {
  if (hasFiles()) return;
  if (!activating) {
    runtime = runtime || new EbaadRuntime({ rootDir });
    activating = runtime
      .activate()
      .then(() => {
        handle = runtime.createHandler();
      })
      .finally(() => {
        activating = null;
      });
  }
  await activating;
}

// vercel.json rewrites every path to /api/index?__path=<original path>.
// Put the original path back so the runtime serves the right file.
function restoreOriginalUrl(req) {
  const u = new URL(req.url, 'http://localhost');
  if (!u.searchParams.has('__path')) return;
  const original = u.searchParams.get('__path') || '';
  u.searchParams.delete('__path');
  const qs = u.searchParams.toString();
  req.url = '/' + original.replace(/^\/+/, '') + (qs ? '?' + qs : '');
}

export default async function handler(req, res) {
  restoreOriginalUrl(req);
  try {
    await ensureStarted();
  } catch (err) {
    console.error('[ebaad] activation failed:', err && err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('The site could not start: ' + (err && err.message ? err.message : 'licence activation failed'));
    return;
  }
  handle(req, res);
}
