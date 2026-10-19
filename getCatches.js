// getCatches.js - paste into the browser console (F12) while logged in to the game.
// Version 2.9 (shown in the panel header, so you can tell if your bookmark is out of date).
// Collects Exotic and Arcane catch announcements from the game's "notification" chat channel
// for the guild tags (default [DUCK]) and/or players you choose in the panel,
// and lists them as full lines, copy-ready for Discord.
// Tabs: "New" (since you last copied), "All", "Time range" and "Report" (totals per player).
// Periods: today / yesterday (days start 00:00 UTC, server time), last N days, last N hours, or custom from/to.
// Uses ONE request per run (and per Refresh click): /chat/history/notification.
// While the panel is open it also listens to the game's catch-feed stream (no polling).
// Every Exotic/Arcane catch seen is saved in this browser (all guilds, so changing the tag works
// on older catches too). Use Export/Import to back up the saved catches or move them to another PC.
(async () => {
  const VERSION = "3.0";
  // Only one copy may run at a time: running the script again first closes the previous one.
  window.__getCatchesStop?.();
  let alive = true;
  let liveStream = null;
  let onStorage = null;
  const stop = () => {
    if (!alive) return;
    alive = false;
    try { liveStream?.close(); } catch {}
    if (onStorage) removeEventListener("storage", onStorage);
    document.getElementById("gc-panel")?.remove();
    document.getElementById("gc-style")?.remove();
    if (window.__getCatchesStop === stop) delete window.__getCatchesStop;
  };
  window.__getCatchesStop = stop;
  if (!window.ApiService) { alert("getCatches: open the game first, then run the script."); stop(); return; }

  // Only Exotic and Arcane catches are collected
  const RARITIES = ["Exotic", "Arcane"];

  // Stored in this browser only
  // Storage names are kept from when the script was called getCatchesDUCK, so saved catches carry over
  const SETTINGS_KEY = "getCatchesDUCK.settings";
  const ARCHIVE_KEY = "getCatchesDUCK.archive";   // all Exotic/Arcane catches seen, by message id
  const LAST_KEY = "getCatchesDUCK.lastSeen";     // time (ms) of the newest catch you copied in "New"
  const EXPORT_KEY = "getCatchesDUCK.lastExport"; // time (ms) of the last Export, for the backup reminder
  const MAX_ARCHIVE = 30000;
  const BACKUP_DAYS = 7;
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const settings = Object.assign({ tab: "new", showTime: false, rarities: null, from: "", to: "", extraNames: "", codeBlock: true, eventMode: "include", compare: false, tag: "DUCK", period: "today", periodN: 1, showFish: false, daily: false, minimized: false, pos: null }, load(SETTINGS_KEY, {}));
  const saveSettings = () => store(SETTINGS_KEY, settings);
  // Guild tags to include, comma separated (e.g. "DUCK, OOO")
  const tags = () => settings.tag.split(",").map(t => t.trim().replace(/^\[|\]$/g, "").toUpperCase()).filter(Boolean);
  const tagLabel = () => tags().length ? tags().map(t => `[${t}]`).join(" ") : (extraNames().size ? "Selected players" : "All guilds");

  // Full announcement line, e.g. "[DUCK] Eden - Newcomer caught an Exotic Thunder Behemoth from Autocasting!"
  // The game puts "🎣 " in front; drop it so each line starts with the guild tag
  const cleanText = (t) => String(t || "").replace(/^[\s\p{Extended_Pictographic}\uFE0F]*/u, "").trim();
  // "[TAG] Name - Title caught ..." or "Name caught ..." (no guild / no title)
  const tagOf = (text) => ((text.match(/^\[([^\]]*)\]/) || [])[1] || "").toUpperCase();
  // Titles come from the game's own achievement list, so a " - " inside a player name is kept.
  // (No title contains " - ".) Without the list, the text after the last " - " is taken as the title.
  const TITLES = new Set((window.ACHIEVEMENTS || []).flatMap(a => [a && a.title, a && a.name]).filter(Boolean));
  const nameOf = (text) => {
    const body = text.replace(/^\[[^\]]*\]\s*/, "").split(/ caught an? /)[0].trim();
    const i = body.lastIndexOf(" - ");
    if (i < 0) return body;
    if (!TITLES.size || TITLES.has(body.slice(i + 3).trim())) return body.slice(0, i).trim();
    return body; // the " - " is part of the name and the player has no title
  };
  const rarityOf = (text) => (text.match(/ caught an? (Exotic|Arcane)\b/) || [])[1] || "";
  const isCatch = (m) => / caught an? /.test(m.message_text || "");
  const toEntry = (id, at, text) => ({ id: String(id), at: Number(at) || 0, text, rarity: rarityOf(text), tag: tagOf(text), name: nameOf(text) });

  // Older versions stored only one guild and fewer fields; fill them in
  let lastSeen = load(LAST_KEY, 0);
  // "seen" = already copied in "New". It is tracked per catch (not by time), so older catches
  // filled in later by Import or Refresh still show up in "New". Imports never carry "seen" over.
  // Stored compactly as [id, at, text, seen]; the old object format is still read
  const loadArchive = () => load(ARCHIVE_KEY, []).map(c => Array.isArray(c) ? { id: c[0], at: c[1], text: c[2], seen: !!c[3] } : c).filter(c => c && c.text)
    .map(c => ({ ...toEntry(c.id, c.at, c.text), seen: c.seen ?? (Number(c.at) <= lastSeen) })).filter(c => c.rarity);
  let archive = loadArchive();
  const markSeen = (items) => {
    if (!items.length) return;
    for (const c of items) c.seen = true;
    lastSeen = Math.max(load(LAST_KEY, 0), lastSeen, ...items.map(c => c.at));
    store(LAST_KEY, lastSeen);
    saveArchive(items.map(c => c.id));
  };

  // "Last posted" from Discord: find the pasted line among the saved catches and make it the
  // dividing point for "New". Ignores ```, 🎣, extra spaces and a leading "YYYY-MM-DD HH:MM" time.
  // If several pasted lines are given, the last one is used.
  const normLine = (t) => cleanText(String(t).replace(/`/g, "")).replace(/^\d{4}-\d\d-\d\d \d\d:\d\d\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const setLastPosted = (pasted) => {
    const line = String(pasted).split(/\r?\n/).map(normLine).filter(Boolean).pop();
    if (!line) { notice = "Paste a catch line first."; return; }
    const hits = archive.filter(c => normLine(c.text) === line);
    if (!hits.length) { notice = "That catch was not found among the saved catches. Check the line, or Refresh/Import first if it is older."; return; }
    const hit = hits.reduce((a, b) => (b.at > a.at ? b : a));
    for (const c of archive) c.seen = c.at <= hit.at;
    lastSeen = hit.at;
    store(LAST_KEY, lastSeen);
    saveArchive(archive.map(c => c.id));
    const after = archive.filter(c => !c.seen).length;
    notice = `Found it (${fmtTime(hit.at)} UTC)${hits.length > 1 ? `; it matched ${hits.length} identical catches, so the newest was used` : ""}. ${after} saved catch${after === 1 ? "" : "es"} after it (all guilds, before filters).`;
  };

  // Is this catch from one of the chosen guilds or players? With both fields empty, everyone is included.
  const extraNames = () => new Set(settings.extraNames.split(",").map(n => n.trim().toLowerCase()).filter(Boolean));
  const wantedFn = () => {
    const t = tags(), n = extraNames();
    return (c) => (!t.length && !n.size) || t.includes(c.tag) || n.has(c.name.toLowerCase());
  };

  // Server times without a time zone are UTC
  const parseUtc = (v) => { const t = typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(" ", "T") + "Z" : v; return new Date(t).getTime() || 0; };
  let fetchError = "";
  let stats = "";
  let gapWarning = "";
  let notice = "";
  let lastTrimmed = 0; // catches dropped by the last save because of the MAX_ARCHIVE limit
  // Several tabs may run the script at once. Before saving, re-read what is stored and combine:
  // catches another tab added are kept, and only the catches changed here ("touched") override
  // the stored copy. The other tabs pick the result up through the "storage" event below.
  const saveArchive = (touched = []) => {
    const mine = new Set(touched.map(String));
    const byId = new Map(loadArchive().map(c => [c.id, c]));
    for (const c of archive) if (!byId.has(c.id) || mine.has(c.id)) byId.set(c.id, c);
    archive = [...byId.values()];
    archive.sort((a, b) => a.at - b.at);
    lastTrimmed = Math.max(0, archive.length - MAX_ARCHIVE);
    if (lastTrimmed) archive = archive.slice(-MAX_ARCHIVE);
    if (!store(ARCHIVE_KEY, archive.map(c => [c.id, c.at, c.text, c.seen ? 1 : 0]))) notice = "Browser storage is full: export your catches, then keep fewer.";
  };
  // Adds catches to the saved list (duplicates are skipped by id). Returns how many were new.
  const merge = (entries) => {
    const byId = new Map(archive.map(c => [c.id, c]));
    let added = 0;
    for (const e of entries) {
      if (!e.rarity || byId.has(e.id)) continue;
      // Always store "seen" explicitly, so a reload never guesses it from the time
      byId.set(e.id, { ...e, seen: false });
      added++;
    }
    if (added) { archive = [...byId.values()]; saveArchive(); } // new ids are kept by the combine step
    return added;
  };
  const fromMessages = (msgs) => msgs.filter(m => m && isCatch(m)).map(m => {
    const text = cleanText(m.message_text);
    return toEntry(m.id ?? `${m.created_at}|${text}`, parseUtc(m.created_at), text);
  });

  const refresh = async () => {
    fetchError = "";
    try {
      const r = await window.ApiService.getChatHistory("notification");
      const msgs = (r && (r.messages || r.data || (Array.isArray(r) ? r : null))) || [];
      window.__getCatchesLast = msgs; // for troubleshooting: inspect in the console
      const entries = fromMessages(msgs).filter(e => e.rarity);
      stats = `Last fetch: ${msgs.length} messages in the catch feed, ${entries.length} Exotic/Arcane, ${entries.filter(wantedFn()).length} from your chosen guilds/players.`;
      if (!msgs.length) fetchError = "The game returned no messages for the catch feed.";
      else if (!msgs.some(isCatch)) fetchError = `None of the ${msgs.length} messages could be read as catches. The game's message format may have changed.`;
      // Gap check: if even the oldest fetched message is newer than the newest catch saved before,
      // catches in between have dropped out of the game's history and are missing here.
      const before = archive.length ? archive[archive.length - 1].at : 0;
      const oldest = Math.min(...msgs.map(m => parseUtc(m.created_at)).filter(Boolean));
      gapWarning = before && msgs.length && oldest > before
        ? `Possible gap: catches between ${fmtTime(before)} and ${fmtTime(oldest)} UTC may be missing (they dropped out of the game's history before this run). Keep the panel open, or run the script more often.`
        : "";
      merge(entries);
    } catch (e) {
      fetchError = "Could not load the catch list: " + (e && e.message || e);
    }
  };
  // Another tab saved: load its catches and "seen" marks
  onStorage = (e) => {
    if (!alive || (e.key !== ARCHIVE_KEY && e.key !== LAST_KEY)) return;
    lastSeen = Math.max(lastSeen, load(LAST_KEY, 0));
    archive = loadArchive();
    if (!panel.contains(document.activeElement?.closest?.("input:not([type=checkbox]),select") || null)) render();
  };
  addEventListener("storage", onStorage);

  // While the panel is open, new catches arrive live from the game's catch-feed stream (no polling)
  const startLive = () => {
    try {
      if (typeof window.ApiService.createChatStream !== "function") return;
      // When the stream reconnects after a drop, fetch the history once to fill what was missed
      let dropped = false, lastFill = 0;
      const onDrop = () => { dropped = true; };
      const onOpen = async () => {
        if (!dropped || !alive || Date.now() - lastFill < 60e3) return;
        dropped = false; lastFill = Date.now();
        await refresh();
        if (alive && !panel.contains(document.activeElement?.closest?.("input:not([type=checkbox]),select") || null)) render();
      };
      liveStream = window.ApiService.createChatStream("notification", (m) => {
        if (!alive) return;
        // Skip re-drawing while you are typing in the panel, so your input is not lost
        if (merge(fromMessages([m])) && !panel.contains(document.activeElement?.closest?.("input:not([type=checkbox]),select") || null)) render();
      });
      liveStream?.addEventListener?.("error", onDrop);
      liveStream?.addEventListener?.("open", onOpen);
    } catch {}
  };

  // ---------- Formatting ----------
  const DISCORD_LIMIT = 2000;
  const pad = (n) => String(n).padStart(2, "0");
  // All times are shown and entered in UTC (the game's server time)
  const fmtTime = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  // Report lines have no time of their own
  const toLine = (c) => settings.showTime && c.at != null ? `${fmtTime(c.at)}  ${c.text}` : c.text;
  // Splits lines into Discord messages under the 2000-character limit.
  // Each part keeps its own catches, so copying one part only marks that part as seen.
  const toParts = (list) => {
    const out = [];
    let cur = [];
    const wrap = (cs) => { const t = cs.map(toLine).join("\n"); return settings.codeBlock ? "```\n" + t + "\n```" : t; };
    const push = () => out.push({ text: wrap(cur), items: cur });
    for (const c of list) {
      if (cur.length && wrap([...cur, c]).length > DISCORD_LIMIT) { push(); cur = []; }
      cur.push(c);
    }
    if (cur.length) push();
    return out;
  };

  // Period for "Time range" and "Report". Days start at 00:00 UTC (server time).
  const PERIODS = { today: "Today (since 00:00 UTC)", yesterday: "Yesterday (full day)", days: "Last N days (incl. today)", hours: "Last N hours", custom: "Custom from/to" };
  const periodRange = () => {
    const now = Date.now();
    const midnight = Math.floor(now / 864e5) * 864e5; // today 00:00 UTC
    const n = Math.max(1, +settings.periodN || 1);
    switch (settings.period) {
      case "yesterday": return { from: midnight - 864e5, to: midnight - 1 };
      case "days": return { from: midnight - (n - 1) * 864e5, to: now };
      case "hours": return { from: now - n * 3600e3, to: now };
      case "custom": return {
        from: settings.from ? new Date(settings.from + "Z").getTime() : -Infinity,
        to: settings.to ? new Date(settings.to + "Z").getTime() : Infinity };
      default: return { from: midnight, to: now };
    }
  };
  const periodText = () => {
    const { from, to } = periodRange();
    const label = settings.period === "days" ? `Last ${settings.periodN} day${settings.periodN == 1 ? "" : "s"}` : settings.period === "hours" ? `Last ${settings.periodN}h` : settings.period === "custom" ? "Custom" : PERIODS[settings.period].split(" (")[0];
    return `${label} (${isFinite(from) ? fmtTime(from) : "start"} - ${isFinite(to) ? fmtTime(to) : "now"} UTC)`;
  };

  const selected = () => {
    const rar = new Set(settings.rarities || RARITIES);
    const want = wantedFn();
    let list = archive.filter(c => rar.has(c.rarity) && want(c));
    if (settings.tab === "new") list = list.filter(c => !c.seen);
    if (settings.tab === "range" || settings.tab === "report") {
      const { from, to } = periodRange();
      list = list.filter(c => c.at >= from && c.at <= to);
    }
    return list;
  };

  // Same-length period right before the chosen one, for "Compare with previous period"
  let prevStats = null; // { total, per: Map(display name -> total) }
  const computePrev = (keep) => {
    const { from, to } = periodRange();
    if (!settings.compare || !isFinite(from)) return null;
    const len = Math.min(to, Date.now()) - from;
    if (len <= 0) return null;
    const rar = new Set(settings.rarities || RARITIES), want = wantedFn();
    const list = archive.filter(c => rar.has(c.rarity) && want(c) && c.at >= from - len && c.at < from && keep(c));
    const per = new Map();
    for (const c of list) { const k = c.tag ? `[${c.tag}] ${c.name}` : c.name; per.set(k, (per.get(k) || 0) + 1); }
    return { total: list.length, per };
  };
  const delta = (cur, prev) => { const d = cur - prev; return d > 0 ? `+${d}` : d < 0 ? `${d}` : "±0"; };
  const prevNote = (name, cur) => !prevStats ? "" : prevStats.per.has(name) ? ` (${delta(cur, prevStats.per.get(name))})` : " (new)";

  // Report: totals per player for the last N hours, most catches first
  const reportLines = (list, ev = null) => {
    const rar = RARITIES.filter(r => (settings.rarities || RARITIES).includes(r)).reverse(); // Arcane first
    // How it was caught: "... from Autocasting!" = auto, no "from" = manual, any other "from X" = event (e.g. Event Exchange)
    const methodOf = (text) => { const m = text.match(/ from (.+?)!?$/); return !m ? "manual" : /autocast/i.test(m[1]) ? "auto" : "other"; };
    // Counts per rarity and method, e.g. p.by.Arcane = { auto: 2, manual: 1 }
    const add = (p, c) => { const k = methodOf(c.text); p.by = p.by || {}; const b = p.by[c.rarity] = p.by[c.rarity] || {}; b[k] = (b[k] || 0) + 1; };
    const LABEL = { auto: "AC", manual: "manual", other: "event" };
    const methods = (b) => ["auto", "manual", "other"].filter(k => b[k]).map(k => `${b[k]} ${LABEL[k]}`).join(", ");
    const per = new Map();
    for (const c of list) {
      const key = `${c.tag}|${c.name}`;
      const p = per.get(key) || { key, name: c.tag ? `[${c.tag}] ${c.name}` : c.name, total: 0 };
      p[c.rarity] = (p[c.rarity] || 0) + 1;
      p.total++;
      add(p, c);
      per.set(key, p);
    }
    const rows = [...per.values()].sort((a, b) => b.total - a.total || (b.Arcane || 0) - (a.Arcane || 0) || a.name.localeCompare(b.name));
    // e.g. "1 Arcane (1 manual), 2 Exotic (1 AC, 1 manual)"
    const count = (p) => rar.filter(r => p[r]).map(r => `${p[r]} ${r} (${methods(p.by[r])})`).join(", ");
    const sum = { total: list.length };
    for (const c of list) { sum[c.rarity] = (sum[c.rarity] || 0) + 1; add(sum, c); }
    // Fish name: "... caught an Arcane <fish> from X!" or "... caught an Arcane <fish>!"
    const fishOf = (c) => (c.text.match(/ caught an? (?:Exotic|Arcane) (.+?)(?: from [^!]+)?!?$/) || [])[1] || "?";
    const fishLines = (key) => !settings.showFish ? [] : rar.map(r => {
      const fish = list.filter(c => `${c.tag}|${c.name}` === key && c.rarity === r).map(fishOf);
      return fish.length ? { text: `   ${r}: ${fish.join(", ")}` } : null;
    }).filter(Boolean);
    // Leaderboard per day (UTC days), newest first, with the top 3 players of each day
    const dayLines = () => {
      if (!settings.daily) return [];
      const days = new Map();
      for (const c of list) { const d = fmtTime(c.at).slice(0, 10); (days.get(d) || days.set(d, []).get(d)).push(c); }
      return [{ text: "" }, { text: "Per day (UTC):" }, ...[...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, cs]) => {
        const s = { total: cs.length };
        const who = new Map();
        for (const c of cs) { s[c.rarity] = (s[c.rarity] || 0) + 1; add(s, c); const k = c.tag ? `[${c.tag}] ${c.name}` : c.name; who.set(k, (who.get(k) || 0) + 1); }
        const top = [...who.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ");
        return { text: `${d}: ${s.total} - ${count(s)} · top: ${top}` };
      })];
    };
    return [
      { text: `${tagLabel()}${extraNames().size && tags().length ? " + selected players" : ""} Exotic/Arcane catches · ${periodText()}` },
      { text: `Total: ${sum.total} from ${rows.length} player${rows.length === 1 ? "" : "s"}${sum.total ? ` - ${count(sum)}` : ""}` },
      ...(prevStats && !list.isEvent ? [{ text: `Previous period: ${prevStats.total} (${delta(sum.total, prevStats.total)}) · per player change in brackets` }] : []),
      { text: "" },
      ...rows.flatMap(p => [{ text: `${p.name}: ${p.total}${list.isEvent ? "" : prevNote(p.name, p.total)} - ${count(p)}` }, ...fishLines(p.key)]),
      ...dayLines(),
      ...(ev ? [{ text: "" }, { text: `Event catches (not counted above): ${ev.length}` },
        ...reportLines(Object.assign([...ev], { isEvent: true })).slice(3).filter(l => l.text && !/^Per day|^\d{4}-/.test(l.text))] : []),
    ];
  };

  // ---------- Report as an image (drawn in the browser, no extra requests) ----------
  // Rarity colours come from the game itself (window.RARITY_COLORS); Exotic and Arcane are gradients there
  const GAME_COLORS = window.RARITY_COLORS || {};
  const COLORS = {
    Exotic: GAME_COLORS.Exotic || "linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)",
    Arcane: GAME_COLORS.Arcane || "linear-gradient(135deg, #a855f7 0%, #ec4899 50%, #f59e0b 100%)",
    auto: "#5865f2", manual: "#b5bac1", other: GAME_COLORS.Event || "#10b981",
  };
  const METHOD_LABEL = { auto: "AC", manual: "Manual", other: "Event" };
  const methodOfText = (text) => { const m = text.match(/ from (.+?)!?$/); return !m ? "manual" : /autocast/i.test(m[1]) ? "auto" : "other"; };
  // ev: event catches to show in their own section (when "Event catches: separate")
  const drawReport = (list, ev = null, evCount = 0) => {
    const rar = RARITIES.filter(r => (settings.rarities || RARITIES).includes(r)).reverse(); // Arcane first
    const per = new Map(), days = new Map(), sum = { total: list.length, auto: 0, manual: 0, other: 0 };
    for (const c of list) {
      const key = c.tag ? `[${c.tag}] ${c.name}` : c.name, m = methodOfText(c.text);
      const p = per.get(key) || { name: key, total: 0, auto: 0, manual: 0, other: 0 };
      p[c.rarity] = (p[c.rarity] || 0) + 1; p.total++; p[m]++; per.set(key, p);
      sum[c.rarity] = (sum[c.rarity] || 0) + 1; sum[m]++;
      const d = fmtTime(c.at).slice(0, 10), dd = days.get(d) || { day: d, total: 0 };
      dd[c.rarity] = (dd[c.rarity] || 0) + 1; dd.total++; days.set(d, dd);
    }
    const MAX_ROWS = 25;
    const sortRows = (a, b) => b.total - a.total || (b.Arcane || 0) - (a.Arcane || 0) || a.name.localeCompare(b.name);
    const evPer = new Map();
    for (const c of ev || []) {
      const key = c.tag ? `[${c.tag}] ${c.name}` : c.name, p = evPer.get(key) || { name: key, total: 0, other: 0 };
      p[c.rarity] = (p[c.rarity] || 0) + 1; p.total++; p.other++; evPer.set(key, p);
    }
    const evRows = [...evPer.values()].sort(sortRows);
    const rows = [...per.values()].sort((a, b) => b.total - a.total || (b.Arcane || 0) - (a.Arcane || 0) || a.name.localeCompare(b.name));
    const shown = rows.slice(0, MAX_ROWS);
    const dayList = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    const showDays = dayList.length > 1 || settings.daily;

    const W = 1000, PAD = 40, ROW = 30;
    const H = 252 + 60 + Math.max(1, shown.length) * ROW + (rows.length > MAX_ROWS ? 30 : 0) + (showDays ? 330 : 0) + 50
      + (ev ? 70 + Math.max(1, Math.min(evRows.length, MAX_ROWS)) * ROW + (evRows.length > MAX_ROWS ? 30 : 0) : 0);
    const cv = document.createElement("canvas");
    cv.width = W * 2; cv.height = H * 2; // 2x for sharp text
    const g = cv.getContext("2d");
    g.scale(2, 2);
    const font = (px, w = 400) => `${w} ${px}px system-ui, "Segoe UI", sans-serif`;
    // A CSS colour, or a CSS "linear-gradient(...)" turned into a canvas gradient across the given box
    const paint = (color, x, y, w, h) => {
      if (!/^linear-gradient/.test(color)) return color;
      const stops = [...color.matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*([\d.]+)%/gi)];
      if (!stops.length) return "#ffffff";
      const gr = g.createLinearGradient(x, y, x + w, y + h);
      for (const [, c, pct] of stops) gr.addColorStop(Math.min(1, +pct / 100), c);
      return gr;
    };
    const text = (s, x, y, px, color, w, align = "left") => {
      g.font = font(px, w); g.textAlign = align;
      const tw = g.measureText(s).width, x0 = align === "center" ? x - tw / 2 : align === "right" ? x - tw : x;
      g.fillStyle = paint(color, x0, y - px, tw, px); g.fillText(s, x, y);
    };
    const rr = (x, y, w, h, r, color) => { g.fillStyle = paint(color, x, y, w, h); g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); g.fill(); };
    const fit = (s, maxW, px, w) => { g.font = font(px, w); if (g.measureText(s).width <= maxW) return s; while (s.length > 1 && g.measureText(s + "…").width > maxW) s = s.slice(0, -1); return s + "…"; };

    // Background and header
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#1e1f22"); bg.addColorStop(1, "#151619");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = paint(COLORS.Arcane, 0, 0, W, 0); g.fillRect(0, 0, W, 6);
    text(`🦆 ${tagLabel()} · Exotic/Arcane catches`, PAD, 58, 28, "#ffffff", 700);
    text(periodText() + (prevStats ? ` · previous period: ${prevStats.total} (${delta(list.length, prevStats.total)})` : ""), PAD, 88, 16, "#b5bac1", 400);

    // Stat tiles
    // Stat tiles in three groups: overview, rarity, how it was caught
    const groups = [
      ["Overview", [["Catches", sum.total, "#ffffff"], ["Players", rows.length, "#ffffff"]]],
      ["Rarity", rar.map(r => [r, sum[r] || 0, COLORS[r]])],
      ["How caught", ["auto", "manual", "other"].map(k => k === "other" && settings.eventMode !== "include"
        ? [settings.eventMode === "separate" ? "Event (separate)" : "Event (left out)", evCount, COLORS[k]]
        : [METHOD_LABEL[k], sum[k], COLORS[k]])],
    ];
    const cells = groups.reduce((n, [, t]) => n + t.length, 0), GAP = 14;
    const unit = (W - PAD * 2 - GAP * (groups.length - 1)) / cells;
    let gx = PAD;
    for (const [title, tiles] of groups) {
      const gw = unit * tiles.length;
      rr(gx, 108, gw, 112, 12, "#2b2d31");
      text(title.toUpperCase(), gx + 16, 130, 11, "#80848e", 700);
      tiles.forEach(([label, v, color], i) => {
        const cx = gx + unit * i + unit / 2;
        if (i) { g.fillStyle = "#3f4147"; g.fillRect(gx + unit * i, 142, 1, 60); }
        text(String(v), cx, 178, 30, color, 800, "center");
        text(label, cx, 202, 13, "#b5bac1", 600, "center");
      });
      gx += gw + GAP;
    }

    // Per-player stacked bars
    let y = 262;
    text("Catches per player", PAD, y, 18, "#ffffff", 700);
    let lx = W - PAD;
    for (const r of [...rar].reverse()) { g.font = font(13, 600); const tw2 = g.measureText(r).width; lx -= tw2; text(r, lx, y, 13, "#b5bac1", 600); lx -= 18; rr(lx, y - 11, 12, 12, 3, COLORS[r]); lx -= 14; }
    y += 20;
    const nameW = 260, countW = 210, barX = PAD + nameW, barW = W - PAD * 2 - nameW - countW;
    // Draws one row per player (stacked rarity bar, total, AC/Manual/Event); returns the next y
    const playerBars = (all, y) => {
      const list2 = all.slice(0, MAX_ROWS), max = Math.max(1, ...list2.map(p => p.total));
      list2.forEach((p, i) => {
        const yy = y + i * ROW;
        if (i % 2 === 0) rr(PAD - 8, yy, W - PAD * 2 + 16, ROW, 6, "#ffffff08");
        text(`${i + 1}.`, PAD + 22, yy + 20, 14, "#80848e", 600, "right");
        text(fit(p.name, nameW - 40, 15, 600), PAD + 30, yy + 20, 15, "#dbdee1", 600);
        let x = barX;
        for (const r of rar) {
          const w = (p[r] || 0) / max * barW;
          if (w > 0) { rr(x, yy + 7, Math.max(w - 2, 2), ROW - 14, 4, COLORS[r]); x += w; }
        }
        text(String(p.total), x + 8, yy + 20, 14, "#ffffff", 700);
        if (prevStats && !all.isEvent) {
          const old = prevStats.per.get(p.name), d = old == null ? null : p.total - old;
          const tw = (g.font = "700 14px sans-serif", g.measureText(String(p.total)).width);
          text(d == null ? "new" : d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "=", x + 14 + tw, yy + 20, 12, d == null ? "#949ba4" : d > 0 ? "#23a55a" : d < 0 ? "#f23f43" : "#949ba4", 700);
        }
        const m = ["auto", "manual", "other"].filter(k => p[k]).map(k => `${p[k]} ${METHOD_LABEL[k]}`).join(" · ");
        text(m, W - PAD, yy + 20, 13, "#949ba4", 400, "right");
      });
      y += list2.length * ROW;
      if (all.length > MAX_ROWS) { text(`… and ${all.length - MAX_ROWS} more players`, PAD + 30, y + 22, 14, "#949ba4", 400); y += 30; }
      return y;
    };
    y = playerBars(rows, y);
    if (!rows.length) { text("No catches", PAD + 30, y + 22, 14, "#949ba4", 400); y += 30; }

    // Event catches in their own section
    if (ev) {
      y += 50;
      text(`Event catches (not counted above): ${ev.length}`, PAD, y, 18, "#ffffff", 700);
      y += 20;
      y = evRows.length ? playerBars(Object.assign(evRows, { isEvent: true }), y) : (text("None in this period", PAD + 30, y + 22, 14, "#949ba4", 400), y + 30);
    }

    // Per-day columns
    if (showDays) {
      y += 50;
      text("Catches per day (UTC)", PAD, y, 18, "#ffffff", 700);
      const top = y + 30, ch = 220, cw = W - PAD * 2;
      const dmax = Math.max(1, ...dayList.map(d => d.total));
      g.strokeStyle = "#3f4147"; g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) { const gy = top + ch - ch * k / 4; g.beginPath(); g.moveTo(PAD, gy); g.lineTo(W - PAD, gy); g.stroke(); }
      const slot = cw / dayList.length, bw = Math.min(60, slot * 0.6);
      dayList.forEach((d, i) => {
        const cx = PAD + slot * i + slot / 2;
        let yb = top + ch;
        for (const r of rar) { const h = (d[r] || 0) / dmax * ch; if (h > 0) { rr(cx - bw / 2, yb - h, bw, Math.max(h - 2, 2), 4, COLORS[r]); yb -= h; } }
        text(String(d.total), cx, yb - 8, 13, "#ffffff", 700, "center");
        if (dayList.length <= 31 && (dayList.length <= 14 || i % 2 === 0)) text(d.day.slice(5), cx, top + ch + 20, 12, "#949ba4", 400, "center");
      });
      y = top + ch + 30;
    }

    text(`Generated ${fmtTime(Date.now())} UTC · getCatches v${VERSION}`, W - PAD, H - 18, 12, "#6d6f78", 400, "right");
    return cv;
  };
  // Copy the report image to the clipboard (falls back to a download where the browser can't)
  const copyReportPng = (list, ev, evCount) => {
    drawReport(list, ev, evCount).toBlob(async (blob) => {
      try {
        if (!blob || !window.ClipboardItem) throw new Error();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        notice = "Report image copied: paste it in Discord with Ctrl+V.";
      } catch { notice = "This browser can't copy images, so the PNG was downloaded instead."; downloadReportPng(list, ev, evCount); }
      render();
    }, "image/png");
  };
  const downloadReportPng = (list, ev, evCount) => {
    const cv = drawReport(list, ev, evCount);
    cv.toBlob((blob) => {
      if (!blob) { notice = "Could not create the image."; render(); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `catches-report-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };

  // ---------- Export / import (JSON file with the saved catches) ----------
  const exportArchive = () => {
    const blob = new Blob([JSON.stringify({ app: "getCatches", version: VERSION, exported: new Date().toISOString(), catches: archive })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `getCatches-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    store(EXPORT_KEY, Date.now());
    notice = `Exported ${archive.length} catches.`;
  };
  // Import one or more exported files (e.g. from guild mates). Catches are matched by the game's
  // message id, which is the same for everyone, so overlapping files never create duplicates.
  const importArchive = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.onchange = async () => {
      let total = 0, added = 0, trimmed = 0;
      const failed = [];
      for (const f of input.files) {
        try {
          const data = JSON.parse(await f.text());
          const list = Array.isArray(data) ? data : data.catches;
          if (!Array.isArray(list)) throw new Error("no catches found");
          total += list.length;
          lastTrimmed = 0;
          added += merge(list.filter(c => c && c.text).map(c => toEntry(c.id, c.at, c.text)));
          trimmed += lastTrimmed;
        } catch (e) {
          failed.push(`${f.name} (${e && e.message || e})`);
        }
      }
      notice = `Imported ${added} new catches from ${input.files.length - failed.length} file(s); ${total - added} were already saved or skipped.`
        + (trimmed ? ` The ${trimmed} oldest catches were dropped to stay within the ${MAX_ARCHIVE} limit.` : "")
        + (failed.length ? ` Failed: ${failed.join(", ")}.` : "");
      render();
    };
    input.click();
  };

  // ---------- GUI ----------
  const style = document.createElement("style");
  style.id = "gc-style";
  style.textContent = `
    #gc-panel{position:fixed;top:40px;right:20px;width:540px;max-width:calc(100vw - 32px);max-height:calc(100vh - 60px);overflow:auto;z-index:999999;background:#1e1f22;color:#dbdee1;font:13px/1.4 system-ui,sans-serif;border:1px solid #3f4147;border-radius:12px;box-shadow:0 10px 36px #000b;padding:14px;box-sizing:border-box}
    #gc-panel *{box-sizing:border-box}
    #gc-panel button{background:#5865f2;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
    #gc-panel button:hover{filter:brightness(1.1)}
    #gc-panel button:disabled{opacity:.6;cursor:default}
    #gc-panel button.gc-2{background:#3a3c42}
    #gc-panel input,#gc-panel select{background:#2b2d31;color:#dbdee1;border:1px solid #4e5058;border-radius:6px;padding:5px 8px;font:inherit}
    #gc-panel input[type=checkbox]{padding:0;margin:0 4px 0 0;accent-color:#5865f2}
    #gc-panel textarea{width:100%;height:150px;background:#2b2d31;color:#dbdee1;border:1px solid #4e5058;border-radius:6px;font:12px/1.4 Consolas,monospace;padding:8px;resize:vertical}
    #gc-panel .gc-head{cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
    #gc-panel .gc-title{font-size:16px;font-weight:700}
    #gc-panel .gc-tabs{display:flex;gap:4px;background:#2b2d31;border-radius:8px;padding:4px;margin-bottom:10px}
    #gc-panel .gc-tabs button{flex:1;background:transparent;color:#b5bac1;padding:6px 4px}
    #gc-panel .gc-tabs button.on{background:#5865f2;color:#fff}
    #gc-panel .gc-card{background:#2b2d31;border-radius:8px;padding:10px;margin-bottom:8px}
    #gc-panel .gc-card h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#949ba4}
    #gc-panel .gc-card input:not([type=checkbox]),#gc-panel .gc-card select{background:#1e1f22}
    #gc-panel .gc-grid{display:grid;grid-template-columns:70px 1fr;gap:6px 8px;align-items:center}
    #gc-panel .gc-row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
    #gc-panel .gc-sub{color:#949ba4;font-size:11px}
    #gc-panel .gc-msg{border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:12px}
    #gc-panel .gc-ok{background:#23a55a26;color:#7ee2a8}
    #gc-panel .gc-err{background:#f2333326;color:#ff8a8a}
    #gc-panel .gc-warn{background:#f0b23226;color:#ffcf6e}
    #gc-panel .gc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
    #gc-panel .gc-part{display:flex;justify-content:space-between;align-items:center;margin:8px 0 4px}
    #gc-panel .gc-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid #3f4147;margin-top:10px;padding-top:10px}
    #gc-panel label{white-space:nowrap;cursor:pointer}`;
  document.head.appendChild(style);
  const panel = document.createElement("div");
  panel.id = "gc-panel";
  document.body.appendChild(panel);
  // Drag the panel by its header; the position is remembered
  const placePanel = () => {
    if (!settings.pos) return;
    const x = Math.max(0, Math.min(settings.pos.x, innerWidth - 120)), y = Math.max(0, Math.min(settings.pos.y, innerHeight - 40));
    Object.assign(panel.style, { left: x + "px", top: y + "px", right: "auto" });
  };
  panel.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".gc-head") || e.target.closest("button")) return;
    const r0 = panel.getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top;
    const move = (ev) => { settings.pos = { x: ev.clientX - dx, y: ev.clientY - dy }; placePanel(); };
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); saveSettings(); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    e.preventDefault();
  });

  const TABS = { new: "New", all: "All", range: "Time range", report: "Report" };
  const TAB_HELP = {
    new: "Catches since the last one you copied here. Copying a part marks it as seen.",
    all: "Every saved catch that matches your filter.",
    range: "Catches within the chosen period.",
    report: "Totals per player within the chosen period.",
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const render = () => {
    if (!alive) return;
    const list = selected();
    const isReport = settings.tab === "report";
    const hasPeriod = settings.tab === "range" || isReport;
    // Event catches ("... from Event Exchange!" etc.) can be counted, left out, or shown separately in the Report
    const evList = isReport && settings.eventMode !== "include" ? list.filter(c => methodOfText(c.text) === "other") : [];
    const repList = evList.length ? list.filter(c => methodOfText(c.text) !== "other") : list;
    const repEv = settings.eventMode === "separate" ? evList : null;
    prevStats = isReport ? computePrev(c => settings.eventMode === "include" || methodOfText(c.text) !== "other") : null;
    const parts = toParts(isReport ? reportLines(repList, repEv) : list);
    const msgs = parts.map(p => p.text);
    const rar = new Set(settings.rarities || RARITIES);
    const n = list.length;
    panel.innerHTML = `
      <div class="gc-head">
        <div><div class="gc-title">🦆 ${esc(tagLabel())} Catches</div>
          <div class="gc-sub">v${VERSION} · <span class="gc-dot" style="background:${liveStream ? "#23a55a" : "#80848e"}"></span>${liveStream ? "Live" : "Not live"} · ${archive.length} saved in this browser</div></div>
        <div><button id="gc-refresh" title="Fetch the latest catches from the game (1 request)">↻ Refresh</button> <button id="gc-min" class="gc-2" title="${settings.minimized ? "Expand" : "Minimize"}">${settings.minimized ? "▢" : "–"}</button> <button id="gc-close" class="gc-2" title="Close">✕</button></div>
      </div>${settings.minimized ? "" : `
<div class="gc-tabs">${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}" class="${settings.tab === k ? "on" : ""}">${v}</button>`).join("")}</div>
      <div class="gc-sub" style="margin:-4px 2px 8px">${TAB_HELP[settings.tab]}</div>

      ${settings.tab === "new" ? `<div class="gc-card"><h4>Seen</h4><div class="gc-row" style="justify-content:space-between">
        <span>Last copied up to: <b>${lastSeen ? fmtTime(lastSeen) + " UTC" : "never"}</b></span>
        <button id="gc-seen" class="gc-2" ${n ? "" : "disabled"}>Mark all as seen</button></div>
        <div class="gc-row" style="margin-top:8px"><input type="text" id="gc-lastpost" placeholder="Paste the last catch line you posted on Discord" style="flex:1"><button id="gc-lastpost-go">Set</button></div>
        <div class="gc-sub">Everything after that catch becomes New; it and everything before it is marked as seen.</div></div>` : ""}

      ${hasPeriod ? `<div class="gc-card"><h4>Period (UTC, days start 00:00)</h4><div class="gc-row">
        <select id="gc-period">${Object.entries(PERIODS).map(([k, v]) => `<option value="${k}" ${settings.period === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        ${settings.period === "days" || settings.period === "hours" ? `<label>N = <input type="number" id="gc-n" min="1" max="${settings.period === "days" ? 365 : 8760}" value="${settings.periodN}" style="width:70px"></label>` : ""}</div>
        ${settings.period === "custom" ? `<div class="gc-grid" style="margin-top:8px"><span>From</span><input type="datetime-local" id="gc-from" value="${esc(settings.from)}"><span>To</span><input type="datetime-local" id="gc-to" value="${esc(settings.to)}"></div>` : ""}
        <div class="gc-sub" style="margin-top:6px">${esc(periodText())}</div></div>` : ""}

      <div class="gc-card"><h4>Filter</h4>
        <div class="gc-grid">
          <span>Guilds</span><input type="text" id="gc-tag" placeholder="e.g. DUCK, OOO" value="${esc(settings.tag)}">
          <span>Players</span><input type="text" id="gc-names" placeholder="e.g. LockedIn, Denhasz" value="${esc(settings.extraNames)}">
          <span>Rarity</span><div class="gc-row">${RARITIES.map(r => `<label><input type="checkbox" data-rar="${r}" ${rar.has(r) ? "checked" : ""}>${r}</label>`).join("")}</div>
        </div>
        <div class="gc-row" style="justify-content:space-between;margin-top:8px">
          <span class="gc-sub">Comma separated. Matches any guild or player. Both empty = everyone.</span>
          <button id="gc-apply">Apply</button></div></div>

      <div class="gc-card"><h4>Output</h4><div class="gc-row">
        <label><input type="checkbox" id="gc-code" ${settings.codeBlock ? "checked" : ""}>Discord code block (\`\`\`)</label>
        ${isReport ? `<label><input type="checkbox" id="gc-fish" ${settings.showFish ? "checked" : ""}>Fish names per player</label>
        <label><input type="checkbox" id="gc-daily" ${settings.daily ? "checked" : ""}>Per-day leaderboard</label>
        <label>Event catches: <select id="gc-event">${[["include", "Count them"], ["exclude", "Leave out"], ["separate", "Show separately"]].map(([k, v]) => `<option value="${k}" ${settings.eventMode === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <button id="gc-png" ${n ? "" : "disabled"} title="Download the report as an image with charts">⬇ Download PNG</button>
        <button id="gc-copypng" ${n ? "" : "disabled"} title="Copy the report image to the clipboard, ready to paste in Discord">⧉ Copy PNG</button>
        <label title="Show the change (+/-) against the same-length period right before this one"><input type="checkbox" id="gc-compare" ${settings.compare ? "checked" : ""}>Compare with previous period</label>`
        : `<label><input type="checkbox" id="gc-time" ${settings.showTime ? "checked" : ""}>Time on each line (UTC)</label>`}</div></div>

      ${notice ? `<div class="gc-msg gc-ok">${esc(notice)}</div>` : ""}
      ${fetchError ? `<div class="gc-msg gc-err">${esc(fetchError)}</div>` : ""}
      ${(() => { const t = load(EXPORT_KEY, 0); return archive.length && Date.now() - t > BACKUP_DAYS * 864e5 ? `<div class="gc-msg gc-warn">⚠ ${t ? `Last export was ${Math.floor((Date.now() - t) / 864e5)} days ago` : "You have never exported"}. Export a backup so your saved catches are safe if browser data is cleared.</div>` : ""; })()}
      ${gapWarning ? `<div class="gc-msg gc-warn">⚠ ${esc(gapWarning)}</div>` : ""}

      <div class="gc-row" style="justify-content:space-between;margin-top:4px"><b>${n} catch${n === 1 ? "" : "es"}</b>
        ${msgs.length > 1 ? `<span class="gc-sub">Split into ${msgs.length} Discord messages (2000-char limit)</span>` : ""}</div>
      ${n ? parts.map((p, i) => `
        <div class="gc-part"><span class="gc-sub">${msgs.length > 1 ? `Part ${i + 1}/${msgs.length} · ` : ""}${p.text.length} chars</span><button data-copy="${i}">Copy${msgs.length > 1 ? ` part ${i + 1}` : ""}</button></div>
        <textarea readonly data-text="${i}"></textarea>`).join("") : `<div class="gc-sub" style="margin:10px 0">Nothing to show for this tab and filter.</div>`}

      <div class="gc-foot"><span class="gc-sub" title="${esc(stats)}">${esc(stats)}</span>
        <span style="white-space:nowrap"><button id="gc-export" class="gc-2" title="Download all saved catches as a JSON file">Export</button> <button id="gc-import" class="gc-2" title="Add catches from an exported JSON file">Import</button></span></div>`}`;
    placePanel();
    panel.querySelectorAll("textarea[data-text]").forEach(t => { t.value = msgs[+t.dataset.text]; });

    const on = (sel, ev, fn) => { const el = panel.querySelector(sel); if (el) el[ev] = fn; };
    on("#gc-close", "onclick", stop);
    on("#gc-refresh", "onclick", async (e) => { e.target.disabled = true; e.target.textContent = "Loading..."; notice = ""; await refresh(); render(); });
    panel.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { settings.tab = b.dataset.tab; notice = ""; saveSettings(); render(); });
    panel.querySelectorAll("[data-rar]").forEach(cb => cb.onchange = () => {
      settings.rarities = [...panel.querySelectorAll("[data-rar]")].filter(x => x.checked).map(x => x.dataset.rar);
      saveSettings(); render();
    });
    // Guilds and players apply on the Apply button or Enter
    const apply = () => { settings.tag = panel.querySelector("#gc-tag").value; settings.extraNames = panel.querySelector("#gc-names").value; saveSettings(); render(); };
    on("#gc-apply", "onclick", apply);
    for (const id of ["#gc-tag", "#gc-names"]) on(id, "onkeydown", (e) => { if (e.key === "Enter") apply(); });
    on("#gc-code", "onchange", (e) => { settings.codeBlock = e.target.checked; saveSettings(); render(); });
    on("#gc-png", "onclick", () => downloadReportPng(repList, repEv, evList.length));
    on("#gc-copypng", "onclick", () => copyReportPng(repList, repEv, evList.length));
    on("#gc-event", "onchange", (e) => { settings.eventMode = e.target.value; saveSettings(); render(); });
    on("#gc-compare", "onchange", (e) => { settings.compare = e.target.checked; saveSettings(); render(); });
    on("#gc-fish", "onchange", (e) => { settings.showFish = e.target.checked; saveSettings(); render(); });
    on("#gc-daily", "onchange", (e) => { settings.daily = e.target.checked; saveSettings(); render(); });
    on("#gc-min", "onclick", () => { settings.minimized = !settings.minimized; saveSettings(); render(); });
    on("#gc-time", "onchange", (e) => { settings.showTime = e.target.checked; saveSettings(); render(); });
    on("#gc-period", "onchange", (e) => { settings.period = e.target.value; saveSettings(); render(); });
    on("#gc-n", "onchange", (e) => { settings.periodN = Math.max(1, Math.round(+e.target.value) || 1); saveSettings(); render(); });
    for (const k of ["from", "to"]) on(`#gc-${k}`, "onchange", (e) => { settings[k] = e.target.value; saveSettings(); render(); });
    on("#gc-lastpost-go", "onclick", () => { setLastPosted(panel.querySelector("#gc-lastpost").value); render(); });
    on("#gc-lastpost", "onkeydown", (e) => { if (e.key === "Enter") { setLastPosted(e.target.value); render(); } });
    on("#gc-seen", "onclick", () => {
      markSeen(list);
      render();
    });
    on("#gc-export", "onclick", () => { exportArchive(); render(); });
    on("#gc-import", "onclick", importArchive);
    panel.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
      const text = msgs[+b.dataset.copy];
      try { await navigator.clipboard.writeText(text); }
      catch { const t = panel.querySelector(`textarea[data-text="${b.dataset.copy}"]`); t.select(); document.execCommand("copy"); }
      b.textContent = "Copied ✓";
      // In "New": copying a part marks exactly the catches in that part as seen
      const items = parts[+b.dataset.copy].items;
      if (settings.tab === "new" && items.length) {
        markSeen(items);
      }
    });
  };

  panel.textContent = "Loading catches...";
  await refresh();
  render();
  startLive();
  render();
})();
