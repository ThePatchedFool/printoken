// Momir Basic — pick a mana value, get a random English creature from Scryfall,
// dither it for thermal printing. Double-faced cards print both sides.

(function () {
  const MIN_CMC = 0;
  const MAX_CMC = 16;
  const SCRYFALL_RANDOM = 'https://api.scryfall.com/cards/random';

  // ── DOM ───────────────────────────────────────────────────────────────────
  const cmcVal    = document.getElementById('momir-cmc-val');
  const decBtn    = document.getElementById('momir-dec');
  const incBtn    = document.getElementById('momir-inc');
  const rollBtn   = document.getElementById('momir-roll');
  const rerollBtn = document.getElementById('momir-reroll');
  const statusEl  = document.getElementById('momir-status');
  const previewEl = document.getElementById('momir-preview');
  const cardNameEl = document.getElementById('momir-card-name');
  const canvasesEl = document.getElementById('momir-canvases');

  const paperSel    = previewEl.querySelector('select[name=momir-paper]');
  const dpiSel      = previewEl.querySelector('select[name=momir-dpi]');
  const algoSel     = previewEl.querySelector('select[name=momir-algo]');
  const densityInput = previewEl.querySelector('input[name=momir-density]');
  const sharpenInput = previewEl.querySelector('input[name=momir-sharpen]');
  const densityOut  = document.getElementById('momir-density-out');

  // ── State ─────────────────────────────────────────────────────────────────
  let cmc = 0;
  // [{ canvas: HTMLCanvasElement, img: HTMLImageElement, name: string }]
  let currentFaces = [];

  // ── CMC picker ────────────────────────────────────────────────────────────
  function updateCmc() {
    cmcVal.textContent = cmc;
    decBtn.disabled = cmc <= MIN_CMC;
    incBtn.disabled = cmc >= MAX_CMC;
  }
  decBtn.addEventListener('click', () => { cmc = Math.max(MIN_CMC, cmc - 1); updateCmc(); });
  incBtn.addEventListener('click', () => { cmc = Math.min(MAX_CMC, cmc + 1); updateCmc(); });
  updateCmc();

  // ── Output settings ───────────────────────────────────────────────────────
  paperSel.addEventListener('change', repaintAll);
  dpiSel.addEventListener('change', repaintAll);
  algoSel.addEventListener('change', repaintAll);
  sharpenInput.addEventListener('change', repaintAll);
  densityInput.addEventListener('input', () => {
    densityOut.textContent = densityInput.value;
    repaintAll();
  });

  // ── Roll ──────────────────────────────────────────────────────────────────
  rollBtn.addEventListener('click', doRoll);
  rerollBtn.addEventListener('click', doRoll);

  async function doRoll() {
    setLoading(true);
    statusEl.textContent = `Rolling CMC ${cmc}…`;

    // English paper creatures only; exclude token cards.
    const q = `type:creature cmc=${cmc} game:paper lang:en -t:token`;
    const url = `${SCRYFALL_RANDOM}?q=${encodeURIComponent(q)}`;

    let card;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 404) {
        statusEl.textContent = `No English creatures found at mana value ${cmc}.`;
        setLoading(false);
        return;
      }
      if (!r.ok) throw new Error(`Scryfall HTTP ${r.status}`);
      card = await r.json();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      setLoading(false);
      return;
    }

    // Resolve faces — DFCs have per-face image_uris; single-faced cards don't.
    const faces = facesOf(card);

    // Load all face images in parallel.
    const settled = await Promise.allSettled(
      faces.map(face => {
        const imgUrl = face.image_uris?.png
                    || face.image_uris?.large
                    || face.image_uris?.normal;
        return imgUrl ? loadCorsImage(imgUrl) : Promise.reject(new Error('no image'));
      })
    );

    currentFaces = faces
      .map((face, i) => ({
        name: face.name || card.name,
        img: settled[i].status === 'fulfilled' ? settled[i].value : null,
      }))
      .filter(f => f.img);

    if (!currentFaces.length) {
      statusEl.textContent = 'Could not load card image.';
      setLoading(false);
      return;
    }

    cardNameEl.textContent = card.name;
    buildCanvases();
    repaintAll();

    previewEl.hidden = false;
    statusEl.textContent = '';
    setLoading(false);
  }

  // ── Canvas management ─────────────────────────────────────────────────────
  function buildCanvases() {
    canvasesEl.innerHTML = '';
    const multiface = currentFaces.length > 1;

    for (const face of currentFaces) {
      const wrap = document.createElement('div');
      wrap.className = 'momir-face';

      if (multiface) {
        const label = document.createElement('p');
        label.className = 'momir-face-label';
        label.textContent = face.name;
        wrap.appendChild(label);
      }

      const canvas = document.createElement('canvas');
      canvas.className = 'momir-canvas';
      canvas.setAttribute('aria-label', `${face.name} card preview`);
      face.canvas = canvas;
      wrap.appendChild(canvas);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save image';
      saveBtn.addEventListener('click', () => {
        window.Printoken.shareCanvas(canvas, face.name);
      });
      wrap.appendChild(saveBtn);

      canvasesEl.appendChild(wrap);
    }
  }

  function repaintAll() {
    for (const face of currentFaces) {
      if (face.canvas) repaintCanvas(face.canvas, face.img);
    }
  }

  function repaintCanvas(canvas, img) {
    if (!img) return;
    const paperMm = window.Printoken.PAPER_MM[paperSel.value] ?? 53;
    const dpi     = parseInt(dpiSel.value, 10) || 203;
    const widthPx = Math.round((paperMm / 25.4) * dpi);
    const aspect  = img.height / img.width;
    const heightPx = Math.round(widthPx * aspect);

    canvas.width  = widthPx;
    canvas.height = heightPx;
    canvas.style.width = `min(100%, ${paperMm * 4}px)`;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);

    const data = ctx.getImageData(0, 0, widthPx, heightPx);
    const density   = parseInt(densityInput.value, 10);
    const threshold = Math.round(200 - density * 1.44);
    window.Printoken.ditherImage(data, {
      algorithm: algoSel.value,
      threshold,
      sharpen: sharpenInput.checked,
    });
    ctx.putImageData(data, 0, 0);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Returns an array of face objects. DFCs where every face has its own
  // image_uris are split; everything else is treated as a single face.
  function facesOf(card) {
    if (Array.isArray(card.card_faces)
        && card.card_faces.length > 1
        && card.card_faces.every(f => f.image_uris)) {
      return card.card_faces;
    }
    return [card];
  }

  function loadCorsImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
  }

  function setLoading(loading) {
    rollBtn.disabled   = loading;
    rerollBtn.disabled = loading;
    rollBtn.textContent = loading ? '…' : 'Roll';
  }
})();
