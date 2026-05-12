// Tagpicker: searchable multi-select chip input.
// Reads source list from a getter, writes selected items to a sibling
// hidden input as JSON, and dispatches an `input` event so the form's
// existing listener re-renders the canvas.

window.createTagPicker = function createTagPicker(root, { getSource, getSelected, onChange }) {
  const placeholder = root.dataset.placeholder || 'Add…';
  root.classList.add('tagpicker-mounted');
  root.innerHTML = `
    <div class="chips" role="list"></div>
    <button type="button" class="add-btn" aria-label="Add" hidden>+</button>
    <div class="search-wrap">
      <input class="tagsearch" type="text" placeholder="${placeholder}" autocomplete="off">
    </div>
  `;
  const chipsEl = root.querySelector('.chips');
  const addBtn = root.querySelector('.add-btn');
  const searchWrap = root.querySelector('.search-wrap');
  const input = root.querySelector('.tagsearch');

  // Portal the suggestions popover to <body> so it can escape any
  // overflow:hidden / clipped ancestor (e.g. our card-form).
  const suggestions = document.createElement('ul');
  suggestions.className = 'suggestions tagpicker-popover';
  suggestions.hidden = true;
  document.body.appendChild(suggestions);

  function positionPopover() {
    const r = input.getBoundingClientRect();
    if (!r.width || !r.height) { hidePopover(); return false; }
    suggestions.style.position = 'fixed';
    suggestions.style.left = r.left + 'px';
    suggestions.style.top = (r.bottom + 2) + 'px';
    suggestions.style.minWidth = r.width + 'px';
    return true;
  }
  function hidePopover() {
    suggestions.hidden = true;
    suggestions.style.left = '-9999px';
    suggestions.style.top = '-9999px';
  }
  window.addEventListener('scroll', () => { if (!suggestions.hidden) positionPopover(); }, true);
  window.addEventListener('resize', () => { if (!suggestions.hidden) positionPopover(); });

  // Collapse the input behind a + button once at least one chip is present.
  function reflectMode() {
    const hasChips = selected().length > 0;
    if (hasChips) {
      addBtn.hidden = false;
      searchWrap.hidden = true;
    } else {
      addBtn.hidden = true;
      searchWrap.hidden = false;
    }
  }
  addBtn.addEventListener('click', () => {
    addBtn.hidden = true;
    searchWrap.hidden = false;
    input.focus();
  });

  let activeIndex = -1;
  let currentMatches = [];

  function selected() {
    return getSelected();
  }

  function renderChips() {
    const sel = selected();
    chipsEl.innerHTML = '';
    for (const tag of sel) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.setAttribute('role', 'listitem');
      chip.textContent = tag;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.setAttribute('aria-label', `Remove ${tag}`);
      x.textContent = '×';
      x.addEventListener('click', e => {
        e.stopPropagation();
        const next = selected().filter(t => t !== tag);
        commit(next);
      });
      chip.appendChild(x);
      chipsEl.appendChild(chip);
    }
  }

  function commit(next) {
    onChange(next);
    renderChips();
    reflectMode();
    refreshSuggestions();
  }

  function refreshSuggestions() {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    const sel = new Set(selected().map(s => s.toLowerCase()));
    const source = getSource() || [];
    const matches = [];

    // "Add 'X'" entry when the typed value isn't already an exact match
    // (case-insensitive) in the source list or in the selected chips.
    if (raw) {
      const existsInSource = source.some(s => s.toLowerCase() === q);
      const alreadySelected = sel.has(q);
      if (!existsInSource && !alreadySelected) {
        matches.push({ label: `Add “${raw}”`, value: raw, custom: true });
      }
    }

    for (const item of source) {
      if (sel.has(item.toLowerCase())) continue;
      if (!q || item.toLowerCase().includes(q)) matches.push({ label: item, value: item });
      if (matches.length >= 50) break;
    }
    currentMatches = matches;
    activeIndex = matches.length ? 0 : -1;
    paintSuggestions();
  }

  function paintSuggestions() {
    if (!currentMatches.length || document.activeElement !== input) {
      hidePopover();
      suggestions.innerHTML = '';
      return;
    }
    // Render contents first while still hidden / off-screen.
    suggestions.innerHTML = '';
    currentMatches.forEach((m, i) => {
      const li = document.createElement('li');
      li.textContent = m.label;
      if (m.custom) li.classList.add('custom');
      if (i === activeIndex) li.classList.add('active');
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        addTag(m.value);
      });
      suggestions.appendChild(li);
    });
    // Position FIRST (still off-screen via inline -9999), THEN unhide.
    // If the input rect isn't ready (just unhidden, layout pending), retry next frame.
    if (positionPopover()) {
      suggestions.hidden = false;
    } else {
      requestAnimationFrame(() => {
        if (document.activeElement === input && positionPopover()) {
          suggestions.hidden = false;
        }
      });
    }
  }

  function addTag(tag) {
    const sel = selected();
    if (sel.includes(tag)) return;
    commit([...sel, tag]);
    input.value = '';
    refreshSuggestions();
    input.focus();
  }

  input.addEventListener('focus', refreshSuggestions);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      hidePopover();
      // Re-collapse to + button if user wandered off without typing anything.
      if (!input.value && selected().length > 0) {
        input.value = '';
        reflectMode();
      }
    }, 120);
  });
  input.addEventListener('input', refreshSuggestions);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentMatches.length) {
        activeIndex = (activeIndex + 1) % currentMatches.length;
        paintSuggestions();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentMatches.length) {
        activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
        paintSuggestions();
      }
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      const raw = input.value.trim();
      if (!raw && e.key === 'Tab') return; // let Tab move focus normally
      e.preventDefault();
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        addTag(currentMatches[activeIndex].value);
      } else if (raw) {
        addTag(raw);
      }
    } else if (e.key === 'Backspace' && !input.value) {
      const sel = selected();
      if (sel.length) commit(sel.slice(0, -1));
    } else if (e.key === 'Escape') {
      hidePopover();
    }
  });

  // Initial paint
  renderChips();
  reflectMode();

  return {
    rerender() { renderChips(); reflectMode(); refreshSuggestions(); },
  };
};
