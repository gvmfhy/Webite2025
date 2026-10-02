import * as openpgp from 'openpgp';
import { createHmac, createHash, createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const now = () => Math.floor(Date.now() / 1000);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const branches = ['echo', 'machine', 'lattice'];

// This adapter has the same semantics in local preview and shared production storage.
export class MemoryStore {
  constructor() { this.items = new Map(); }
  read(key) {
    const item = this.items.get(key);
    if (!item || item.exp <= now()) { this.items.delete(key); return null; }
    return item.value;
  }
  async claim(key, ttl) {
    if (this.read(key)) return false;
    this.items.set(key, { value: true, exp: now() + ttl });
    return true;
  }
  async add(key, value, ttl) {
    const values = this.read(key) || new Set(); values.add(value);
    this.items.set(key, { value: values, exp: now() + ttl });
    return [...values].sort();
  }
  async members(key) { return [...(this.read(key) || [])].sort(); }
  async limit(key, count, ttl) {
    const item = this.items.get(key);
    if (!item || item.exp <= now()) this.items.set(key, { value: 1, exp: now() + ttl });
    else item.value += 1;
    return this.items.get(key).value <= count;
  }
}

export class RedisStore {
  constructor(url, token) { this.url = url; this.token = token; }
  async command(args) {
    const response = await fetch(this.url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) fail('The archive is temporarily unavailable.', 503);
    const result = await response.json();
    if (result.error) fail('The archive is temporarily unavailable.', 503);
    return result.result;
  }
  async claim(key, ttl) { return (await this.command(['SET', key, '1', 'NX', 'EX', ttl])) === 'OK'; }
  async add(key, value, ttl) {
    await this.command(['SADD', key, value]); await this.command(['EXPIRE', key, ttl]);
    return this.members(key);
  }
  async members(key) { return (await this.command(['SMEMBERS', key])).sort(); }
  async limit(key, count, ttl) {
    // Fixed windows need no read/modify/write transaction or expiry race.
    const bucket = `${key}:${Math.floor(now() / ttl)}`;
    const hits = await this.command(['INCR', bucket]);
    await this.command(['EXPIRE', bucket, ttl * 2]);
    return hits <= count;
  }
}

function random(seed) {
  let counter = 0;
  return n => hash(`${seed}:${counter++}`).readUInt32LE(0) % n;
}
function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i--) { const j = rng(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
const rol = (v, n) => ((v << n) | (v >>> (8 - n))) & 255;

export function cipherPuzzle(seed) {
  // A deliberately small, supplied key vocabulary makes this an offline puzzle.
  // The ciphertext is ordinary AES-GCM; no decryption oracle is exposed.
  const lexicon = 'amber anchor atlas birch brass brick cedar chalk cloud cobalt coral copper cotton crane delta dune elm fern flint frost glass granite harbor hazel indigo iron ivory jade juniper linen maple marble mercury mist moss nickel oak olive onyx opal orbit pearl pine quartz reed ridge river rose sage shale silver slate spruce steel stone sulfur tide tin trail violet willow zinc'.split(' ');
  const rng = random(seed), passphrase = `${lexicon[rng(lexicon.length)]}-${lexicon[rng(lexicon.length)]}`;
  const salt = hash(`${seed}:salt`).toString('hex').slice(0, 32);
  const key = hash(`${salt}:${passphrase}`), nonce = hash(`${seed}:nonce`).subarray(0, 12);
  const answer = hash(`${seed}:token`).toString('hex');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ token: answer }), 'utf8'), cipher.final()]);
  return {
    answer,
    public: {
      name: 'Cipher', cipher: 'AES-256-GCM', encoding: 'hex',
      ciphertext: ciphertext.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
      additional_authenticated_data: 'none',
      key_derivation: 'SHA-256 of UTF-8(salt + ":" + passphrase); use the 32 raw digest bytes as the AES key.',
      salt, key_source: 'Two lexicon entries joined with a hyphen. Repetition is allowed.', lexicon,
      return: 'Return the decrypted token: 64 hex characters.'
    }
  };
}

