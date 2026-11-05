// Minimal static server for Maddox OS.
// Vercel runs this file as the root entrypoint (it's in Vercel's allowed
// entrypoint list), and `npm start` runs it anywhere else. It serves the
// single-page site for every route. The page is imported (not read from
// disk) so it is always bundled with the function.
import http from 'node:http';
import { PAGE_B64 } from './page.mjs';

const HTML = Buffer.from(PAGE_B64, 'base64');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate'
  });
  res.end(HTML);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log('[maddox-os] serving on port ' + port));
