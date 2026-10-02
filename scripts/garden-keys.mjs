import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as openpgp from 'openpgp';

// Explicit destination avoids printing secrets or putting them in the site tree.
const destination = process.argv[2];
if (!destination) throw new Error('Supply a private output directory outside this repository.');
const dir = resolve(destination), repository = resolve('.');
if (dir === repository || dir.startsWith(repository + '/')) throw new Error('Keep deployment keys outside the repository.');
await mkdir(dir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Austin Morrissey / Agent Garden' }], format: 'armored' });
await writeFile(resolve(dir, 'garden-private.asc'), privateKey, { mode: 0o600, flag: 'wx' });
await writeFile(resolve(dir, 'garden-public.asc'), publicKey, { mode: 0o644, flag: 'wx' });
await writeFile(resolve(dir, 'garden-token-secret.txt'), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
console.log('Created deployment key files. Upload their values as server environment variables; never commit them.');