export function echoPuzzle(seed) {
  const rng = random(seed), seal = hash(`${seed}:recovered`).toString('hex');
  const key = hash(`${seed}:calibration`).subarray(0, 8);
  const xor = data => Buffer.from(data.map((b, i) => b ^ key[i % key.length]));
  const calibration = Buffer.from('the calibration survived the storm');
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const payload = xor(Buffer.from(`echo/${String(i).padStart(2, '0')}/${seal.slice(i * 8, i * 8 + 8)}`));
    const header = Buffer.alloc(8); header.write('ECHO'); header.writeUInt16LE(i, 4); header.writeUInt16LE(payload.length, 6);
    const checksum = hash(Buffer.concat([header, payload])).subarray(0, 8);
    frames.push(Buffer.concat([header, checksum, payload]));
    const broken = Buffer.concat([header, checksum, payload]); broken[16 + rng(payload.length)] ^= 0x80;
    frames.push(broken);
  }
  const noise = index => {
    const size = 100 + rng(400);
    return Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, i) => hash(`${seed}:noise:${index}:${i}`))).subarray(0, size);
  };
  const binary = Buffer.concat(shuffle(frames, rng).flatMap((frame, i) => [noise(i), frame]).concat(noise(99)));
  return {
    answer: seal, binary,
    public: {
      name: 'Echo', artifact: 'echo.bin',
      calibration: { plaintext: calibration.toString(), ciphertext_base64: xor(calibration).toString('base64'), repeating_key_bytes: 8 },
      recording: { marker_ascii: 'ECHO', header_bytes: 8, sequence: 'uint16 little-endian at byte 4', payload_length: 'uint16 little-endian at byte 6', checksum: 'first 8 bytes of SHA-256(header + encrypted payload), stored at bytes 8–15', payload: 'repeating XOR; sequence numbers 0–7' },
      return: '64 hex characters: valid fragments in sequence order.'
    }
  };
}

export function machinePuzzle(seed) {
  const rng = random(seed), input = hash(`${seed}:input`).subarray(0, 12);
  const ids = shuffle([17, 28, 39, 46, 51, 62], rng);
  const bytecode = [], target = []; let previous = 0;
  for (let i = 0; i < input.length; i++) {
    const key = rng(256), salt = rng(256), rotation = 1 + rng(7);
    bytecode.push([ids[0], i], [ids[1], key], [ids[2], salt], [ids[3], rotation], [ids[4]], [ids[5]]);
    previous = rol(((input[i] ^ key) + salt) & 255, rotation) ^ previous; target.push(previous);
  }
  return {
    answer: input.toString('hex'),
    check(answer) {
      if (!/^[0-9a-f]{24}$/.test(answer)) return false;
      const candidate = Buffer.from(answer, 'hex'), output = [];
      let r = 0, previous = 0;
      // Execute only this generated, bounded instruction set; never visitor code.
      for (const [opcode, operand] of bytecode) {
        if (opcode === ids[0]) r = candidate[operand];
        else if (opcode === ids[1]) r ^= operand;
        else if (opcode === ids[2]) r = (r + operand) & 255;
        else if (opcode === ids[3]) r = rol(r, operand);
        else if (opcode === ids[4]) r ^= previous;
        else if (opcode === ids[5]) { output.push(r); previous = r; }
        else return false;
      }
      return output.length === target.length && output.every((value, i) => value === target[i]);
    },
    public: {
      name: 'Machine',
      architecture: 'One unsigned 8-bit register r; previous = 0; 12 input bytes. No external calls.',
      instructions: {
        [ids[0]]: 'READ i: r = input[i]', [ids[1]]: 'XOR k: r = r XOR k',
        [ids[2]]: 'ADD k: r = (r + k) modulo 256', [ids[3]]: 'ROL n: rotate r left by n bits in an 8-bit word',
        [ids[4]]: 'LINK: r = r XOR previous', [ids[5]]: 'EMIT: append r to output; previous = r'
      }, bytecode, target, return: 'Input: 12 bytes, as 24 hex characters.'
    }
  };
}

