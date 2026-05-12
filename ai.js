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

  // Per-style prompt prefixes — each tuned for B&W thermal output.
  const ART_STYLES = {
    woodcut:    'black and white woodcut print, bold relief lines, high contrast',
    cartoon:    'black and white cartoon, thick outlines, simple bold shapes, comic strip style',
    fantasy:    'black and white fantasy pen and ink, fine crosshatching, detailed, Tolkien style',
    engraving:  'black and white copper engraving, fine parallel lines, Victorian natural history style',
    ukiyoe:     'black and white Japanese ukiyo-e woodblock print, flowing lines, flat shapes, Hokusai style',
    sketch:     'black and white pencil sketch, rough graphite lines, loose hand-drawn, expressive',
    silhouette: 'pure black silhouette on white, no interior detail, stark flat shape',
    stick:      'crude stick figure drawing, simple black lines, childlike, deliberately naive',
  };
  const STYLE_SUFFIX = 'no grey tones, suitable for thermal printing, fantasy card art';

  // ── Prompt builder ────────────────────────────────────────────────────────
  // Returns { prompt, fields } — prompt is the assembled fal.ai string,
  // fields are the raw inputs sent to the Worker for logging.
  function buildPrompt() {
    const form = document.getElementById('form');
    const fallback = { prompt: ART_STYLES.woodcut + ', ' + STYLE_SUFFIX, fields: {} };
    if (!form) return fallback;
    const fd = new FormData(form);

    const styleKey    = (fd.get('ai-style') || 'woodcut').toString();
    const stylePrefix = ART_STYLES[styleKey] || ART_STYLES.woodcut;
    const name        = (fd.get('name')    || '').toString().trim();
    const userDesc    = (fd.get('ai-desc') || '').toString().trim();

    let types = [], subtypes = [];
    try { types    = JSON.parse(fd.get('types')    || '[]'); } catch {}
    try { subtypes = JSON.parse(fd.get('subtypes') || '[]'); } catch {}

    const colors = fd.getAll('color').map(String);

    const parts = [];
    if (name)            parts.push(name);
    if (types.length)    parts.push(types.join(' ').toLowerCase());
    if (subtypes.length) parts.push(subtypes.join(' ').toLowerCase());

    const moods = colors.map(c => COLOR_MOOD[c]).filter(Boolean);
    if (moods.length)    parts.push(moods.join(', '));
    if (userDesc)        parts.push(userDesc);

    const subject = parts.length ? parts.join(', ') : '';
    const prompt = subject
      ? `${stylePrefix}, ${subject}, ${STYLE_SUFFIX}`
      : `${stylePrefix}, ${STYLE_SUFFIX}`;

    return {
      prompt,
      fields: {
        style:       styleKey,
        name,
        types:       types.join(', '),
        subtypes:    subtypes.join(', '),
        colors:      colors.join(', '),
        description: userDesc,
      },
    };
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

  // ── Generate ──────────────────────────────────────────────────────────────
  async function generate() {
    if (WORKER_URL.includes('YOUR_SUBDOMAIN')) {
      setStatus('Worker not configured yet — set WORKER_URL in ai.js after deploying.', true);
      return;
    }

    setLoading(true);
    setStatus('Generating…');

    try {
      const { prompt, fields } = buildPrompt();

      const resp = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...fields }),
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

  // Enter in the description field triggers Generate (no multi-line needed).
  const descTextarea = document.querySelector('textarea[name=ai-desc]');
  if (descTextarea) {
    descTextarea.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); generate(); }
    });
  }

  // Exposed for console debugging.
  window.Printoken.ai = { generate, buildPrompt };
})();
