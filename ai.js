// AI art generation for the Create page.
//
// Builds a prompt from the current form state, obtains a Cloudflare Turnstile
// token (invisible — no user puzzle for legitimate users), then POSTs to the
// Cloudflare Worker which proxies fal.ai Flux Schnell.
//
// Setup checklist:
//   1. Replace WORKER_URL below with your deployed Worker URL.
//   2. Replace the data-sitekey in create.html with your Turnstile site key.
//   3. `wrangler secret put FAL_KEY` and `wrangler secret put TURNSTILE_SECRET`

(function () {
  // ── Config ────────────────────────────────────────────────────────────────
  // After `cd worker && npm run deploy`, replace this with the printed URL.
  const WORKER_URL = 'https://printoken-ai.thepatchedfool.workers.dev';

  // ── Colour → evocative mood ───────────────────────────────────────────────
  const COLOR_MOOD = {
    W: 'divine, radiant, holy',
    U: 'arcane, ethereal, mystical',
    B: 'dark, shadowy, sinister',
    R: 'fiery, wild, explosive',
    G: 'natural, verdant, primal',
    C: 'mechanical, metallic, constructed',
  };

  // Style prefix baked into every prompt — optimised for Flux Schnell + B&W thermal.
  const STYLE_PREFIX = [
    'black and white ink illustration',
    'woodcut style',
    'high contrast',
    'bold line art',
    'fantasy card art',
    'no grey tones',
    'suitable for thermal printing',
  ].join(', ');

  // ── Prompt builder ────────────────────────────────────────────────────────
  function buildPrompt() {
    const form = document.getElementById('form');
    if (!form) return STYLE_PREFIX;
    const fd = new FormData(form);

    const name     = (fd.get('name')    || '').toString().trim();
    const userDesc = (fd.get('ai-desc') || '').toString().trim();

    let types = [], subtypes = [];
    try { types    = JSON.parse(fd.get('types')    || '[]'); } catch {}
    try { subtypes = JSON.parse(fd.get('subtypes') || '[]'); } catch {}

    const colors = fd.getAll('color').map(String);

    const parts = [];
    if (name)           parts.push(name);
    if (types.length)   parts.push(types.join(' ').toLowerCase());
    if (subtypes.length) parts.push(subtypes.join(' ').toLowerCase());

    const moods = colors.map(c => COLOR_MOOD[c]).filter(Boolean);
    if (moods.length)   parts.push(moods.join(', '));
    if (userDesc)       parts.push(userDesc);

    return parts.length ? `${STYLE_PREFIX}, ${parts.join(', ')}` : STYLE_PREFIX;
  }

  // ── UI elements ───────────────────────────────────────────────────────────
  const generateBtn = document.getElementById('ai-generate');
  const regenBtn    = document.getElementById('ai-regenerate');
  const statusEl    = document.getElementById('ai-status');
  const fileInput   = document.querySelector('input[name=art]');

  if (!generateBtn) return; // guard: not on create page

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
    statusEl.classList.toggle('ai-status--error', !!isError);
  }

  function setLoading(loading) {
    generateBtn.disabled = loading;
    generateBtn.textContent = loading ? '…' : '✦ Generate';
    if (regenBtn) regenBtn.disabled = loading;
  }

  // ── Turnstile ─────────────────────────────────────────────────────────────
  // Token is stored on window._tsToken by an inline script in the HTML
  // so it survives the async/defer race between Turnstile and ai.js.

  // Poll until a token arrives (usually <1 s after reset) or timeout.
  function awaitToken(ms = 6000) {
    if (window._tsToken) return Promise.resolve(window._tsToken);
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const id = setInterval(() => {
        if (window._tsToken) { clearInterval(id); resolve(window._tsToken); }
        else if (Date.now() > deadline) {
          clearInterval(id);
          reject(new Error('Verification timed out — please try again.'));
        }
      }, 100);
    });
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  async function generate() {
    if (WORKER_URL.includes('YOUR_SUBDOMAIN')) {
      setStatus('Worker not configured yet — set WORKER_URL in ai.js after deploying.', true);
      return;
    }

    setLoading(true);
    setStatus('Verifying…');

    try {
      // Consume the current token, then reset the widget so the next call
      // gets a fresh one (tokens are single-use).
      const token = await awaitToken();
      window._tsToken = null;
      if (window.turnstile) window.turnstile.reset('#turnstile-widget');

      setStatus('Generating…');
      const prompt = buildPrompt();

      const resp = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, turnstileToken: token }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const { imageUrl } = await resp.json();
      if (!imageUrl) throw new Error('No image URL in response.');

      setStatus('Loading…');
      const img = await loadImage(imageUrl);

      // Hand off to render.js — clears the hatching and redraws with the art.
      window.Printoken.setArt(img);

      // Clear any uploaded file so the two art sources don't fight.
      if (fileInput) fileInput.value = '';

      setStatus('');
      if (regenBtn) regenBtn.hidden = false;

    } catch (err) {
      console.error('AI generation failed', err);
      setStatus(err.message || 'Generation failed.', true);
    } finally {
      setLoading(false);
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load the generated image.'));
      img.src = url;
    });
  }

  generateBtn.addEventListener('click', generate);
  if (regenBtn) regenBtn.addEventListener('click', generate);

  // Exposed for console debugging.
  window.Printoken.ai = { generate, buildPrompt };
})();
