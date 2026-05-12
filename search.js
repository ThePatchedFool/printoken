// Scryfall search — find a printed token (or any card) and import it
// into the create view's renderer.
//
// API docs: https://scryfall.com/docs/api/cards/search
// Rate limit: ~10 requests/sec, identify with a User-Agent (browsers can't
// set this, but Scryfall is lenient for browser apps).

(function () {
  const form = document.getElementById('search-form');
  const statusEl = document.getElementById('search-status');
  const resultsEl = document.getElementById('search-results');
  if (!form) return; // search view not present

  const SCRYFALL = 'https://api.scryfall.com';
  let lastRequest = 0;

  form.addEventListener('submit', e => {
    e.preventDefault();
    runSearch();
  });

  async function runSearch() {
    const fd = new FormData(form);
    const q = (fd.get('q') || '').toString().trim();
    if (!q) return;
    const tokensOnly = !!fd.get('tokens-only');
    // Whitelist the game-piece types and require helper "Card" cards to have
    // oracle text — that's how we distinguish true helpers (Initiative, Monarch,
    // City's Blessing — all have rules text) from Jumpstart pack art (no text).
    //   t:token   — every printed token
    //   t:emblem  — planeswalker emblems
    //   t:dungeon — Undercity, Tomb of Annihilation, etc.
    //   (t:card o:/./)  — only "Card"-typed pieces with rules text
    // -border:gold drops the World Championship gold-bordered prints.
    // -layout:art_series drops decorative art-only cards.
    const filter = '(t:token OR t:emblem OR t:dungeon OR (t:card o:/./)) -border:gold -layout:art_series -set_type:memorabilia';
    const fullQuery = tokensOnly ? `${q} ${filter}` : q;

    statusEl.textContent = 'Searching…';
    resultsEl.innerHTML = '';

    // Light-touch rate limit: at most 4 req/sec.
    const since = Date.now() - lastRequest;
    if (since < 250) await new Promise(r => setTimeout(r, 250 - since));
    lastRequest = Date.now();

    try {
      const url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(fullQuery)}&unique=art&order=name`;
      const r = await fetch(url);
      if (r.status === 404) {
        statusEl.textContent = 'No matches.';
        return;
      }
      if (!r.ok) throw new Error(`Scryfall HTTP ${r.status}`);
      const json = await r.json();
      const cards = (json.data || []).filter(c => c.image_uris || (c.card_faces && c.card_faces[0]?.image_uris));
      if (!cards.length) { statusEl.textContent = 'No matches.'; return; }
      statusEl.textContent = `${json.total_cards} results — showing ${cards.length}.`;
      paintResults(cards);
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Search failed: ${err.message}`;
    }
  }

  function paintResults(cards) {
    resultsEl.innerHTML = '';
    for (const card of cards) {
      // Multi-face tokens (Incubator/Phyrexian, werewolf day-night, etc.) get
      // one tile per face. Each tile imports/prints just that face.
      const faces = facesOf(card);
      for (const face of faces) {
        const thumb = face.image_uris?.small || face.image_uris?.normal;
        if (!thumb) continue;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'result-tile';
        tile.innerHTML = `
          <img src="${thumb}" alt="${escapeAttr(face.name)}" loading="lazy">
          <span class="result-meta">
            <span class="result-name">${escapeHtml(face.name)}</span>
            <span class="result-set">${escapeHtml(card.set_name || card.set || '')}</span>
          </span>
        `;
        tile.addEventListener('click', () => importFace(card, face));
        resultsEl.appendChild(tile);
      }
    }
  }

  // Normalise a Scryfall card into an array of printable faces. Single-face
  // cards stay as one entry; double-faced tokens emit both faces.
  function facesOf(card) {
    if (Array.isArray(card.card_faces) && card.card_faces.length > 1
        && card.card_faces.every(f => f.image_uris)) {
      return card.card_faces;
    }
    return [card];
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  // ---- Preview pane ----
  const pane = document.getElementById('search-pane');
  const preview = document.getElementById('search-preview');
  const previewName = document.getElementById('search-preview-name');
  const previewCanvas = document.getElementById('search-canvas');
  const backBtn = document.getElementById('search-back');
  const saveBtn = document.getElementById('search-save');
  const paperSel = preview.querySelector('select[name=search-paper]');
  const dpiSel = preview.querySelector('select[name=search-dpi]');
  const algoSel = preview.querySelector('select[name=search-algo]');
  const densityInput = preview.querySelector('input[name=search-density]');
  const sharpenInput = preview.querySelector('input[name=search-sharpen]');
  const densityOut = document.getElementById('search-density-out');

  let currentCard = null;
  let currentImage = null;

  backBtn.addEventListener('click', () => {
    preview.hidden = true;
    pane.hidden = false;
    currentCard = null;
    currentImage = null;
  });

  paperSel.addEventListener('change', repaintPreview);
  dpiSel.addEventListener('change', repaintPreview);
  algoSel.addEventListener('change', repaintPreview);
  sharpenInput.addEventListener('change', repaintPreview);
  densityInput.addEventListener('input', () => {
    densityOut.textContent = densityInput.value;
    repaintPreview();
  });

  saveBtn.addEventListener('click', () => {
    if (!currentImage) return;
    window.Printoken.shareCanvas(previewCanvas, currentCard?.name || 'token');
  });

  // Full-card image from Scryfall → load with CORS → dither → fit to paper width.
  async function importFace(card, face) {
    const name = face.name || card.name;
    statusEl.textContent = `Loading "${name}"…`;
    const imgUrl = face.image_uris?.png || face.image_uris?.large || face.image_uris?.normal;
    if (!imgUrl) { statusEl.textContent = 'No printable image for that card.'; return; }
    try {
      const img = await loadCorsImage(imgUrl);
      currentCard = { ...card, name };
      currentImage = img;
      previewName.textContent = name;
      pane.hidden = true;
      preview.hidden = false;
      statusEl.textContent = '';
      repaintPreview();
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Failed to load image: ${err.message}`;
    }
  }

  function repaintPreview() {
    if (!currentImage) return;
    const paperMm = window.Printoken.PAPER_MM[paperSel.value] ?? 53;
    const dpi = parseInt(dpiSel.value, 10) || 203;
    const widthPx = Math.round((paperMm / 25.4) * dpi);
    const aspect = currentImage.height / currentImage.width;
    const heightPx = Math.round(widthPx * aspect);

    previewCanvas.width = widthPx;
    previewCanvas.height = heightPx;
    // On-screen size reflects paper width — capped to container width.
    previewCanvas.style.width = `min(100%, ${paperMm * 4}px)`;
    const ctx = previewCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(currentImage, 0, 0, widthPx, heightPx);
    const data = ctx.getImageData(0, 0, widthPx, heightPx);

    // Density 0–100 → threshold 200–56 (higher density slider = more black ink).
    const density = parseInt(densityInput.value, 10);
    const threshold = Math.round(200 - density * 1.44);
    window.Printoken.ditherImage(data, {
      algorithm: algoSel.value,
      threshold,
      sharpen: sharpenInput.checked,
    });
    ctx.putImageData(data, 0, 0);
  }

  function loadCorsImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
  }
})();
