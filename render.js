// Printoken renderer — black & white token cards for thermal printing.
// Aspect target: ~5:7 (close to MTG card). Width derived from paper × DPI.

const PAPER_MM = { '53': 53, '80': 80, 'custom-mtg': 63 };
// Card proportions sourced from the M15 token MSE template (375×523 design units).
const TPL_W = 375;
const TPL_H = 523;
const ASPECT = TPL_H / TPL_W;
const FONT_TITLE = '"PrintokenTitle", "Cinzel", "Cormorant SC", Georgia, serif';
const FONT_BODY = '"PrintokenBody", "EB Garamond", "Garamond", Georgia, serif';
const FONT_MANA = '"PrintokenMana", "Mana", monospace';

// Mana cost token → Andrew Gioia "Mana" font codepoint. Covers the common
// stuff; unknown tokens fall back to letter-in-circle so we never crash.
const MANA_GLYPHS = (() => {
  const cc = n => String.fromCharCode(n);
  const m = {
    W: cc(0xe600), U: cc(0xe601), B: cc(0xe602), R: cc(0xe603), G: cc(0xe604),
    C: cc(0xe904), S: cc(0xe619),
    X: cc(0xe615), Y: cc(0xe616), Z: cc(0xe617),
    T: cc(0xe61a), Q: cc(0xe61b),
    P: cc(0xe618),
    E: cc(0xe907),
    HALF: cc(0xe902), INFINITY: cc(0xe903),
  };
  for (let i = 0; i <= 15; i++) m[String(i)] = cc(0xe605 + i);
  for (let i = 16; i <= 20; i++) m[String(i)] = cc(0xe62a + (i - 16));
  return m;
})();

// Tolerant mana-cost parser. Accepts both "{2}{R}" and the looser "2R" /
// "10WW" / "wub" / "tap". Anything in {…} is a single token; outside braces,
// digit runs group together and each non-digit letter becomes its own token.
function parseManaCost(s) {
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      const end = s.indexOf('}', i);
      if (end === -1) { i++; continue; }
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < s.length && /\d/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else if (/[a-zA-Z]/.test(c)) {
      out.push(c.toUpperCase());
      i++;
    } else {
      i++; // skip stray punctuation
    }
  }
  return out;
}

function manaGlyph(token) {
  // Token comes without braces: "W", "2", "T", "W/U", etc.
  // For hybrids like "W/U" we just take the first colour for simplicity —
  // good enough on a tiny B&W thermal print, doesn't crash on weird inputs.
  const t = token.toUpperCase();
  if (MANA_GLYPHS[t]) return MANA_GLYPHS[t];
  if (t.includes('/')) return MANA_GLYPHS[t.split('/')[0]] || null;
  return null;
}

// Layout in template units (matches M15 token style file)
const L = {
  border:  { x: 0, y: 0, w: TPL_W, h: TPL_H, radius: 18, inset: 17 },
  name:    { x: 30, y: 26, w: 315, h: 28, fontSize: 19 },
  art:     { x: 29, y: 62, w: 317, h: 289 },
  type:    { x: 32, y: 354, w: 311, h: 20, fontSize: 14 },
  text:    { x: 31, y: 388, w: 311, h: 94, fontSize: 14, minSize: 10,
             padL: 6, padT: 2, padR: 4, padB: 2, lineH: 1.2 },
  ptBox:   { x: 273, y: 466, w: 81, h: 42, textX: 286, textY: 469, textW: 60, textH: 28, fontSize: 16 },
  pip:     { gap: 1.5 },
};

const form = document.getElementById('form');
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const downloadBtn = document.getElementById('download');

const SUPERTYPE = 'Token';

const state = {
  name: '',
  cost: '',
  types: [],        // e.g. ['Creature']
  subtypes: [],     // e.g. ['Goblin', 'Warrior']
  colors: [],
  rules: '',
  flavor: '',
  power: '',
  toughness: '',
  art: null,        // HTMLImageElement
  paper: '53',
  dpi: 203,
  algo: 'none',
  density: 50,
  sharpen: false,
};

