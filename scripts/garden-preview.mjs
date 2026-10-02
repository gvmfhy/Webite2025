import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as openpgp from 'openpgp';
import { createGarden, MemoryStore } from '../lib/garden.mjs';
import handler from '../api/garden.js';

const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Agent Garden local preview' }], format: 'armored' });
globalThis.__gardenPreview = await createGarden({ privateKey, secret: randomBytes(32).toString('hex'), store: new MemoryStore() });
const root = resolve('_site');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/garden') return handler(req, res);
  let file;
  try { file = resolve(root, `.${decodeURIComponent(url.pathname)}`); } catch { res.writeHead(400).end(); return; }
  if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file).catch(() => null))?.isDirectory()) file = resolve(file, 'index.html');
    else if (!extname(file)) file += '.html';
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file); res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store'); res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(Number(process.env.GARDEN_PREVIEW_PORT || 4178), '127.0.0.1', () => console.log(`Garden preview: http://127.0.0.1:${server.address().port}/agent-garden/\nKeys and replay storage are temporary; restarting begins a fresh garden.`));
