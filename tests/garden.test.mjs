import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv } from 'node:crypto';
import * as openpgp from 'openpgp';
import { createGarden, MemoryStore, cipherPuzzle, echoPuzzle, machinePuzzle, latticePuzzle } from '../lib/garden.mjs';
import handler from '../api/garden.js';

const generated = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Garden test fixture' }], format: 'armored' });
async function fixture(clock) {
  const garden = await createGarden({ privateKey: generated.privateKey, secret: 'test-secret-'.repeat(5), store: new MemoryStore(), ...(clock ? { clock } : {}) });
  const encrypt = async text => openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: await openpgp.readKey({ armoredKey: garden.publicKey }) });
  const challenge = garden.challenge(), ciphertext = await encrypt(challenge.message);
  return { garden, challenge, ciphertext, encrypt };
}

// These solvers operate on the published artifacts, never the verifier answers.
export function recoverCipher(record) {
  for (const first of record.lexicon) for (const second of record.lexicon) {
    const key = createHash('sha256').update(`${record.salt}:${first}-${second}`, 'utf8').digest();
    try {
      const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'hex'));
      decrypt.setAuthTag(Buffer.from(record.tag, 'hex'));
      const plaintext = Buffer.concat([decrypt.update(Buffer.from(record.ciphertext, 'hex')), decrypt.final()]);
      return JSON.parse(plaintext.toString('utf8')).token;
    } catch { /* The supplied candidate does not authenticate this artifact. */ }
  }
  throw new Error('The supplied vocabulary could not recover the artifact');
}
export function recoverEcho(record, binary) {
  const plain = Buffer.from(record.calibration.plaintext), cipher = Buffer.from(record.calibration.ciphertext_base64, 'base64');
  const key = plain.subarray(0, 8).map((b, i) => b ^ cipher[i]);
  const voices = new Map();
  for (let i = 0; i <= binary.length - 16; i++) {
    if (binary.toString('ascii', i, i + 4) !== 'ECHO') continue;
    const length = binary.readUInt16LE(i + 6); if (i + 16 + length > binary.length) continue;
    const header = binary.subarray(i, i + 8), payload = binary.subarray(i + 16, i + 16 + length);
    const checksum = createHash('sha256').update(header).update(payload).digest().subarray(0, 8);
    if (!checksum.equals(binary.subarray(i + 8, i + 16))) continue;
    const decoded = payload.map((b, j) => b ^ key[j % 8]).toString();
    voices.set(binary.readUInt16LE(i + 4), decoded.split('/')[2]);
  }
  assert.equal(voices.size, 8); return [...voices].sort((a, b) => a[0] - b[0]).map(([, piece]) => piece).join('');
}
export function wakeMachine(record) {
  const inputs = [];
  for (let i = 0; i < record.bytecode.length; i += 6) {
    const block = record.bytecode.slice(i, i + 6), index = block[0][1];
    const previous = index ? record.target[index - 1] : 0;
    let value = record.target[index] ^ previous;
    const rotate = block[3][1]; value = ((value >>> rotate) | (value << (8 - rotate))) & 255;
    value = (value - block[2][1] + 256) & 255; value ^= block[1][1]; inputs[index] = value;
  }
  return Buffer.from(inputs).toString('hex');
}
export function traverseLattice(record) {
  const edges = new Map();
  for (const edge of record.traces) { if (!edges.has(edge.before)) edges.set(edge.before, []); edges.get(edge.before).push(edge); }
  const queue = [[record.start, 0, '']], seen = new Set([`${record.start}:0`]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [state, mask, path] = queue[cursor];
    if (state === record.destination && mask === 7) return path;
    for (const edge of edges.get(state)) {
      const nextMask = mask | edge.signal, key = `${edge.after}:${nextMask}`;
      if (!seen.has(key)) { seen.add(key); queue.push([edge.after, nextMask, path + edge.sent]); }
    }
  }
  throw new Error('No route through the supplied observations');
}

