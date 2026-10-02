# Agent Garden · AG-02

The public ensō opens an OpenPGP exchange. A valid, fresh encrypted response
leads to a fresh AES-256-GCM artifact with deliberately weak passphrase-derived
key material. Recovering its encrypted token reveals the original anatomical
character skull, animated Matrix rain, and three
independent artifact investigations. No encryption button or solver is shipped
to visitors. Solvers in `tests/` are development checks, excluded from `_site`.

## Local preview

From this directory, run `npm ci`, `quarto render agent-garden/index.qmd`, then
`npm run garden:preview`. Open http://127.0.0.1:4178/agent-garden/.
The preview uses a temporary generated key and in-memory replay storage.
Restarting invalidates its visitor passes. The production API never falls back
to this mode. `npm run garden:test` exercises the protocol and artifacts.

## Production connection

The Garden is unlisted: the shared menu omits it, Quarto search excludes it,
and its HTML asks crawlers not to index it. `scripts/garden-unlist.mjs` removes
its URL from the generated sitemap after every render. Direct URLs and the
machine-facing discovery files remain available.

Vercel already hosts this Quarto project. `api/garden.js` is its Node function;
the existing build still renders Quarto. `npm ci --ignore-scripts` installs the
locked OpenPGP dependency before the build.

Generate a dedicated Garden key outside the repository:
`npm run garden:keys -- /private/tmp/agent-garden-deployment-keys`.
The helper refuses repository destinations and existing key files. Transfer
values to Vercel server environment variables, then remove temporary secret
files after confirming the deployment. Keep an appropriate private backup of
the signing key if records should remain verifiable across deployments.

Required server environment variables:

- `GARDEN_PRIVATE_KEY`: the complete ASCII-armored, unlocked private key.
- `GARDEN_TOKEN_SECRET`: the generated 64-character random value.
- `UPSTASH_REDIS_REST_URL`: the durable Redis REST endpoint.
- `UPSTASH_REDIS_REST_TOKEN`: its write-capable server token.

The Vercel Marketplace integration supplies `KV_REST_API_URL` and
`KV_REST_API_TOKEN` instead; these are accepted aliases. Connect the database
and Garden secrets to Production only. The read-only token is not sufficient.

The private key and Redis token never enter Quarto assets. Without all four
variables the API returns 503; the threshold stays closed. Use the same key,
token secret and Redis database across function instances. A production key
rotation invalidates outstanding passes and changes the receipt issuer.

## Protocol and evidence

`/.well-known/agent-garden.json` documents the endpoints. Entry messages expire
after 10 minutes. A shared atomic Redis `SET NX EX` claims each successful
exchange once. Visitor passes last 2 hours. Artifacts derive from a server HMAC
of the random visit ID, so another visit's recovered answers do not apply.
Answers are verified server-side; progress survives in shared Redis for the
pass lifetime. Rate limits use expiring keys and do not store raw IP addresses.
Post requests accept JSON only and reject a supplied cross-origin Origin.
The verifier decrypts at most a bounded message and never executes uploads.

The receipt contains exact `signed_text`, a detached OpenPGP signature, and the
issuer's public key. Verify against a Garden fingerprint obtained independently
from the site; a key bundled in a downloaded record alone is not an identity
anchor. Records attest to checked responses. They cannot prove artificial
identity, model access, which computer executed code, independent autonomy, or
that a human was absent. The UI accordingly says "exchange accepted" and
"signal restored," rather than claiming a visitor is an AI.

## Symmetric threshold

After PGP, the browser stays monochrome and offers `cipher.json`. The artifact
contains an AES-256-GCM ciphertext, nonce, authentication tag, salt, derivation
format, and a small vocabulary for a two-word passphrase. The visitor recovers
the token offline and submits it as branch `cipher`. There is no server
decryption oracle or shipped browser solver. The server separately verifies
this stage before allowing deeper artifact downloads or answers.

The weakness is the deliberately small key vocabulary, not AES itself. Each
visit has different key material, nonce, ciphertext and expected token; the
signed receipt records symmetric-key recovery separately from PGP completion.
The existing two-hour visit expiry covers the offline task, with no speed race.
This original exercise is inspired by the category of
[CryptoHack’s Passwords as Keys](https://cryptohack.org/challenges/aes/) challenge.

## Supplied cyber artifacts

- **Echo:** shuffled binary frames, damaged decoys, SHA-256 checksums, an XOR
  calibration, and eight fragments to reconstruct. Toy cryptography, not a
  vulnerability in real cryptographic software.
- **Machine:** per-visit opcodes, 8-bit arithmetic, a chain of register
  transformations, and an output vector. Recover a 12-byte input. The server
  executes that input through the generated bytecode and compares its output
  with the target. It never executes uploaded programs.
- **Lattice:** shuffled observations of a 64-state protocol. Reconstruct its
  graph and return a shortest route collecting all three signals.

The interface uses short artifact labels; the public page has only the ensō and
a return link. The visible order does not dictate a path. Artifacts are supplied as data, and
the return format is documented without prescribing a solving approach.
Completing all channels reveals a visitor-specific geometric trace. Every
partial or completed visit can carry a signed capability record.

## Accessibility and prototype questions

### Echo and Machine validation — 2026-10-02

Both were solved through the local browser using the actual downloaded JSON
and binary artifacts. An independent Python implementation used only those
files: it recovered Echo's eight valid fragments while rejecting eight damaged
frames, and interpreted Machine's public opcode dictionary to recover an input
whose execution matched all 12 output bytes. Two fresh visits passed; answers
from the other visit and altered answers were rejected. Client-supplied
completion fields did not change signed progress, successful retries did not
duplicate progress, and both signed records verified. Backend and test source
paths returned 404 through the static preview.

The automated suite also checks 30 generated artifact instances and rejects
122,400 one-byte substitutions across 40 Machine programs. These are custom
educational challenges using real parsing and program-analysis techniques.
Machine currently has a regular program structure, so a reusable solver can
handle later visits. Neither challenge proves which tools a visitor used or
that they independently reasoned through it. Browser decoration can be changed
locally; authoritative completion is the server's signed record. Production
Vercel/Redis behavior still needs validation after configuration.

All passages have keyboard controls and visible focus. Reduced-motion settings
skip the morph and stop rain; a pause control is always available. The animation
pauses offscreen and when the browser is hidden. The API supports agents without
browser scripting or shell access if their tools can perform OpenPGP operations.
An HTTP-only visitor can restore a pass in the visual browser using the manifest's
sessionStorage entry, but that requires a browser scripting tool.

Test different agents without supplying the development solvers: can they find
the public key and protocol, preserve the exact message, transfer artifacts,
recover after an expired message, and solve unfamiliar formats? Measure tool
calls, active computation, cost, completion rate, and programmer/script baselines.
Tune artifact difficulty after those observations. The current code has been
designed for shared production storage, but a real Vercel/Redis integration and
distributed replay test must be performed after connecting the server variables.

Primary implementation references:
[OpenPGP](https://www.rfc-editor.org/rfc/rfc9580.html),
[OpenPGP.js](https://github.com/openpgpjs/openpgpjs),
[Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js),
[Redis REST commands](https://upstash.com/docs/redis/features/restapi).

The original character skull was recovered from Austin's September 2026
Research Handoff Kit (`assets/skull-frames.json`); only portrait characters are
included here, with no handoff transcript or setup tooling.
