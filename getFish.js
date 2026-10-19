// getFish.js - paste into the browser console (F12) while logged in to the game.
// Version 2.2 (shown in the panel header, so you can tell if your bookmark is out of date).
// Opens a panel with three lists: "I have" (your inventory), "I need" (fish still needed for Mastery)
// and "Nations" (fish still needed for your open nation orders).
// Pick rarities and copy the lists in a Discord-friendly format.
(async () => {
  const VERSION = "2.2";
  // Only one copy may run at a time: running the script again first stops the previous run
  // (closes its panel and stops its requests, timers and event listeners).
  window.__getFishStop?.();
  let alive = true;
  const cleanups = [];
  const stop = () => {
    if (!alive) return;
    alive = false;
    for (const fn of cleanups) { try { fn(); } catch {} }
    document.getElementById("getfish-panel")?.remove();
    document.getElementById("getfish-style")?.remove();
    if (window.__getFishStop === stop) delete window.__getFishStop;
  };
  window.__getFishStop = stop;
  if (!window.ApiService) { alert("getFish: open the game first, then run the script."); stop(); return; }

  const RARITIES = window.RARITIES || ["Common", "Uncommon", "Fine", "Rare", "Epic", "Legendary", "Mythic", "Exotic", "Arcane"];

  // Your choices (tab, rarities, format, settings, biome range) are remembered in this browser only
  const SETTINGS_KEY = "getFish.settings";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch {}
  const save = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ nationPicked, mode, format, subtractOwned, biomeFrom, biomeTo, rarityDefaultsV2: Object.fromEntries(Object.entries(chosenBy).filter(([k]) => k !== "nation" || nationPicked).map(([k, v]) => [k, [...v]])) }));
    } catch {}
  };

  let player;
  try {
    player = await window.ApiService.getPlayerData();
  } catch (e) {
    if (alive) alert("Could not fetch inventory: " + e.message);
    stop();
    return;
  }
  if (!alive) return; // a newer run took over while we were waiting
  // Remembered Mastery/Nations data belongs to one account, so switching account never shows old data
  const accountOf = p => String(p?.id ?? p?.user_id ?? p?.userId ?? p?.username ?? p?.name ?? "");
  const account = accountOf(player);
  const fresh = cache => cache && cache.account === account && Date.now() - cache.at < 5 * 60 * 1000;
  // When each list was last fetched from the server (shown as "Updated X min ago")
  const fetchedAt = { have: Date.now(), need: 0, nation: 0 };
  let refreshFailed = false;
  const haveFrom = p => merge(((p && p.inventory) || []).map(i => ({
    name: i.name, rarity: i.rarity, biome: i.biomeId ?? i.biome_id ?? "?", count: i.count || 1,
  })));

  // Look up a fish's rarity from the game's biome fish catalog
  const rarityOf = (name, biome) => {
    const byRarity = window.BIOMES?.[biome]?.fish || {};
    for (const [r, list] of Object.entries(byRarity)) if (list?.some(f => f.name === name)) return r;
    return "?";
  };

  // Merge identical fish (same name, rarity and biome) and sort by biome, then name
  const merge = items => {
    const groups = new Map();
    for (const { name, rarity, biome, count } of items) {
      const key = `${rarity}|${biome}|${name}`;
      const g = groups.get(key) || { name, rarity, biome, count: 0 };
      g.count += count;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) =>
      (Number(a.biome) || 0) - (Number(b.biome) || 0) || a.name.localeCompare(b.name));
  };

  const lists = {
    have: haveFrom(player),
    need: null, // loaded on demand when the "I need" tab is opened
    nation: null, // loaded on demand when the "Nations" tab is opened
  };
  // Mastery is only fetched when the "I need" tab is opened, and only for biomes you have unlocked
  // (the game hides Mastery for locked biomes). Calls go one at a time with a short pause, and the
  // result is cached for 5 minutes so re-opening the panel does not ask the server again.
  let masteryOk = false, masteryFailed = 0;
  // A pause that is cut short if the panel closes; it removes its own cleanup entry when done
  const sleep = ms => new Promise(r => {
    const cancel = () => { clearTimeout(t); r(); };
    const t = setTimeout(() => { cleanups.splice(cleanups.indexOf(cancel), 1); r(); }, ms);
    cleanups.push(cancel);
  });
  async function loadNeed(onProgress, force = false) {
    const cache = window.__getFishMastery;
    let rows;
    masteryOk = false;
    if (!force && fresh(cache)) {
      rows = cache.rows;
      fetchedAt.need = cache.at;
      masteryFailed = 0;
    } else {
      const unlocked = (player.unlockedBiomes || []).map(String);
      const ids = Object.keys(window.BIOMES || {}).filter(id => !unlocked.length || unlocked.includes(String(id)));
      rows = [];
      let ok = 0;
      for (const [i, id] of ids.entries()) {
        if (!alive) return;
        onProgress?.(i + 1, ids.length);
        try {
          const m = await window.ApiService.request(`/mastery/biome/${id}`);
          if (!alive) return;
          ok++;
          for (const t of m?.targetFish || []) {
            const remaining = (t.required || 0) - (m.progress?.[t.fishName] || 0);
            rows.push({ fishName: t.fishName, rarity: t.rarity, biomeId: id, remaining });
          }
        } catch {}
        if (i < ids.length - 1) await sleep(400);
      }
      if (!ok) return;
      masteryFailed = ids.length - ok;
      // Only remember complete results, so a biome that failed is asked again next time
      fetchedAt.need = Date.now();
      if (!masteryFailed) window.__getFishMastery = { at: fetchedAt.need, account, rows };
    }
    masteryOk = true;
    lists.need = merge(rows.filter(f => f.remaining > 0).map(f => {
      const biome = f.biomeId ?? f.biome_id ?? "?";
      return { name: f.fishName, rarity: f.rarity || rarityOf(f.fishName, biome), biome, count: f.remaining };
    }));
  }

  // Nations: one request (the same one the game uses) for your active nation orders.
  // Each order has a fish, its biome, and how many are still needed. Cached for 5 minutes.
  let nationOk = false, onNationLoaded = null;
  async function loadNation(force = false) {
    const cache = window.__getFishNation;
    let orders;
    nationOk = false;
    if (!force && fresh(cache)) {
      orders = cache.orders;
      fetchedAt.nation = cache.at;
    } else {
      try {
        const r = await window.ApiService.getNations();
        if (!alive) return;
        orders = r?.orders || [];
        fetchedAt.nation = Date.now();
        window.__getFishNation = { at: fetchedAt.nation, account, orders };
      } catch { return; }
    }
    nationOk = true;
    lists.nation = merge(orders.map(o => {
      const biome = o.biome_id ?? o.biomeId ?? "?";
      return { name: o.fish_name, rarity: o.rarity || rarityOf(o.fish_name, biome), biome,
        count: (o.target_amount || 0) - (o.current_progress || 0) };
    }).filter(f => f.count > 0));
    onNationLoaded?.();
  }

  const headings = { have: "I have:", need: "I need:", nation: "I need (Nations):" };
  let mode = ["need", "nation"].includes(saved.mode) ? saved.mode : "have";
  let subtractOwned = saved.subtractOwned !== false; // on by default
  let biomeFrom = saved.biomeFrom ?? "", biomeTo = saved.biomeTo ?? "";

  // What a tab shows: "I need" can subtract fish you already own (locked fish count too, since
  // they can be sacrificed to Mastery), then both tabs apply the biome range.
  const ownedOf = f => lists.have
    .filter(h => h.name === f.name && (h.biome === "?" || String(h.biome) === String(f.biome)))
    .reduce((s, h) => s + h.count, 0);
  const view = () => {
    let fish = lists[mode] || [];
    if (mode !== "have" && subtractOwned) {
      fish = fish.map(f => ({ ...f, count: f.count - ownedOf(f) })).filter(f => f.count > 0);
    }
    const lo = biomeFrom === "" ? -Infinity : Number(biomeFrom), hi = biomeTo === "" ? Infinity : Number(biomeTo);
    return fish.filter(f => { const b = Number(f.biome); return isNaN(b) || (b >= lo && b <= hi); });
  };

  // Discord format: code block with aligned columns, grouped by biome
  const biomeName = id => window.BIOMES?.[id]?.name || "";
  // Returns the list as one or more Discord messages (Discord's limit is 2000 characters).
  // "full": aligned code block grouped by biome. "compact": one short line per fish, no code block.
  const DISCORD_LIMIT = 2000;
  let format = saved.format === "compact" ? "compact" : "full";
  const listFor = list => {
    if (!list.length) return [""];
    const total = list.reduce((s, f) => s + f.count, 0);
    const rows = [];
    if (format === "compact") {
      for (const f of list) rows.push(`B${f.biome} ${f.name} (${f.rarity}) x${f.count}`);
    } else {
      const nameW = Math.max(...list.map(f => f.name.length));
      const countW = Math.max(...list.map(f => String(f.count).length));
      let lastBiome;
      for (const f of list) {
        if (f.biome !== lastBiome) {
          if (rows.length) rows.push("");
          rows.push(`── B${f.biome} ${biomeName(f.biome)} ──`);
          lastBiome = f.biome;
        }
        rows.push(`  ${f.name.padEnd(nameW)}  ${f.rarity.padEnd(9)}  x${String(f.count).padStart(countW)}`);
      }
    }
    const fence = format === "full" ? "```" : "";
    const wrap = (body, part, parts, last) => {
      const head = `**${headings[mode]}**` + (parts > 1 ? ` (${part}/${parts})` : "");
      const tail = last ? `${format === "full" ? "\n" : ""}\nTotal: ${total}` : "";
      return fence ? `${head}\n${fence}\n${body}${tail}\n${fence}` : `${head}\n${body}${tail}`;
    };
    // Pack rows into chunks that fit, leaving room for the header, "(n/m)", fences and the total line
    const room = DISCORD_LIMIT - wrap("", 99, 99, true).length;
    const chunks = [[]];
    let len = 0;
    let header = null;
    for (const row of rows) {
      if (row.startsWith("── ")) header = row;
      if (len + row.length + 1 > room && chunks.at(-1).length) {
        chunks.push([]); len = 0;
        // A part that starts in the middle of a biome repeats that biome's header
        if (header && row !== header && row !== "") { const h = header.replace(/ ──$/, " (cont.) ──"); chunks.at(-1).push(h); len += h.length + 1; }
      }
      if (!chunks.at(-1).length && row === "") continue; // no blank line at the top of a part
      chunks.at(-1).push(row);
      len += row.length + 1;
    }
    return chunks.map((c, i) => wrap(c.join("\n"), i + 1, chunks.length, i === chunks.length - 1));
  };

  // ---------- Panel UI ----------
  // Rarity colors: use the game's own RARITY_COLORS (some are gradients), with a copy as fallback
  const RARITY_COLORS = window.RARITY_COLORS || {
    Common: "#9ca3af", Uncommon: "#84cc16", Fine: "#3b82f6", Rare: "#a855f7", Epic: "#ec4899",
    Legendary: "#f59e0b", Mythic: "#ef4444", Exotic: "linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)",
    Arcane: "linear-gradient(135deg, #a855f7 0%, #ec4899 50%, #f59e0b 100%)", Event: "#10b981", Collectible: "#14b8a6",
  };
  const paintOf = r => RARITY_COLORS[r] || "#9ca3af";
  const colorOf = r => (paintOf(r).match(/#[0-9a-fA-F]{6}/) || ["#9ca3af"])[0];
  const textStyle = r => paintOf(r).startsWith("linear-gradient")
    ? `background:${paintOf(r)};-webkit-background-clip:text;background-clip:text;color:transparent`
    : `color:${paintOf(r)}`;
  const sum = list => list.reduce((s, f) => s + f.count, 0);

  document.getElementById("getfish-panel")?.remove();
  document.getElementById("getfish-style")?.remove();
  const style = document.createElement("style");
  style.id = "getfish-style";
  style.textContent = `
    #getfish-panel { position:fixed; top:24px; right:24px; width:500px; max-height:88vh; display:flex; flex-direction:column;
      z-index:999999; background:#15161f; color:#e5e7eb; font:13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      border:1px solid #2e3040; border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.55); overflow:hidden; }
    #getfish-panel * { box-sizing:border-box; }
    #getfish-panel .gf-head { display:flex; align-items:center; justify-content:space-between; padding:12px 16px;
      background:linear-gradient(90deg,#2a1f3d,#1b2a3d); border-bottom:1px solid #2e3040; cursor:move; user-select:none; }
    #getfish-panel .gf-title { font-weight:700; font-size:15px; letter-spacing:.3px; }
    #getfish-panel .gf-sub { font-size:11px; color:#9ca3af; }
    #getfish-panel .gf-x { background:none; border:none; color:#9ca3af; font-size:18px; cursor:pointer; padding:2px 6px; border-radius:6px; }
    #getfish-panel .gf-x:hover { background:#ffffff14; color:#fff; }
    #getfish-panel .gf-body { padding:14px 16px; overflow:auto; }
    #getfish-panel .gf-label { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:#6b7280; margin:0 0 6px; }
    #getfish-panel .gf-seg { display:flex; background:#0d0e14; border:1px solid #2e3040; border-radius:8px; padding:3px; margin-bottom:14px; }
    #getfish-panel .gf-seg button { flex:1; border:none; background:none; color:#9ca3af; padding:7px 0; border-radius:6px; cursor:pointer; font:inherit; font-weight:600; }
    #getfish-panel .gf-seg button.on { background:#2b2d3d; color:#fff; }
    #getfish-panel .gf-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
    #getfish-panel .gf-chip { display:flex; align-items:center; gap:6px; padding:5px 10px; border-radius:999px; cursor:pointer;
      border:1px solid #2e3040; background:#1c1d28; color:#9ca3af; font:inherit; font-size:12px; }
    #getfish-panel .gf-chip .dot { width:8px; height:8px; border-radius:50%; }
    #getfish-panel .gf-chip .n { opacity:.7; }
    #getfish-panel .gf-chip.on { color:#fff; border-color:var(--c); background:color-mix(in srgb, var(--c) 18%, #1c1d28); }
    #getfish-panel .gf-links { font-size:11px; margin-bottom:14px; }
    #getfish-panel .gf-links a { color:#818cf8; cursor:pointer; margin-right:10px; }
    #getfish-panel .gf-card { border:1px solid #2e3040; border-left:3px solid var(--c); border-image:none; border-radius:8px; background:#1a1b25; margin-bottom:10px; overflow:hidden; }
    #getfish-panel .gf-card-head { display:flex; align-items:center; justify-content:space-between; padding:7px 10px; }
    #getfish-panel .gf-card-title { font-weight:600; color:var(--c); }
    #getfish-panel .gf-card-title .n { color:#6b7280; font-weight:400; margin-left:6px; font-size:12px; }
    #getfish-panel .gf-copy { border:1px solid #3b3d52; background:#262838; color:#e5e7eb; padding:4px 12px; border-radius:6px; cursor:pointer; font:inherit; font-size:12px; }
    #getfish-panel .gf-copy:hover { background:#31344a; }
    #getfish-panel .gf-copy.ok { background:#14532d; border-color:#22c55e; color:#bbf7d0; }
    #getfish-panel textarea { display:block; width:100%; height:120px; resize:vertical; border:none; border-top:1px solid #2e3040;
      background:#0d0e14; color:#d1d5db; font:12px/1.45 Consolas, "Courier New", monospace; padding:8px 10px; outline:none; }
    #getfish-panel .gf-part { display:flex; align-items:center; gap:10px; padding:6px 10px; border-top:1px solid #2e3040; font-size:11px; color:#9ca3af; }
    #getfish-panel .gf-part span:first-child { flex:1; }
    #getfish-panel .gf-len { color:#6b7280; font-variant-numeric:tabular-nums; }
    #getfish-panel .gf-seg.small { margin-bottom:12px; }
    #getfish-panel .gf-seg.small button { padding:5px 0; font-weight:500; font-size:12px; }
    #getfish-panel .gf-head-btns { display:flex; gap:4px; }
    #getfish-panel .gf-x:disabled { opacity:.4; cursor:wait; }
    #getfish-panel .gf-row { display:flex; align-items:center; gap:8px; margin-bottom:14px; font-size:12px; color:#d1d5db; flex-wrap:wrap; }
    #getfish-panel .gf-row select { background:#0d0e14; color:#e5e7eb; border:1px solid #2e3040; border-radius:6px; padding:4px 6px; font:inherit; }
    #getfish-panel .gf-row input { accent-color:#818cf8; }
    #getfish-panel .gf-need-only { display:none; }
    #getfish-panel.need .gf-need-only, #getfish-panel.nation .gf-need-only { display:flex; }
    #getfish-panel .gf-note { border:1px solid #713f12; background:#422006; color:#fde68a; border-radius:8px; padding:8px 10px; margin-bottom:10px; font-size:12px; }
    #getfish-panel .gf-note.muted { border-color:#2e3040; background:#1a1b25; color:#9ca3af; }
    #getfish-panel .gf-updated { font-size:11px; color:#6b7280; text-align:right; margin:-4px 0 8px; }
    #getfish-panel .gf-empty { color:#6b7280; text-align:center; padding:18px 0; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "getfish-panel";
  panel.innerHTML = `
    <div class="gf-head">
      <div><div class="gf-title">🎣 Fish Lists</div><div class="gf-sub">Copy-ready for Discord · v${VERSION}</div></div>
      <div class="gf-head-btns">
        <button class="gf-x gf-refresh" title="Refresh from the server">↻</button>
        <button class="gf-x gf-close" title="Close (Esc)">✕</button>
      </div>
    </div>
    <div class="gf-body">
      <div class="gf-seg gf-mode">
        <button data-mode="have">I have · Inventory</button>
        <button data-mode="need">I need · Mastery</button>
        <button data-mode="nation">Nations</button>
      </div>
      <label class="gf-row gf-need-only"><input type="checkbox" class="gf-subtract"> Subtract fish I already have</label>
      <div class="gf-label">Biomes</div>
      <div class="gf-row">From <select class="gf-from"></select> to <select class="gf-to"></select></div>
      <div class="gf-label">Rarities</div>
      <div class="gf-chips"></div>
      <div class="gf-links"><a data-sel="all">Select all</a><a data-sel="none">Clear</a></div>
      <div class="gf-label">Format</div>
      <div class="gf-seg small gf-fmt">
        <button data-fmt="full">Full (aligned table)</button>
        <button data-fmt="compact">Compact (one line each)</button>
      </div>
      <div class="gf-out"></div>
    </div>`;
  document.body.appendChild(panel);
  panel.querySelector(".gf-close").onclick = stop;
  // Esc closes the panel, but not while you are typing in the game (chat, search fields, ...)
  const onKey = e => {
    if (e.key !== "Escape") return;
    const el = document.activeElement;
    const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (typing && !panel.contains(el)) return;
    stop();
  };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));

  // Drag the panel by its header
  const head = panel.querySelector(".gf-head");
  head.onmousedown = e => {
    if (e.target.closest(".gf-x, .gf-head-btns")) return;
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => { panel.style.left = ev.clientX - dx + "px"; panel.style.top = ev.clientY - dy + "px"; panel.style.right = "auto"; };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      const i = cleanups.indexOf(up); if (i >= 0) cleanups.splice(i, 1);
    };
    cleanups.push(up);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const chips = panel.querySelector(".gf-chips");
  const out = panel.querySelector(".gf-out");
  // Each tab has its own rarity selection. Defaults: only Arcane and Exotic for "I have" and
  // Mastery, all rarities for "Nations". Your own changes are remembered per tab.
  const allRarities = () => new Set([...RARITIES, ...[...lists.have, ...(lists.need || []), ...(lists.nation || [])].map(f => f.rarity)]);
  const savedBy = saved.rarityDefaultsV2 || {};
  const pick = (tab, fallback) => Array.isArray(savedBy[tab]) ? new Set(savedBy[tab]) : fallback;
  const chosenBy = {
    have: pick("have", new Set(["Arcane", "Exotic"])),
    need: pick("need", new Set(["Arcane", "Exotic"])),
    nation: saved.nationPicked === true ? pick("nation", allRarities()) : allRarities(),
  };
  let chosen = chosenBy[mode];
  // Until you change the Nations selection yourself, every rarity found in your orders is selected
  let nationPicked = saved.nationPicked === true;
  onNationLoaded = () => { if (!nationPicked) lists.nation.forEach(f => chosenBy.nation.add(f.rarity)); };
  const raritiesIn = fish => [...RARITIES, ...new Set(fish.map(f => f.rarity).filter(r => !RARITIES.includes(r)))]
    .filter(r => fish.some(f => f.rarity === r));

  // Loading state per tab, so switching tabs while one is loading cannot block or break the other
  const loadingBy = { need: false, nation: false };
  const isLoading = () => loadingBy[mode] === true;
  const anyLoading = () => loadingBy.need || loadingBy.nation;
  const refreshBtn = panel.querySelector(".gf-refresh");
  const subtractBox = panel.querySelector(".gf-subtract");
  const fromSel = panel.querySelector(".gf-from"), toSel = panel.querySelector(".gf-to");

  async function ensureNation(force = false) {
    if (loadingBy.nation || (lists.nation && !force)) return;
    loadingBy.nation = true;
    refreshBtn.disabled = true;
    if (mode === "nation") { chips.innerHTML = ""; out.innerHTML = `<div class="gf-empty">Loading nation orders…</div>`; }
    await loadNation(force);
    if (!alive) return;
    loadingBy.nation = false;
    refreshBtn.disabled = anyLoading();
  }
  async function ensureNeed(force = false) {
    if (loadingBy.need || (lists.need && !force)) return;
    loadingBy.need = true;
    refreshBtn.disabled = true;
    if (mode === "need") chips.innerHTML = "";
    await loadNeed((i, n) => { if (mode === "need") out.innerHTML = `<div class="gf-empty">Loading Mastery… biome ${i} of ${n}</div>`; }, force);
    if (!alive) return;
    loadingBy.need = false;
    refreshBtn.disabled = anyLoading();
  }
  function setMode(m) {
    mode = m;
    chosen = chosenBy[mode];
    panel.classList.toggle("need", mode === "need");
    panel.classList.toggle("nation", mode === "nation");
    panel.querySelectorAll(".gf-mode button").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
    save();
  }
  panel.querySelectorAll(".gf-mode button").forEach(b => b.onclick = async () => {
    const tab = b.dataset.mode;
    setMode(tab);
    refreshAll(); // shows the tab right away (or its loading text)
    if (tab === "need") await ensureNeed();
    if (tab === "nation") await ensureNation();
    if (!alive) return;
    if (mode === tab) refreshAll(); // only redraw if you are still on this tab
    else { drawBiomes(); if (mode === "nation" && !isLoading()) render(); } // update the overlap note
  });
  panel.querySelectorAll(".gf-fmt button").forEach(b => {
    b.classList.toggle("on", b.dataset.fmt === format);
    b.onclick = () => {
      format = b.dataset.fmt;
      panel.querySelectorAll(".gf-fmt button").forEach(x => x.classList.toggle("on", x === b));
      save(); render();
    };
  });
  subtractBox.checked = subtractOwned;
  subtractBox.onchange = () => { subtractOwned = subtractBox.checked; save(); refreshAll(); };
  fromSel.onchange = toSel.onchange = () => { biomeFrom = fromSel.value; biomeTo = toSel.value; save(); refreshAll(); };

  // Refresh: fetch inventory again (1 request) and, if Mastery was loaded, Mastery again too
  refreshBtn.onclick = async () => {
    if (anyLoading()) return;
    refreshBtn.disabled = true;
    try {
      const p = await window.ApiService.getPlayerData();
      if (!alive) return;
      player = p;
      lists.have = haveFrom(p);
      fetchedAt.have = Date.now();
      refreshFailed = false;
    } catch { refreshFailed = true; }
    if (!alive) return;
    refreshBtn.disabled = false;
    if (lists.need || mode === "need") { lists.need = null; refreshAll(); await ensureNeed(true); if (!alive) return; }
    if (lists.nation || mode === "nation") { lists.nation = null; refreshAll(); await ensureNation(true); if (!alive) return; }
    refreshAll();
  };

  function userPicked() { if (mode === "nation") nationPicked = true; }
  function drawBiomes() {
    // All game biomes (plus any seen in the lists), so a saved range is always visible in the menus
    const ids = [...new Set([...Object.keys(window.BIOMES || {}), ...[...lists.have, ...(lists.need || []), ...(lists.nation || [])].map(f => String(f.biome))])]
      .filter(b => !isNaN(Number(b))).sort((a, b) => a - b);
    const opts = (sel, label) => `<option value="">${label}</option>` +
      ids.map(id => `<option value="${id}" ${String(sel) === String(id) ? "selected" : ""}>B${id} ${biomeName(id)}</option>`).join("");
    fromSel.innerHTML = opts(biomeFrom, "First");
    toSel.innerHTML = opts(biomeTo, "Last");
  }
  function refreshAll() { drawBiomes(); drawChips(); render(); }
  panel.querySelectorAll(".gf-links a").forEach(a => a.onclick = () => {
    const all = raritiesIn(view());
    a.dataset.sel === "all" ? all.forEach(r => chosen.add(r)) : chosen.clear();
    userPicked(); save(); drawChips(); render();
  });

  function drawChips() {
    chips.innerHTML = "";
    if (isLoading()) return;
    const fish = view();
    for (const r of raritiesIn(fish)) {
      const chip = document.createElement("button");
      chip.className = "gf-chip" + (chosen.has(r) ? " on" : "");
      chip.style.setProperty("--c", colorOf(r));
      chip.innerHTML = `<span class="dot" style="background:${paintOf(r)}"></span><span style="${textStyle(r)}">${r}</span><span class="n">${sum(fish.filter(f => f.rarity === r))}</span>`;
      chip.onclick = () => { chosen.has(r) ? chosen.delete(r) : chosen.add(r); userPicked(); save(); drawChips(); render(); };
      chips.appendChild(chip);
    }
  }

  function card(title, color, list) {
    const parts = listFor(list);
    const wrap = document.createElement("div");
    wrap.className = "gf-card";
    wrap.style.setProperty("--c", color);
    wrap.innerHTML = `<div class="gf-card-head"><span class="gf-card-title"></span></div>`;
    wrap.querySelector(".gf-card-title").innerHTML = `<span style="${RARITY_COLORS[title] ? textStyle(title) : ""}">${title}</span><span class="n">${list.length} type${list.length === 1 ? "" : "s"} · ${sum(list)} fish${parts.length > 1 ? ` · ${parts.length} messages` : ""}</span>`;
    parts.forEach((text, i) => {
      const box = document.createElement("div");
      box.innerHTML = `<div class="gf-part"><span>${parts.length > 1 ? `Message ${i + 1} of ${parts.length}` : ""}</span><span class="gf-len">${text.length}/${DISCORD_LIMIT}</span><button class="gf-copy">Copy</button></div><textarea readonly></textarea>`;
      const ta = box.querySelector("textarea");
      ta.value = text;
      const btn = box.querySelector(".gf-copy");
      btn.onclick = async () => {
        try { await navigator.clipboard.writeText(text); }
        catch { ta.select(); document.execCommand("copy"); }
        btn.textContent = "✓ Copied"; btn.classList.add("ok");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("ok"); }, 1500);
      };
      wrap.appendChild(box);
    });
    return wrap;
  }


  // Nations tab only (shown in the panel, never in the copied text): fish that Mastery also needs.
  // Fish you own are subtracted in both tabs, but each fish can only be handed in once.
  function overlapNote(fish) {
    const note = document.createElement("div");
    note.className = "gf-note";
    if (!lists.need) {
      note.classList.add("muted");
      note.textContent = "Open the Mastery tab once to check for fish that are needed in both places.";
      return note;
    }
    const same = (a, b) => a.name === b.name && String(a.biome) === String(b.biome);
    const both = fish.filter(f => lists.need.some(n => same(n, f)));
    if (!both.length) { note.remove(); return document.createDocumentFragment(); }
    const names = both.map(f => `${f.name} (B${f.biome})`).join(", ");
    note.textContent = `⚠ Also needed for Mastery: ${names}.` +
      (subtractOwned ? " Fish you own are subtracted in both tabs, but each fish can only be handed in once." : "");
    return note;
  }

  function render() {
    if (isLoading()) { out.innerHTML = `<div class="gf-empty">Loading…</div>`; return; }
    const fish = view();
    out.innerHTML = "";
    const info = document.createElement("div");
    info.className = "gf-updated";
    const at = fetchedAt[mode];
    if (at) {
      const min = Math.floor((Date.now() - at) / 60000);
      info.textContent = `Updated ${min < 1 ? "just now" : `${min} min ago`}`;
      out.appendChild(info);
    }
    if (refreshFailed) {
      const n = document.createElement("div");
      n.className = "gf-note";
      n.textContent = "⚠ Refresh failed, showing older inventory data. Try ↻ again.";
      out.appendChild(n);
    }
    const empty = msg => out.insertAdjacentHTML("beforeend", `<div class="gf-empty">${msg}</div>`);
    if (mode === "need" && !masteryOk) return empty("Could not fetch Mastery requirements. Try ↻.");
    if (mode === "need" && masteryFailed) {
      const n = document.createElement("div");
      n.className = "gf-note";
      n.textContent = `⚠ ${masteryFailed} biome(s) could not be loaded, so this list may be incomplete. Try ↻.`;
      out.appendChild(n);
    }
    if (mode === "nation" && !nationOk) return empty("Could not fetch nation orders. Try ↻.");
    if (!fish.length) return empty({ need: "Nothing missing for Mastery in these biomes.",
      nation: "No open nation orders in these biomes.", have: "No fish in these biomes." }[mode]);
    const sel = raritiesIn(fish).filter(r => chosen.has(r));
    if (!sel.length) return empty("Select at least one rarity above.");
    if (mode === "nation") out.appendChild(overlapNote(fish.filter(f => sel.includes(f.rarity))));
    for (const r of sel) out.appendChild(card(r, colorOf(r), fish.filter(f => f.rarity === r)));
    if (sel.length > 1) out.appendChild(card("All selected", "#818cf8", fish.filter(f => sel.includes(f.rarity))));
  }
  setMode(mode);
  refreshAll();
  const startTab = mode;
  if (startTab === "need") await ensureNeed();
  if (startTab === "nation") await ensureNation();
  if (!alive) return;
  if (startTab !== "have") refreshAll();
})();