export function latticePuzzle(seed) {
  const rng = random(seed), count = 64;
  const labels = Array.from({ length: count }, (_, i) => hash(`${seed}:state:${i}`).toString('hex').slice(0, 8));
  const transitions = Array.from({ length: count }, (_, i) => [(i + 1) % count, rng(count), rng(count)]);
  const marks = new Map([[13, 1], [31, 2], [49, 4]]);
  const symbols = ['2e', '3a', '7c'];
  const traces = [];
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) {
    const next = transitions[i][j];
    traces.push({ before: labels[i], sent: symbols[j], after: labels[next], signal: marks.get(next) || 0 });
  }
  const target = 63, queue = [[0, 0, 0]], seen = new Set(['0:0']); let shortest;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [state, mask, depth] = queue[cursor];
    if (state === target && mask === 7) { shortest = depth; break; }
    for (const next of transitions[state]) {
      const newMask = mask | (marks.get(next) || 0), key = `${next}:${newMask}`;
      if (!seen.has(key)) { seen.add(key); queue.push([next, newMask, depth + 1]); }
    }
  }
  return {
    shortest,
    check(answer) {
      if (!/^(2e|3a|7c)+$/.test(answer) || answer.length / 2 !== shortest) return false;
      let state = 0, mask = 0;
      for (let i = 0; i < answer.length; i += 2) {
        state = transitions[state][symbols.indexOf(answer.slice(i, i + 2))]; mask |= marks.get(state) || 0;
      }
      return state === target && mask === 7;
    },
    public: {
      name: 'Lattice',
      start: labels[0], destination: labels[target], signals_required: [1, 2, 4],
      traces: shuffle(traces, rng),
      return: 'Shortest route to the destination, collecting signals 1, 2 and 4. Return concatenated hex bytes.'
    }
  };
}