function parseJsonArray(v) {
  try {
    const parsed = JSON.parse((v ?? '[]').toString());
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readForm() {
  const fd = new FormData(form);
  state.name = (fd.get('name') || '').toString().trim();
  state.cost = (fd.get('cost') || '').toString().trim();
  state.types = parseJsonArray(fd.get('types'));
  state.subtypes = parseJsonArray(fd.get('subtypes'));
  state.colors = fd.getAll('color').map(String);
  state.rules = (fd.get('rules') || '').toString();
  state.flavor = (fd.get('flavor') || '').toString();
  state.power = (fd.get('power') || '').toString().trim();
  state.toughness = (fd.get('toughness') || '').toString().trim();
  state.paper = (fd.get('paper') || '53').toString();
  state.dpi = parseInt((fd.get('dpi') || '203').toString(), 10);
  state.algo = (fd.get('algo') || 'none').toString();
  state.density = parseInt((fd.get('density') ?? '50').toString(), 10);
  state.sharpen = fd.get('sharpen') != null;
}

function resizeCanvas() {
  const widthMm = PAPER_MM[state.paper] ?? 53;
  const widthPx = Math.round((widthMm / 25.4) * state.dpi);
  const heightPx = Math.round(widthPx * ASPECT);
  if (canvas.width !== widthPx || canvas.height !== heightPx) {
    canvas.width = widthPx;
    canvas.height = heightPx;
  }
  // Display size reflects paper width so 80mm visibly looks wider than 53mm.
  // 4 px/mm is roughly screen-realistic; capped at the container's width.
  canvas.style.width = `min(100%, ${widthMm * 4}px)`;
}

// --- drawing helpers ---

// Convert template units (375-wide design) to actual canvas pixels.
function u(n) { return n * (canvas.width / TPL_W); }

function setFont(sizePx, { family = FONT_BODY, weight = 400, italic = false } = {}) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${sizePx}px ${family}`;
}

function wrapLines(text, maxWidth) {
  const lines = [];
  for (const para of text.split(/\n+/)) {
    if (!para) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawWrapped(text, x, y, maxWidth, lineHeight, opts = {}) {
  if (!text) return y;
  const lines = wrapLines(text, maxWidth);
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

function fitText(text, maxWidth, startSize, minSize, fontOpts) {
  let size = startSize;
  while (size > minSize) {
    setFont(size, fontOpts);
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 0.5;
  }
  return minSize;
}

// Pip used for both color identity and inline mana cost — outlined circle
// with the letter inside, drawn in the current ink color.
function drawPip(letter, cx, cy, r, { inverted = false } = {}) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (inverted) {
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = Math.max(0.5, r * 0.08);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = '#000';
  } else {
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.fillStyle = '#fff';
  }
  setFont(r * 1.2, { family: FONT_TITLE, weight: 700 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, cx, cy + r * 0.05);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
}

// Draw a mana cost symbol from the Andrew Gioia "Mana" font glyph if we have
// one, falling back to an inverted letter pip for unknown / weird tokens.
function drawManaSymbol(token, cx, cy, r) {
  const glyph = manaGlyph(token);
  if (!glyph) {
    drawPip(token, cx, cy, r, { inverted: true });
    return;
  }
  // The font glyph IS the pip artwork. Mana font glyphs roughly fill the
  // em-square, so font-size = diameter (2r) is a good baseline. Slightly
  // less avoids the icons looking heavier than the title text beside them.
  setFont(r * 1.9, { family: FONT_MANA });
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, cx, cy);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// --- main render ---

function render() {
  resizeCanvas();
  const W = canvas.width;
  const H = canvas.height;

  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // --- Outer card border: rounded rect, single hairline ---
  ctx.strokeStyle = '#000';
  ctx.lineWidth = u(2);
  const r = u(L.border.radius);
  roundRect(u(2), u(2), W - u(4), H - u(4), r);
  ctx.stroke();

  // --- Inner frame line that sits inside the title/art/type/text boxes ---
  ctx.lineWidth = u(0.8);
  ctx.strokeStyle = '#000';

  // 1. Name strip
  const name = boxRect(L.name);
  ctx.strokeRect(name.x, name.y, name.w, name.h);

  // Reserve space for mana cost on the right of name strip
  const costTokens = parseManaCost(state.cost);
  const costR = name.h * 0.36;
  const costGap = costR * 0.45;
  const costAreaW = costTokens.length ? costTokens.length * (costR * 2 + costGap) + u(6) : 0;
  const nameMaxW = name.w - costAreaW - u(10);

  const nameLabel = state.name || 'Unnamed Token';
  const nameSize = fitText(nameLabel, nameMaxW, u(L.name.fontSize), u(L.name.fontSize) * 0.55, { family: FONT_TITLE, weight: 700 });
  setFont(nameSize, { family: FONT_TITLE, weight: 700 });
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  ctx.fillText(nameLabel, name.x + u(6), name.y + name.h / 2);

  if (costTokens.length) {
    let cx = name.x + name.w - costR - u(6);
    const cy = name.y + name.h / 2;
    for (let i = costTokens.length - 1; i >= 0; i--) {
      drawManaSymbol(costTokens[i], cx, cy, costR);
      cx -= (costR * 2 + costGap);
    }
  }
  ctx.textBaseline = 'alphabetic';

  // 2. Art window
  const art = boxRect(L.art);
  ctx.fillStyle = '#fff';
  ctx.fillRect(art.x, art.y, art.w, art.h);
  if (state.art) {
    drawArt(state.art, art.x, art.y, art.w, art.h);
  } else {
    // Diagonal hatching placeholder
    ctx.save();
    ctx.beginPath();
    ctx.rect(art.x, art.y, art.w, art.h);
    ctx.clip();
    ctx.strokeStyle = '#cfcfcf';
    ctx.lineWidth = u(0.6);
    const step = u(7);
    for (let i = -art.h; i < art.w + art.h; i += step) {
      ctx.beginPath();
      ctx.moveTo(art.x + i, art.y);
      ctx.lineTo(art.x + i + art.h, art.y + art.h);
      ctx.stroke();
    }
    ctx.restore();
    setFont(u(10), { family: FONT_BODY, italic: true });
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('art', art.x + art.w / 2, art.y + art.h / 2 + u(3));
    ctx.textAlign = 'start';
  }
  ctx.lineWidth = u(0.8);
  ctx.strokeStyle = '#000';
  ctx.strokeRect(art.x, art.y, art.w, art.h);

  // 3. Type bar
  const type = boxRect(L.type);
  ctx.strokeRect(type.x, type.y, type.w, type.h);

  const leftSide = [SUPERTYPE, ...state.types].join(' ');
  const rightSide = state.subtypes.join(' ');
  const typeText = rightSide ? `${leftSide} — ${rightSide}` : leftSide;

  // Color pips on the right of the type line
  const colors = state.colors;
  const pipR = type.h * 0.32;
  const pipGap = pipR * 0.45;
  const pipAreaW = colors.length ? colors.length * (pipR * 2 + pipGap) + u(4) : 0;
  const typeMaxW = type.w - pipAreaW - u(10);

  const typeSize = fitText(typeText, typeMaxW, u(L.type.fontSize), u(L.type.fontSize) * 0.6, { family: FONT_TITLE, weight: 700 });
  setFont(typeSize, { family: FONT_TITLE, weight: 700 });
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  ctx.fillText(typeText, type.x + u(6), type.y + type.h / 2);

  if (colors.length) {
    let cx = type.x + type.w - pipR - u(4);
    const cy = type.y + type.h / 2;
    for (let i = colors.length - 1; i >= 0; i--) {
      drawPip(colors[i], cx, cy, pipR);
      cx -= (pipR * 2 + pipGap);
    }
  }
  ctx.textBaseline = 'alphabetic';

  // 4. Text box (rules + flavor)
  const tb = boxRect(L.text);
  ctx.strokeRect(tb.x, tb.y, tb.w, tb.h);

  const padL = u(L.text.padL), padT = u(L.text.padT), padR = u(L.text.padR), padB = u(L.text.padB);
  const innerX = tb.x + padL;
  const innerY = tb.y + padT;
  const innerW = tb.w - padL - padR;
  const innerH = tb.h - padT - padB;

  const startSize = u(L.text.fontSize);
  const minSize = u(L.text.minSize);
  let bodySize = startSize;
  let lh, rulesLines, flavorLines, totalH;
  for (; bodySize >= minSize; bodySize -= 0.5) {
    setFont(bodySize, { family: FONT_BODY });
    lh = bodySize * L.text.lineH;
    rulesLines = state.rules ? wrapLines(state.rules, innerW) : [];
    setFont(bodySize, { family: FONT_BODY, italic: true });
    flavorLines = state.flavor ? wrapLines(state.flavor, innerW) : [];
    const flavorGap = (rulesLines.length && flavorLines.length) ? lh * 0.5 : 0;
    totalH = rulesLines.length * lh + flavorGap + flavorLines.length * lh;
    if (totalH <= innerH) break;
  }

  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  // Center the text block vertically inside the box
  const offsetY = Math.max(0, (innerH - totalH) / 2);
  let y = innerY + offsetY;

  if (rulesLines.length) {
    setFont(bodySize, { family: FONT_BODY });
    for (const line of rulesLines) { ctx.fillText(line, innerX, y); y += lh; }
  }
  if (rulesLines.length && flavorLines.length) {
    y += lh * 0.15;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = u(0.4);
    ctx.beginPath();
    ctx.moveTo(tb.x + tb.w * 0.25, y);
    ctx.lineTo(tb.x + tb.w * 0.75, y);
    ctx.stroke();
    y += lh * 0.25;
  }
  if (flavorLines.length) {
    setFont(bodySize, { family: FONT_BODY, italic: true });
    for (const line of flavorLines) { ctx.fillText(line, innerX, y); y += lh; }
  }
  ctx.textBaseline = 'alphabetic';

  // 5. P/T box (only if either filled)
  // Real-card behavior: fixed box, shrink font down to a legible floor.
  // Beyond that, grow the box leftward so absurd values (999999/999999) stay
  // readable on a 53 mm thermal print. Right edge of the box is anchored.
  if (state.power || state.toughness) {
    const ptText = `${state.power || '*'}/${state.toughness || '*'}`;
    const fontOpts = { family: FONT_TITLE, weight: 700 };
    const fullSize = u(L.ptBox.fontSize);
    const floorSize = fullSize * 0.65;        // smallest we'll ever shrink to
    const padX = u(8);

    const defaultBox = boxRect(L.ptBox);
    const rightEdge = defaultBox.x + defaultBox.w;
    const minBoxX = u(L.text.x);              // never grow past left of text box

    // Step 1: try to fit inside the default box, shrinking to floor.
    const ptSize = fitText(ptText, defaultBox.w - padX, fullSize, floorSize, fontOpts);
    setFont(ptSize, fontOpts);
    const textW = ctx.measureText(ptText).width;

    // Step 2: if still overflowing at floor, widen the box leftward.
    let pt = defaultBox;
    if (textW > defaultBox.w - padX) {
      const wantedW = textW + padX;
      const newW = Math.min(wantedW, rightEdge - minBoxX);
      pt = { x: rightEdge - newW, y: defaultBox.y, w: newW, h: defaultBox.h };
    }

    // Draw the box
    ctx.fillStyle = '#fff';
    ctx.fillRect(pt.x, pt.y, pt.w, pt.h);
    ctx.lineWidth = u(1);
    ctx.strokeStyle = '#000';
    roundRect(pt.x, pt.y, pt.w, pt.h, u(4));
    ctx.stroke();

    setFont(ptSize, fontOpts);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ptText, pt.x + pt.w / 2, pt.y + pt.h / 2 + u(0.5));
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

// Convert a layout entry (template units) to actual canvas-pixel rect.
function boxRect(b) {
  return { x: u(b.x), y: u(b.y), w: u(b.w), h: u(b.h) };
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawArt(img, x, y, w, h) {
  // Cover-fit the source image into (x,y,w,h), then dither to B&W using
  // Floyd–Steinberg so it prints legibly on a thermal head (single-pass
  // 1-bit output looks blotchy; ordered dither also works but FS is sharper
  // for line art / illustration).
  const ar = img.width / img.height;
  let dw = w, dh = h;
  // Cover-fit: scale to fill the box, cropping the excess.
  if (ar > w / h) { dh = h; dw = h * ar; }
  else { dw = w; dh = w / ar; }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  // Render into an off-screen canvas at the destination size, then dither
  // and blit a single ImageData back into the main canvas.
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(w));
  off.height = Math.max(1, Math.round(h));
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, off.width, off.height);
  octx.drawImage(img, dx - x, dy - y, dw, dh);

  const imageData = octx.getImageData(0, 0, off.width, off.height);
  // Read dither settings from the form's Advanced controls.
  // Density 0–100 → threshold 200–56 (higher density = more black ink).
  const density = parseInt(state.density, 10);
  const threshold = isFinite(density) ? Math.round(200 - density * 1.44) : 128;
  window.Printoken.ditherImage(imageData, {
    algorithm: state.algo || 'atkinson',
    threshold,
    sharpen: state.sharpen !== false,
  });
  // Place dithered result at (x,y) in the main canvas.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // putImageData ignores transforms, so we draw via a temp canvas.
  octx.putImageData(imageData, 0, 0);
  ctx.drawImage(off, x, y);
  ctx.restore();
}

// Dithering is shared via window.Printoken.ditherImage (utils.js).

// --- events ---

function safeRender() {
  try {
    readForm();
    render();
  } catch (err) {
    console.error('render failed', err);
    const wrap = document.getElementById('preview-wrap');
    let banner = document.getElementById('err-banner');
    if (!banner) {
      banner = document.createElement('pre');
      banner.id = 'err-banner';
      banner.style.cssText = 'color:#a00;background:#fee;padding:8px;border-radius:6px;white-space:pre-wrap;font-size:12px;max-width:100%';
      wrap.prepend(banner);
    }
    banner.textContent = String(err && err.stack || err);
  }
}

// Listen on every input directly — broadest browser support.
for (const el of form.querySelectorAll('input, textarea, select')) {
  const evt = (el.type === 'checkbox' || el.type === 'file' || el.tagName === 'SELECT') ? 'change' : 'input';
  el.addEventListener(evt, e => {
    if (el.name === 'art') {
      const file = el.files?.[0];
      if (!file) { window.Printoken.setArt(null); return; }
      const img = new Image();
      img.onload = () => { window.Printoken.setArt(img); };
      img.onerror = () => { window.Printoken.setArt(null); };
      img.src = URL.createObjectURL(file);
      return;
    }
    safeRender();
  });
}

// Live-update the density slider's adjacent <output> readout.
const densityInput = form.querySelector('input[name=density]');
const densityOut = document.getElementById('density-out');
if (densityInput && densityOut) {
  densityInput.addEventListener('input', () => {
    densityOut.textContent = densityInput.value;
  });
}

downloadBtn.addEventListener('click', () => {
  safeRender();
  window.Printoken.shareCanvas(canvas, state.name || 'token');
});

// --- Tag pickers for Type / Subtype ---

let typesSel = [];
let subtypesSel = [];
let typePicker, subPicker;

function initTagPickers() {
  const typesHidden = form.querySelector('input[type=hidden][name=types]');
  const subtypesHidden = form.querySelector('input[type=hidden][name=subtypes]');
  const typesRoot = form.querySelector('.tagpicker[data-field=types]');
  const subtypesRoot = form.querySelector('.tagpicker[data-field=subtypes]');

  typesSel = parseJsonArray(typesHidden.value);
  subtypesSel = parseJsonArray(subtypesHidden.value);

  function syncHidden(input, value) {
    input.value = JSON.stringify(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  typePicker = window.createTagPicker(typesRoot, {
    getSource: () => window.PrintokenCatalog.cardTypes(),
    getSelected: () => typesSel,
    onChange: next => {
      typesSel = next;
      syncHidden(typesHidden, next);
      const allowed = new Set(window.PrintokenCatalog.subtypesFor(typesSel));
      const filtered = subtypesSel.filter(s => allowed.has(s));
      if (filtered.length !== subtypesSel.length) {
        subtypesSel = filtered;
        syncHidden(subtypesHidden, filtered);
      }
      subPicker?.rerender();
    },
  });

  subPicker = window.createTagPicker(subtypesRoot, {
    getSource: () => window.PrintokenCatalog.subtypesFor(typesSel),
    getSelected: () => subtypesSel,
    onChange: next => {
      subtypesSel = next;
      syncHidden(subtypesHidden, next);
    },
  });

  // Helper for programmatic population (search results, etc.)
  typePicker._setSelected = arr => { typesSel = arr.slice(); syncHidden(typesHidden, typesSel); typePicker.rerender(); };
  subPicker._setSelected = arr => { subtypesSel = arr.slice(); syncHidden(subtypesHidden, subtypesSel); subPicker.rerender(); };

  window.PrintokenCatalog.loadAll().then(() => {
    typePicker.rerender();
    subPicker.rerender();
  });
}

initTagPickers();

// --- Programmatic state population (used by Search to import a Scryfall card) ---

function setInputValue(name, value) {
  const el = form.elements[name];
  if (!el) return;
  el.value = value ?? '';
  if (name === 'power' || name === 'toughness') sizePtInput(el);
}

// Resize a P/T input to fit its content, expanding leftward (the box is
// right-anchored so it naturally grows toward the left).
function sizePtInput(el) {
  el.style.width = Math.max(el.value.length, 1) + 'ch';
}

// Inject an already-loaded HTMLImageElement as the card art and re-render.
// Also updates the in-card art preview so both views stay in sync.
// Called by ai.js after generation, and by the file-upload listener below.
window.Printoken.setArt = function setArt(img) {
  state.art = img || null;
  const previewImg  = document.getElementById('art-preview-img');
  const previewHint = document.getElementById('art-preview-hint');
  if (previewImg) {
    if (img) {
      previewImg.src = img.src;
      previewImg.hidden = false;
      if (previewHint) previewHint.hidden = true;
    } else {
      previewImg.hidden = true;
      previewImg.src = '';
      if (previewHint) previewHint.hidden = false;
    }
  }
  safeRender();
};

// Programmatic state population — kept available for future flows
// (e.g. AI generation may want to drop generated art into the form).
window.Printoken.populateState = function populateState(data) {
  setInputValue('name', data.name || '');
  setInputValue('cost', data.cost || '');
  setInputValue('rules', data.rules || '');
  setInputValue('flavor', data.flavor || '');
  setInputValue('power', data.power || '');
  setInputValue('toughness', data.toughness || '');

  // Color identity checkboxes
  const colorSet = new Set(data.colors || []);
  for (const cb of form.querySelectorAll('input[name=color]')) {
    cb.checked = colorSet.has(cb.value);
  }

  // Type / subtype pickers
  typePicker?._setSelected(data.types || []);
  subPicker?._setSelected(data.subtypes || []);

  // Art (HTMLImageElement, already loaded)
  state.art = data.art || null;

  safeRender();
};

// Auto-size P/T inputs on direct user input.
for (const name of ['power', 'toughness']) {
  const el = form.elements[name];
  if (el) el.addEventListener('input', () => sizePtInput(el));
}

// initial paint — wait for the custom fonts so first measure is accurate.
safeRender();
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(safeRender);
}