test('fresh encrypted messages open the threshold exactly once, including concurrent replay', async () => {
  const { garden, challenge, ciphertext } = await fixture();
  const results = await Promise.allSettled([garden.enter(challenge.ticket, ciphertext), garden.enter(challenge.ticket, ciphertext)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
});
test('a correctly encrypted wrong message does not consume the entry challenge', async () => {
  const { garden, challenge, ciphertext, encrypt } = await fixture();
  await assert.rejects(garden.enter(challenge.ticket, await encrypt('wrong message')), { status: 400 });
  assert.ok((await garden.enter(challenge.ticket, ciphertext)).pass);
});
test('expired and modified tickets cannot open the threshold', async () => {
  let time = 100000; const { garden, challenge, ciphertext } = await fixture(() => time);
  await assert.rejects(garden.enter(challenge.ticket.slice(0, -2) + 'xx', ciphertext), { status: 401 });
  time += 601; await assert.rejects(garden.enter(challenge.ticket, ciphertext), { status: 401 });
});
test('all three published artifacts can be solved across different random instances', () => {
  for (let i = 0; i < 30; i++) {
    const echo = echoPuzzle(`instance-${i}`), machine = machinePuzzle(`instance-${i}`), lattice = latticePuzzle(`instance-${i}`);
    assert.equal(recoverEcho(echo.public, echo.binary), echo.answer);
    assert.equal(wakeMachine(machine.public), machine.answer);
    assert.ok(machine.check(wakeMachine(machine.public)));
    const route = traverseLattice(lattice.public); assert.ok(lattice.check(route)); assert.ok(!lattice.check(route + '2e'));
  }
});
test('Machine executes candidate inputs and rejects every one-byte substitution', () => {
  for (let i = 0; i < 40; i++) {
    const task = machinePuzzle(`machine-validation-${i}`);
    const recovered = wakeMachine(task.public);
    assert.ok(task.check(recovered));
    for (let position = 0; position < 12; position++) {
      const candidate = Buffer.from(recovered, 'hex');
      const original = candidate[position];
      for (let replacement = 0; replacement < 256; replacement++) {
        if (replacement === original) continue;
        candidate[position] = replacement;
        assert.equal(task.check(candidate.toString('hex')), false);
      }
    }
    for (const malformed of ['', recovered.slice(2), recovered + '00', 'g'.repeat(24)]) {
      assert.equal(task.check(malformed), false);
    }
  }
});
test('symmetric cipher artifacts can be recovered using only their supplied vocabulary and parameters', () => {
  for (let i = 0; i < 12; i++) {
    const cipher = cipherPuzzle(`cipher-instance-${i}`);
    assert.equal(recoverCipher(cipher.public), cipher.answer);
    assert.equal(cipher.public.answer, undefined);
  }
});
test('PGP alone cannot access the garden; the cipher check gates artifacts and restores on resume', async () => {
  const { garden, challenge, ciphertext } = await fixture();
  const entry = await garden.enter(challenge.ticket, ciphertext);
  assert.equal(entry.cipher_verified, false);
  await assert.rejects(garden.artifact(entry.pass, 'echo'), { status: 403 });
  await assert.rejects(garden.solve(entry.pass, 'machine', '00'), { status: 403 });
  await assert.rejects(garden.solve(entry.pass, 'cipher', '0'.repeat(64)), { status: 422 });
  assert.equal((await garden.resume(entry.pass)).cipher_verified, false);
  const response = await garden.solve(entry.pass, 'cipher', recoverCipher(garden.cipher(entry.pass)));
  assert.equal(response.cipher_verified, true); assert.deepEqual(response.completed, []);
  assert.equal((await garden.resume(entry.pass)).cipher_verified, true);
  assert.ok((await garden.artifact(entry.pass, 'echo')).binary.length);
  assert.ok((await garden.receipt(entry.pass)).receipt.observed.includes('offline-symmetric-key-recovery'));
});
test('the signed receipt records checked capabilities and rejects answers from another visit', async () => {
  const { garden, challenge, ciphertext } = await fixture();
  const first = await garden.enter(challenge.ticket, ciphertext);
  const secondChallenge = garden.challenge();
  const secondCipher = await openpgp.encrypt({ message: await openpgp.createMessage({ text: secondChallenge.message }), encryptionKeys: await openpgp.readKey({ armoredKey: garden.publicKey }) });
  const second = await garden.enter(secondChallenge.ticket, secondCipher);
  await garden.solve(first.pass, 'cipher', recoverCipher(garden.cipher(first.pass)));
  await assert.rejects(garden.solve(second.pass, 'cipher', recoverCipher(garden.cipher(first.pass))), { status: 422 });
  await garden.solve(second.pass, 'cipher', recoverCipher(garden.cipher(second.pass)));
  const echo = await garden.artifact(first.pass, 'echo');
  await assert.rejects(garden.solve(second.pass, 'echo', recoverEcho(echo.public, echo.binary)), { status: 422 });
  await garden.solve(first.pass, 'echo', recoverEcho(echo.public, echo.binary));
  await assert.rejects(garden.solve(second.pass, 'machine', wakeMachine((await garden.artifact(first.pass, 'machine')).public)), { status: 422 });
  await garden.solve(first.pass, 'machine', wakeMachine((await garden.artifact(first.pass, 'machine')).public));
  await garden.solve(first.pass, 'lattice', traverseLattice((await garden.artifact(first.pass, 'lattice')).public));
  const result = await garden.receipt(first.pass);
  assert.equal(result.receipt.completed.length, 3); assert.equal(result.receipt.identity_claim, null);
  const verified = await openpgp.verify({ message: await openpgp.createMessage({ text: result.signed_text }), signature: await openpgp.readSignature({ armoredSignature: result.signature }), verificationKeys: await openpgp.readKey({ armoredKey: result.public_key }) });
  await verified.signatures[0].verified;
  assert.equal((await garden.resume(first.pass)).completed.length, 3);
  await assert.rejects(garden.resume(first.pass.slice(0, -3) + 'xxx'), { status: 401 });
});
test('fixed-window limits stop repeated requests', async () => {
  const { garden } = await fixture(); for (let i = 0; i < 20; i++) await garden.limit('visitor-fixture', 'challenge');
  await assert.rejects(garden.limit('visitor-fixture', 'challenge'), { status: 429 });
});
test('HTTP rejects malformed envelopes, large submissions, wrong methods, and foreign origins', async () => {
  const { garden } = await fixture(); globalThis.__gardenPreview = garden;
  async function request(overrides = {}) {
    const req = { url: '/api/garden?action=enter', method: 'POST', headers: { host: 'garden.local', 'content-type': 'application/json' }, socket: { remoteAddress: 'http-fixture' }, body: {}, ...overrides };
    let output; const res = { setHeader() {}, end(value) { output = JSON.parse(value); } };
    await handler(req, res); return { status: res.statusCode, output };
  }
  try {
    for (const body of [null, [], '{invalid']) assert.equal((await request({ body })).status, 400);
    assert.equal((await request({ body: { message: 'x'.repeat(21000) } })).status, 413);
    assert.equal((await request({ method: 'GET' })).status, 405);
    assert.equal((await request({ headers: { host: 'garden.local', origin: 'https://elsewhere.example', 'content-type': 'application/json' } })).status, 403);
    assert.equal((await request({ headers: { host: 'garden.local', 'content-type': 'text/plain' } })).status, 415);
  } finally { delete globalThis.__gardenPreview; }
});
