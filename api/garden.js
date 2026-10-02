import { createGarden, RedisStore } from '../lib/garden.mjs';

let productionGarden;
export function getGarden() {
  if (globalThis.__gardenPreview) return Promise.resolve(globalThis.__gardenPreview);
  if (!productionGarden) {
    const { GARDEN_PRIVATE_KEY, GARDEN_TOKEN_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
    if (!GARDEN_PRIVATE_KEY || !GARDEN_TOKEN_SECRET || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
      throw Object.assign(new Error('The threshold is not connected yet.'), { status: 503 });
    }
    productionGarden = createGarden({ privateKey: GARDEN_PRIVATE_KEY.replace(/\\n/g, '\n'), secret: GARDEN_TOKEN_SECRET, store: new RedisStore(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) });
    productionGarden.catch(() => { productionGarden = undefined; });
  }
  return productionGarden;
}

async function readBody(req) {
  const parse = value => {
    let body;
    try { body = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw Object.assign(new Error('Return a JSON envelope.'), { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Return a JSON envelope.'), { status: 400 });
    return body;
  };
  if (req.body !== undefined) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > 20000) throw Object.assign(new Error('The envelope is too large.'), { status: 413 });
    return parse(req.body);
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 20000) throw Object.assign(new Error('The envelope is too large.'), { status: 413 });
  }
  return parse(raw);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://garden.local'), action = url.searchParams.get('action') || 'challenge';
    const methods = { key: 'GET', challenge: 'GET', resume: 'GET', cipher: 'GET', puzzle: 'GET', artifact: 'GET', receipt: 'GET', enter: 'POST', solve: 'POST' };
    if (!methods[action]) return send(404, { error: 'No such passage.' });
    if (req.method !== methods[action]) { res.setHeader('Allow', methods[action]); return send(405, { error: 'This passage needs a different method.' }); }
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'Return the envelope to this garden.' });
    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'Return a JSON envelope.' });
    const garden = await getGarden();
    const identity = process.env.VERCEL ? (req.headers['x-forwarded-for'] || '').split(',')[0] : (req.socket?.remoteAddress || 'local');
    await garden.limit(identity, action);
    const pass = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (action === 'key') { res.setHeader('Content-Type', 'application/pgp-keys'); res.end(garden.publicKey); return; }
    if (action === 'challenge') return send(200, garden.challenge());
    if (action === 'enter') { const body = await readBody(req); return send(200, await garden.enter(body.ticket, body.message)); }
    if (action === 'resume') return send(200, await garden.resume(pass));
    if (action === 'cipher') return send(200, garden.cipher(pass));
    if (action === 'puzzle' || action === 'artifact') {
      const task = await garden.artifact(pass, url.searchParams.get('branch'));
      if (action === 'artifact' && task.binary) {
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', 'attachment; filename="echo.bin"'); res.end(task.binary); return;
      }
      return send(200, task.public);
    }
    if (action === 'solve') { const body = await readBody(req); return send(200, await garden.solve(pass, body.branch, body.answer)); }
    if (action === 'receipt') return send(200, await garden.receipt(pass));
  } catch (error) {
    // Never expose library diagnostics, environment variables, or key material.
    send(error.status || 503, { error: error.status ? error.message : 'The archive is temporarily unavailable.' });
  }
}
