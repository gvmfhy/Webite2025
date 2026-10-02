(() => {
  'use strict';
  if (!document.getElementById('agent-garden')) return;
  const $ = id => document.getElementById(id);
  const storage = 'agent-garden-pass-v2';
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let challenge, cipherArtifact, pass, currentBranch, currentArtifact, visitor, completed = [], scene;

  async function api(action, { body, branch, raw = false, auth = true } = {}) {
    const query = new URLSearchParams({ action }); if (branch) query.set('branch', branch);
    const response = await fetch(`/api/garden?${query}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && pass ? { Authorization: `Bearer ${pass}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      let reason = 'The archive did not respond.';
      try { reason = (await response.json()).error || reason; } catch { /* Non-JSON host errors. */ }
      throw new Error(reason);
    }
    return raw ? response.blob() : response.json();
  }
  function download(name, content, type = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function status(id, error) { $(id).textContent = error.message || 'Request failed. Try again.'; }
  function remember(value) { try { value ? sessionStorage.setItem(storage, value) : sessionStorage.removeItem(storage); } catch { /* A visit works without storage. */ } }

  async function newChallenge() {
    challenge = undefined; $('threshold-status').textContent = ''; $('challenge-message').textContent = 'Loading…';
    $('download-challenge').disabled = true; $('return-seal').disabled = true; $('sealed-message').value = '';
    try {
      challenge = await api('challenge', { auth: false });
      $('challenge-message').textContent = challenge.message;
      $('key-fingerprint').textContent = `FINGERPRINT / ${challenge.fingerprint.toUpperCase().match(/.{1,4}/g).join(' ')}`;
      $('download-challenge').disabled = false; $('return-seal').disabled = false;
    } catch (error) { status('threshold-status', error); }
  }
  function envelope(open) {
    $('envelope').hidden = !open; $('open-envelope').setAttribute('aria-expanded', String(open));
    if (open) { if (!challenge) newChallenge(); $('envelope').scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth', block: 'center' }); }
    else $('open-envelope').focus();
  }
  function updateChannels() {
    document.querySelectorAll('[data-branch]').forEach(button => {
      const done = completed.includes(button.dataset.branch); button.classList.toggle('is-resolved', done);
      button.querySelector('.channel-state').textContent = done ? '✓' : '↗';
    });
    const remaining = 3 - completed.length;
    $('channel-count').textContent = `${completed.length} / 3`;
    $('receipt-caption').textContent = `${completed.length} / 3`;
    $('transmission').hidden = remaining !== 0;
    if (!remaining) drawSigil();
  }
  function drawSigil() {
    const canvas = $('visitor-sigil'), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bytes = visitor.match(/../g).map(b => parseInt(b, 16));
    ctx.strokeStyle = '#97f4b0'; ctx.lineWidth = .7; ctx.shadowColor = '#55ee8a'; ctx.shadowBlur = 7;
    for (let orbit = 0; orbit < 3; orbit++) {
      ctx.beginPath();
      for (let i = 0; i <= 180; i++) {
        const t = i / 180 * Math.PI * 2, radius = 40 + orbit * 12 + 11 * Math.sin(t * (3 + bytes[orbit] % 5) + bytes[orbit + 3]);
        const x = 210 + Math.cos(t) * radius * 1.7, y = 90 + Math.sin(t) * radius;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    $('transmission-id').textContent = `VISITOR / ${visitor.toUpperCase()}`;
  }
  async function showCipher(result) {
    visitor = result.visitor; completed = result.completed;
    $('envelope').hidden = true; $('open-envelope').hidden = true; $('cipher-envelope').hidden = false;
    $('cipher-status').textContent = ''; $('return-cipher').disabled = true; $('download-cipher').disabled = true;
    $('cipher-ciphertext').textContent = 'Loading…';
    try {
      cipherArtifact = await api('cipher');
      $('cipher-ciphertext').textContent = cipherArtifact.ciphertext;
      $('cipher-record').textContent = JSON.stringify(cipherArtifact, null, 2);
      $('return-cipher').disabled = false; $('download-cipher').disabled = false;
      $('cipher-envelope').scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth', block: 'center' });
    } catch (error) { status('cipher-status', error); }
  }
  async function awaken(result, fresh = true) {
    visitor = result.visitor; completed = result.completed;
    document.body.classList.add('garden-awakening');
    if (fresh && !motion.matches) await new Promise(resolve => setTimeout(resolve, 1100));
    $('threshold').hidden = true; $('understory').hidden = false; document.body.classList.add('garden-awake');
    $('visitor-id').textContent = `VISITOR / ${visitor.toUpperCase()}`; updateChannels();
    window.scrollTo({ top: 0, behavior: 'instant' }); $('understory-title').focus({ preventScroll: true });
    if (scene) scene.destroy();
    try { scene = await matrixScene(fresh); } catch { $('channel-count').textContent = 'Animation unavailable'; }
  }
  async function openChamber(branch) {
    currentBranch = branch; currentArtifact = undefined;
    document.querySelectorAll('[data-branch]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.branch === branch)));
    $('chamber').hidden = false; $('chamber-code').textContent = `CHANNEL / ${branch.toUpperCase()}`;
    $('chamber-title').textContent = 'Loading…';
    $('chamber-status').textContent = ''; $('artifact-record').textContent = ''; $('channel-answer').value = '';
    $('download-artifact').disabled = true; $('download-recording').hidden = true; $('answer-form').hidden = true;
    $('chamber').scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth', block: 'start' });
    try {
      const artifact = await api('puzzle', { branch });
      if (currentBranch !== branch) return;
      currentArtifact = artifact; $('chamber-title').textContent = artifact.name;
      $('artifact-record').textContent = JSON.stringify(artifact, null, 2);
      $('answer-label').textContent = artifact.return; $('answer-form').hidden = false;
      $('download-artifact').disabled = false; $('download-recording').hidden = branch !== 'echo';
      $('chamber-title').focus({ preventScroll: true });
    } catch (error) { if (currentBranch === branch) { $('chamber-title').textContent = 'Unavailable'; status('chamber-status', error); } }
  }

  // A cached character portrait preserves the original handoff artwork. During
  // awakening its glyphs move from an open circle into the anatomical structure.
  async function matrixScene(fresh) {
    const response = await fetch('/assets/garden/skull.json'); if (!response.ok) throw new Error('Portrait unavailable');
    const skull = await response.json(), canvas = $('matrix'), ctx = canvas.getContext('2d');
    const cache = document.createElement('canvas'), portrait = cache.getContext('2d');
    const glyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:|', density = '.,:;irsXA253hMHGS#9B&@';
    const points = []; skull.lines.forEach((row, y) => [...row].forEach((char, x) => { if (char !== ' ') points.push({ x, y, char, shade: Math.max(0, density.indexOf(char)), seed: (x * 37 + y * 83) % 997 / 997 }); }));
    let width, height, font, left, top, streams, raf, last = 0, visible = true, destroyed = false;
    let paused = motion.matches, elapsed = 0;
    function fit() {
      const box = canvas.getBoundingClientRect(); width = box.width; height = box.height;
      const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cache.width = width * dpr; cache.height = height * dpr; portrait.setTransform(dpr, 0, 0, dpr, 0, 0);
      const small = width < 740;
      const skullWidth = small ? Math.min(width * .88, 360) : Math.min(width * .53, 540);
      font = skullWidth / (skull.width * .61);
      left = (width - skullWidth) / 2;
      top = small ? 65 : (height - skull.height * font * .96) / 2;
      portrait.font = `${font}px monospace`;
      for (const p of points) {
        const light = .2 + p.shade / density.length * .7;
        portrait.fillStyle = `rgba(110,245,153,${light})`;
        portrait.fillText(p.char, left + p.x * font * .61, top + p.y * font * .96);
      }
      streams = Array.from({ length: Math.ceil(width / 18) }, (_, i) => ({ x: i * 18, y: Math.random() * height, speed: .5 + Math.random() * .8, length: 4 + Math.floor(Math.random() * 12) }));
      render(performance.now(), true);
    }
    function render(time, force = false) {
      if (destroyed) return;
      if (!force && time - last < 33) { schedule(); return; }
      const delta = last ? Math.min(100, time - last) : 33; last = time;
      if (!paused && visible && !document.hidden) elapsed += delta;
      const morph = !fresh || motion.matches || paused ? 1 : Math.min(1, elapsed / 3700);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '10px monospace';
      for (let i = 0; i < streams.length; i++) {
        const stream = streams[i]; if (!paused) stream.y = (stream.y + delta * .025 * stream.speed) % (height + 230);
        for (let j = 0; j < stream.length; j++) {
          ctx.fillStyle = j === 0 ? 'rgba(157,255,186,.35)' : `rgba(75,173,103,${.15 * (1 - j / stream.length)})`;
          const index = (i * 13 + j * 7 + Math.floor(elapsed / 550)) % glyphs.length;
          ctx.fillText(glyphs[index], stream.x, stream.y - j * 13);
        }
      }
      if (morph < 1) {
        const eased = 1 - Math.pow(1 - morph, 3), cx = width / 2, cy = height * .43;
        ctx.font = `${font}px monospace`;
        for (const p of points) {
          const angle = .5 + p.seed * Math.PI * 1.82, radius = Math.min(width * .2, 150) + Math.sin(p.seed * 81) * 8;
          const sx = cx + Math.cos(angle) * radius, sy = cy + Math.sin(angle) * radius;
          const tx = left + p.x * font * .61, ty = top + p.y * font * .96;
          ctx.fillStyle = `rgba(110,245,153,${(.08 + p.shade / density.length * .68) * Math.min(1, morph * 2)})`;
          ctx.fillText(p.char, sx + (tx - sx) * eased, sy + (ty - sy) * eased);
        }
      } else { ctx.globalAlpha = .88 + Math.sin(elapsed / 3000) * .08; ctx.drawImage(cache, 0, 0, width, height); ctx.globalAlpha = 1; }
      // Falling threads emerge beneath the teeth rather than covering the face.
      const jaw = top + skull.height * font * .96;
      ctx.font = '10px monospace';
      for (let column = 0; column < 11; column++) {
        const x = left + (skull.width * font * .61) * (.29 + column * .036);
        for (let j = 0; j < 6; j++) {
          const y = jaw + 10 + ((elapsed * .03 + column * 23 + j * 14) % 140);
          ctx.fillStyle = `rgba(100,235,145,${Math.max(0, .4 - (y - jaw) / 350)})`;
          ctx.fillText(glyphs[(column * 5 + j + Math.floor(elapsed / 800)) % glyphs.length], x, y);
        }
      }
      if (!force) schedule();
    }
    function schedule() { if (!destroyed && !paused && visible && !document.hidden) raf = requestAnimationFrame(render); }
    function visibility() { cancelAnimationFrame(raf); if (!document.hidden) { last = 0; schedule(); } }
    const resize = new ResizeObserver(fit); resize.observe(canvas);
    const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; cancelAnimationFrame(raf); if (visible) { last = 0; schedule(); } }); intersection.observe(canvas);
    document.addEventListener('visibilitychange', visibility);
    fit(); schedule();
    return {
      pause(value) { paused = value; cancelAnimationFrame(raf); render(performance.now(), true); if (!paused) { last = 0; schedule(); } },
      destroy() { destroyed = true; cancelAnimationFrame(raf); resize.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', visibility); }
    };
  }

  $('open-envelope').addEventListener('click', () => envelope($('envelope').hidden));
  $('view-public-key').addEventListener('click', async () => {
    const open = $('public-key-panel').hidden;
    $('public-key-panel').hidden = !open; $('view-public-key').setAttribute('aria-expanded', String(open));
    if (!open) return;
    $('public-key-text').textContent = 'Loading…';
    try { $('public-key-text').textContent = await (await api('key', { raw: true, auth: false })).text(); }
    catch (error) { status('public-key-text', error); }
  });
  $('close-envelope').addEventListener('click', () => envelope(false));
  $('refresh-challenge').addEventListener('click', newChallenge);
  $('download-challenge').addEventListener('click', () => { if (challenge) download('threshold-message.txt', challenge.message, 'text/plain'); });
  $('seal-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!challenge) return;
    $('return-seal').disabled = true; $('threshold-status').textContent = 'Checking…';
    try {
      const result = await api('enter', { auth: false, body: { ticket: challenge.ticket, message: $('sealed-message').value.trim() } });
      pass = result.pass; remember(pass); await showCipher(result);
    } catch (error) { status('threshold-status', error); } finally { $('return-seal').disabled = false; }
  });
  $('download-cipher').addEventListener('click', () => { if (cipherArtifact) download('cipher.json', cipherArtifact); });
  $('cipher-form').addEventListener('submit', async event => {
    event.preventDefault(); $('return-cipher').disabled = true; $('cipher-status').textContent = 'Checking…';
    try {
      const result = await api('solve', { body: { branch: 'cipher', answer: $('cipher-answer').value } });
      await awaken(result);
    } catch (error) { status('cipher-status', error); } finally { $('return-cipher').disabled = false; }
  });
  $('restart-entry').addEventListener('click', () => { remember(); location.reload(); });
  document.querySelectorAll('[data-branch]').forEach(button => button.addEventListener('click', () => openChamber(button.dataset.branch)));
  $('close-chamber').addEventListener('click', () => { $('chamber').hidden = true; const old = currentBranch; currentBranch = undefined; const button = document.querySelector(`[data-branch="${old}"]`); button?.setAttribute('aria-expanded', 'false'); button?.focus(); });
  $('download-artifact').addEventListener('click', () => { if (currentArtifact) download(`${currentBranch}.json`, currentArtifact); });
  $('download-recording').addEventListener('click', async () => { try { download('echo.bin', await api('artifact', { branch: 'echo', raw: true })); } catch (error) { status('chamber-status', error); } });
  $('answer-form').addEventListener('submit', async event => {
    event.preventDefault(); const branch = currentBranch; if (!branch) return;
    const button = event.submitter; button.disabled = true; $('chamber-status').textContent = 'Checking…';
    try {
      const result = await api('solve', { body: { branch, answer: $('channel-answer').value } }); completed = result.completed; updateChannels();
      if (currentBranch === branch) $('chamber-status').textContent = 'Accepted.';
    } catch (error) { if (currentBranch === branch) status('chamber-status', error); } finally { button.disabled = false; }
  });
  $('download-receipt').addEventListener('click', async () => { try { download('garden-signed-record.json', await api('receipt')); } catch (error) { $('receipt-caption').textContent = error.message; } });
  $('motion-toggle').setAttribute('aria-pressed', String(motion.matches)); $('motion-toggle').textContent = motion.matches ? 'Resume motion' : 'Pause motion';
  $('motion-toggle').addEventListener('click', () => { const paused = $('motion-toggle').getAttribute('aria-pressed') !== 'true'; $('motion-toggle').setAttribute('aria-pressed', String(paused)); $('motion-toggle').textContent = paused ? 'Resume motion' : 'Pause motion'; scene?.pause(paused); });
  motion.addEventListener('change', event => { scene?.pause(event.matches); $('motion-toggle').setAttribute('aria-pressed', String(event.matches)); $('motion-toggle').textContent = event.matches ? 'Resume motion' : 'Pause motion'; });
  $('leave-garden').addEventListener('click', () => { remember(); location.reload(); });
  try { pass = sessionStorage.getItem(storage); } catch { /* Storage unavailable. */ }
  if (pass) api('resume').then(result => result.cipher_verified ? awaken(result, false) : showCipher(result)).catch(() => { pass = undefined; remember(); });
})();
