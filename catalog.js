// Scryfall catalog loader — fetches official type lists, caches in localStorage.
// Falls back to a small bundled list when offline / blocked.

(function () {
  const CACHE_KEY = 'printoken:catalogs:v1';
  const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

  // Card types we let the user pick. Tokens are usually Creature, but artifact/
  // enchantment/land tokens exist too. Skip Instant/Sorcery — no token spells.
  const CARD_TYPES = [
    'Artifact',
    'Battle',
    'Creature',
    'Enchantment',
    'Land',
    'Planeswalker',
  ];

  // Mapping from card type → Scryfall catalog endpoint name for its subtypes.
  const SUBTYPE_CATALOGS = {
    Artifact: 'artifact-types',
    Battle: 'battle-types',
    Creature: 'creature-types',
    Enchantment: 'enchantment-types',
    Land: 'land-types',
    Planeswalker: 'planeswalker-types',
  };

  // Tiny fallback in case Scryfall is unreachable on first load.
  const FALLBACK = {
    'creature-types': ['Goblin', 'Elf', 'Zombie', 'Soldier', 'Spirit', 'Treefolk', 'Wizard', 'Beast', 'Cat', 'Dragon', 'Knight', 'Warrior', 'Saproling', 'Thopter', 'Servo', 'Construct', 'Insect', 'Snake', 'Wolf', 'Wurm', 'Angel', 'Demon', 'Vampire', 'Bird', 'Drake', 'Elemental', 'Faerie', 'Giant', 'Horror', 'Human', 'Merfolk', 'Minotaur', 'Ogre', 'Orc', 'Plant', 'Rat', 'Rogue', 'Shaman', 'Skeleton', 'Soldier', 'Vedalken'],
    'artifact-types': ['Equipment', 'Vehicle', 'Food', 'Treasure', 'Clue', 'Blood', 'Powerstone', 'Map', 'Gold', 'Junk', 'Bobblehead', 'Contraption', 'Fortification'],
    'enchantment-types': ['Aura', 'Background', 'Class', 'Saga', 'Shrine', 'Cartouche', 'Curse', 'Rune', 'Shard', 'Case', 'Role'],
    'land-types': ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Cave', 'Desert', 'Gate', 'Lair', 'Locus', 'Mine', 'Power-Plant', 'Sphere', 'Tower', 'Urza’s'],
    'planeswalker-types': ['Ajani', 'Chandra', 'Garruk', 'Jace', 'Liliana', 'Nissa', 'Teferi', 'Elspeth', 'Sorin'],
    'battle-types': ['Siege'],
  };

  let cache = loadCache();

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return { ts: 0, data: {} };
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > CACHE_TTL_MS) return { ts: 0, data: {} };
      return parsed;
    } catch {
      return { ts: 0, data: {} };
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {/* quota / private mode */}
  }

  async function fetchCatalog(name) {
    if (cache.data[name]?.length) return cache.data[name];
    try {
      const r = await fetch(`https://api.scryfall.com/catalog/${name}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const arr = Array.isArray(j.data) ? j.data : [];
      cache.data[name] = arr;
      cache.ts = Date.now();
      saveCache();
      return arr;
    } catch (err) {
      console.warn('catalog fetch failed', name, err);
      return FALLBACK[name] || [];
    }
  }

  async function loadAll() {
    const names = Object.values(SUBTYPE_CATALOGS);
    await Promise.all(names.map(fetchCatalog));
  }

  function subtypesFor(types) {
    if (!types || !types.length) {
      // Default to creature subtypes — by far the most common token kind.
      return cache.data['creature-types'] || FALLBACK['creature-types'];
    }
    const out = new Set();
    for (const t of types) {
      const cat = SUBTYPE_CATALOGS[t];
      if (!cat) continue;
      const list = cache.data[cat] || FALLBACK[cat] || [];
      for (const s of list) out.add(s);
    }
    return [...out].sort();
  }

  window.PrintokenCatalog = {
    cardTypes: () => CARD_TYPES.slice(),
    subtypesFor,
    loadAll,
  };
})();