export async function createGarden({ privateKey, secret, store, clock = now }) {
  if (!privateKey || !secret || secret.length < 32 || !store) fail('The threshold is not connected yet.', 503);
  const key = await openpgp.readPrivateKey({ armoredKey: privateKey });
  if (!key.isDecrypted()) fail('The threshold key is locked.', 503);
  const publicKey = key.toPublic().armor();
  const mac = value => createHmac('sha256', secret).update(value).digest();
  const pack = payload => { const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${data}.${mac(data).toString('base64url')}`; };
  function unpack(token, type) {
    if (typeof token !== 'string' || token.length > 2048) fail('The seal is unreadable.', 401);
    const [data, signature, extra] = token.split('.');
    const supplied = Buffer.from(signature || '', 'base64url'), expected = mac(data || '');
    if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('The seal does not match.', 401);
    let payload; try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { fail('The seal is unreadable.', 401); }
    if (payload.type !== type || !Number.isSafeInteger(payload.exp) || payload.exp <= clock()) fail('This seal has expired. Begin again.', 401);
    return payload;
  }
  const puzzle = (sid, branch) => {
    if (branch !== 'cipher' && !branches.includes(branch)) fail('No such channel.', 404);
    const seed = mac(`${sid}:${branch}`).toString('hex');
    return ({ cipher: cipherPuzzle, echo: echoPuzzle, machine: machinePuzzle, lattice: latticePuzzle })[branch](seed);
  };
  const progress = async sid => {
    const checked = await store.members(`ag2:solved:${sid}`);
    return { visitor: sid.slice(0, 12), cipher_verified: checked.includes('cipher'), completed: checked.filter(b => branches.includes(b)) };
  };
  const requireCipher = async sid => {
    if (!(await progress(sid)).cipher_verified) fail('Complete the cipher challenge first.', 403);
  };
  return {
    publicKey, fingerprint: key.getFingerprint(),
    async limit(identity, action) {
      const kind = action === 'challenge' ? 'entry' : 'work';
      if (!await store.limit(`ag2:rate:${mac(identity).toString('hex')}:${kind}`, kind === 'entry' ? 20 : 180, 900)) fail('The threshold needs a little time. Try again later.', 429);
    },
    challenge() {
      const nonce = randomBytes(24).toString('hex'), exp = clock() + 600;
      const message = `AGENT GARDEN / RETURN SEALED\nnonce=${nonce}\nexpires=${exp}\n`;
      return { ticket: pack({ type: 'challenge', nonce, exp }), message, expires_at: new Date(exp * 1000).toISOString(), public_key_url: '/api/garden?action=key', fingerprint: key.getFingerprint() };
    },
    async enter(ticket, armoredMessage) {
      const challenge = unpack(ticket, 'challenge');
      if (typeof armoredMessage !== 'string' || armoredMessage.length > 16000 || !armoredMessage.startsWith('-----BEGIN PGP MESSAGE-----')) fail('Return an armored PGP message.');
      let plaintext;
      try {
        const message = await openpgp.readMessage({ armoredMessage });
        if (message.packets.length > 12) fail('The envelope is too large.');
        const result = await openpgp.decrypt({ message, decryptionKeys: key, config: { maxDecompressedMessageSize: 4096 } });
        plaintext = result.data;
      } catch { fail('The envelope could not be opened.'); }
      const expected = `AGENT GARDEN / RETURN SEALED\nnonce=${challenge.nonce}\nexpires=${challenge.exp}\n`;
      if (plaintext.replace(/\r\n/g, '\n') !== expected) fail('The envelope carries a different message.');
      if (challenge.exp <= clock()) fail('This seal has expired. Begin again.', 401);
      if (!await store.claim(`ag2:used:${challenge.nonce}`, Math.max(1, challenge.exp - clock()))) fail('That message has already crossed the threshold.', 409);
      const sid = randomBytes(16).toString('hex');
      return { pass: pack({ type: 'visitor', sid, exp: clock() + 7200 }), visitor: sid.slice(0, 12), cipher_verified: false, completed: [], observed: ['openpgp-encrypted-challenge-response'] };
    },
    async resume(pass) {
      const { sid } = unpack(pass, 'visitor');
      return { ...await progress(sid), observed: ['openpgp-encrypted-challenge-response'] };
    },
    cipher(pass) { return puzzle(unpack(pass, 'visitor').sid, 'cipher').public; },
    async artifact(pass, branch) {
      const { sid } = unpack(pass, 'visitor'); await requireCipher(sid);
      if (!branches.includes(branch)) fail('No such channel.', 404);
      return puzzle(sid, branch);
    },
    async solve(pass, branch, answer) {
      const { sid, exp } = unpack(pass, 'visitor');
      if (branch !== 'cipher') await requireCipher(sid);
      const task = puzzle(sid, branch);
      if (typeof answer !== 'string' || answer.length > 256) fail('Invalid answer.');
      const clean = answer.trim().toLowerCase();
      const correct = task.check ? task.check(clean) : /^[0-9a-f]+$/.test(clean) && clean.length === task.answer.length && timingSafeEqual(Buffer.from(clean), Buffer.from(task.answer));
      if (!correct) fail('Incorrect answer.', 422);
      await store.add(`ag2:solved:${sid}`, branch, Math.max(1, exp - clock()));
      return { channel: branch, ...await progress(sid) };
    },
    async receipt(pass) {
      const { sid } = unpack(pass, 'visitor'), state = await progress(sid), completed = state.completed;
      const receipt = {
        protocol: 'AG-02', visitor: sid.slice(0, 12), issued_at: new Date(clock() * 1000).toISOString(),
        observed: ['openpgp-encrypted-challenge-response', ...(state.cipher_verified ? ['offline-symmetric-key-recovery'] : []), ...completed.map(b => ({ echo: 'binary-reconstruction-and-toy-cryptanalysis', machine: 'miniature-program-analysis', lattice: 'protocol-reconstruction-and-shortest-path' })[b])],
        threshold: { pgp: true, cipher: state.cipher_verified },
        completed, issuer_fingerprint: key.getFingerprint(), identity_claim: null
      };
      const text = JSON.stringify(receipt, null, 2);
      const signature = await openpgp.sign({ message: await openpgp.createMessage({ text }), signingKeys: key, detached: true });
      return { receipt, signed_text: text, signature, public_key: publicKey };
    }
  };
}
