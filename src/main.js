import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, ask, message } from '@tauri-apps/plugin-dialog';
import {
  parseSave, summarize, listVariables, diffSaves, applyEdits, formatCredits, currentGameDay, INT32_MAX,
} from '../core/index.js';
import { areaName } from './areas.js';
import {
  itemInfo, itemName, ITEM_CHOICES, venueInfo, venueName, vendorName,
} from './catalog.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  dir: null,
  saves: [],
  thumbs: new Map(), // path -> blob URL
  current: null, // { entry, save, summary, vars, varIndex }
  edits: { moneyCents: undefined, variables: new Map(), inventory: new Map() },
  tab: 'overview',
  invKey: 'PLAYER_INVENTORY',
  filters: { q: '', group: '', kind: '', modifiedOnly: false },
  compare: null, // { entry, diff }
};

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function readBytes(path) {
  return new Uint8Array(await invoke('read_file', { path }));
}

function displayName(entry) {
  return entry.name.toUpperCase() === 'AUTOSAVE' ? 'Autosave' : 'Manual save';
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatPlaytime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

function parseCreditsInput(raw) {
  const m = /^\s*(\d{1,8})(?:[.,](\d{1,2}))?\s*$/.exec(raw);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return cents <= INT32_MAX ? cents : null;
}

let toastTimer;
function toast(text, kind = 'ok') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function pendingCount() {
  return (state.edits.moneyCents !== undefined ? 1 : 0) + state.edits.variables.size + state.edits.inventory.size;
}

function resetEdits() {
  state.edits = { moneyCents: undefined, variables: new Map(), inventory: new Map() };
}

function currentValue(v) {
  return state.edits.variables.has(v.name) ? state.edits.variables.get(v.name) : v.value;
}

function setVariableEdit(name, value) {
  const original = state.current.varIndex.get(name);
  if (value === original.value) state.edits.variables.delete(name);
  else state.edits.variables.set(name, value);
  renderPending();
}

// ---------- folder & save list ----------

async function loadFolder(dir) {
  state.dir = dir;
  $('#folder-path').textContent = dir;
  $('#folder-path').title = dir;
  try {
    state.saves = await invoke('list_saves', { dir });
  } catch (e) {
    state.saves = [];
    toast(String(e), 'error');
  }
  renderSaveList();
  loadThumbnails();
}

async function loadThumbnails() {
  for (const entry of state.saves) {
    if (!entry.screenshot || state.thumbs.has(entry.path)) continue;
    try {
      const bytes = await readBytes(entry.screenshot);
      state.thumbs.set(entry.path, URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
      const img = document.querySelector(`[data-thumb="${CSS.escape(entry.path)}"]`);
      if (img) img.src = state.thumbs.get(entry.path);
    } catch {
      // A missing screenshot is harmless.
    }
  }
  if (state.current && state.tab === 'overview') renderMain();
}

function renderSaveList() {
  const list = $('#save-list');
  if (!state.saves.length) {
    list.innerHTML = '<li class="save-list-empty">No .sav files in this folder.</li>';
    return;
  }
  list.innerHTML = state.saves.map((s) => `
    <li>
      <button class="save-item ${state.current?.entry.path === s.path ? 'active' : ''}" data-path="${escapeHtml(s.path)}">
        <img class="thumb" alt="" data-thumb="${escapeHtml(s.path)}" ${state.thumbs.has(s.path) ? `src="${state.thumbs.get(s.path)}"` : ''}>
        <span class="save-meta">
          <span class="save-name">${displayName(s)}</span>
          <span class="save-date">${formatDate(s.modifiedMs)}</span>
          <span class="save-file">${escapeHtml(s.name)}</span>
        </span>
      </button>
    </li>`).join('');
}

async function selectSave(path) {
  if (state.current?.entry.path === path) return;
  if (pendingCount() && !(await ask('Discard your unsaved changes?', { title: 'Unsaved changes', kind: 'warning' }))) return;
  const entry = state.saves.find((s) => s.path === path);
  await openSave(entry);
}

async function openSave(entry) {
  $('#main').innerHTML = '<div class="empty"><div class="spinner"></div><p>Reading save…</p></div>';
  resetEdits();
  state.compare = null;
  renderPending();
  try {
    const save = parseSave(await readBytes(entry.path));
    const vars = listVariables(save);
    state.current = { entry, save, summary: summarize(save), vars, varIndex: new Map(vars.map((v) => [v.name, v])) };
  } catch (e) {
    state.current = null;
    $('#main').innerHTML = `<div class="empty"><h2>Cannot open this save</h2><p class="error-text">${escapeHtml(e.message)}</p></div>`;
    renderSaveList();
    return;
  }
  renderSaveList();
  renderMain();
}

// ---------- main panel ----------

function renderMain() {
  const { entry, summary } = state.current;
  const tabs = [['overview', 'Overview'], ['inventory', 'Inventory'], ['variables', `Story variables <span class="count">${summary.variableCount}</span>`], ['compare', 'Compare']];
  $('#main').innerHTML = `
    <div class="save-header">
      <div>
        <h1>${displayName(entry)}</h1>
        <div class="subtle">${escapeHtml(entry.name)}.sav · ${formatDate(entry.modifiedMs)}</div>
      </div>
      <nav class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav>
    </div>
    ${summary.warnings.length ? `<div class="banner banner-warn inline">${summary.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
    <div class="tab-body" id="tab-body"></div>`;
  renderTab();
}

function renderTab() {
  const body = $('#tab-body');
  if (state.tab === 'overview') body.innerHTML = overviewHtml();
  else if (state.tab === 'variables') { body.innerHTML = variablesShellHtml(); renderVariableRows(); }
  else if (state.tab === 'inventory') { body.innerHTML = inventoryShellHtml(); renderInventoryRows(); }
  else body.innerHTML = compareHtml();
}

// ---------- inventory ----------

const STORAGE_LABELS = { normal: 'Storage', refrigerated: 'Fridge', furniture: 'Furniture' };

function isVenueOwned(venueId) {
  const venue = venueInfo(venueId);
  const owned = venue && state.current.varIndex.get(`${venue.internal}.Owned`);
  return owned?.value === true || state.current.save.header.guids.includes(venueId);
}

// Containers grouped for the picker; empty containers without a known name are hidden.
function containerGroups() {
  const groups = { player: [], owned: [], venues: [], vendors: [] };
  for (const c of state.current.save.inventory.containers) {
    const count = inventoryItems(c.key).length;
    if (c.kind === 'player') groups.player.push({ key: c.key, label: 'Your inventory', count });
    else if (c.kind === 'venue') {
      const label = `${venueName(c.venueId)} · ${STORAGE_LABELS[c.storage]}`;
      (isVenueOwned(c.venueId) ? groups.owned : groups.venues).push({ key: c.key, label, count });
    } else if (c.kind === 'vendor') {
      const name = vendorName(c.vendorId);
      if (name || count) groups.vendors.push({ key: c.key, label: name ?? `Vendor ${c.key.slice(0, 8)}`, count });
    }
  }
  for (const g of [groups.owned, groups.venues, groups.vendors]) g.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

function inventoryContainer(key) {
  return state.current.save.inventory.containers.find((c) => c.key === key);
}

function inventoryItems(key) {
  return state.edits.inventory.get(key) ?? inventoryContainer(key).items;
}

// Returns an editable copy of the container's items; call commitInventory(key) after changing it.
function editableItems(key) {
  if (!state.edits.inventory.has(key)) state.edits.inventory.set(key, structuredClone(inventoryContainer(key).items));
  return state.edits.inventory.get(key);
}

function commitInventory(key) {
  const items = state.edits.inventory.get(key).filter((it) => it.stacks.length);
  if (JSON.stringify(items) === JSON.stringify(inventoryContainer(key).items)) state.edits.inventory.delete(key);
  else state.edits.inventory.set(key, items);
  renderPending();
}

function freshnessLabel(units) {
  const days = units / 3;
  return days >= 1 ? `≈ ${Number.isInteger(days) ? days : days.toFixed(1)} days` : `≈ ${units * 8} h`;
}

function inventoryShellHtml() {
  const groups = containerGroups();
  const option = (o) => `<option value="${escapeHtml(o.key)}" ${o.key === state.invKey ? 'selected' : ''}>${escapeHtml(o.label)}${o.count ? ` (${o.count})` : ''}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${label}">${list.map(option).join('')}</optgroup>` : '');
  const container = inventoryContainer(state.invKey);
  const changed = state.edits.inventory.has(state.invKey);
  return `
    <div class="toolbar">
      <label>Container
        <select id="inv-container">
          ${group('You', groups.player)}${group('Your venues', groups.owned)}${group('Other venues', groups.venues)}${group('Vendor stock', groups.vendors)}
        </select>
      </label>
      <span class="subtle" id="inv-summary"></span>
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="inv-fresh-all" title="Set every perishable stack in this container to full freshness">Make all fresh</button>
      ${changed ? '<button class="btn btn-ghost" id="inv-revert">Revert container</button>' : ''}
    </div>
    ${container.kind === 'vendor' ? '<p class="hint">Vendor stock is what this vendor currently has for sale. The game restocks vendors on its own schedule.</p>' : ''}
    <div class="card add-item">
      <h2>Add item</h2>
      <div class="add-row">
        <input id="inv-add-search" type="search" list="inv-item-list" placeholder="Search ${ITEM_CHOICES.length.toLocaleString()} items… e.g. Whiskey, Pork, Blender" autocomplete="off">
        <datalist id="inv-item-list">${ITEM_CHOICES.map((c) => `<option value="${escapeHtml(c.label)}"></option>`).join('')}</datalist>
        <input id="inv-add-qty" class="num" type="number" min="1" step="1" value="1" aria-label="Quantity">
        <button class="btn btn-primary" id="inv-add">Add</button>
      </div>
      <p class="hint" id="inv-add-hint">Added items are free (price paid 0) and start fully fresh.</p>
    </div>
    <div class="table-wrap">
      <table class="vars inv">
        <thead><tr><th>Item</th><th>Quantity</th><th>Freshness</th><th>Acquired</th><th>Paid</th><th></th></tr></thead>
        <tbody id="inv-rows"></tbody>
      </table>
    </div>`;
}

function renderInventoryRows() {
  const key = state.invKey;
  const items = inventoryItems(key);
  const original = new Map(inventoryContainer(key).items.map((it) => [it.guid, JSON.stringify(it.stacks)]));
  const total = items.reduce((n, it) => n + it.stacks.reduce((m, s) => m + s.quantity, 0), 0);
  const { capacity } = inventoryContainer(key);
  $('#inv-summary').textContent = `${items.length} item types · ${total.toLocaleString()} units${capacity && capacity < 999999 ? ` · capacity ${capacity.toLocaleString()}` : ''}`;
  if (!items.length) {
    $('#inv-rows').innerHTML = '<tr><td colspan="6" class="none">This container is empty.</td></tr>';
    return;
  }
  $('#inv-rows').innerHTML = items.map((it, i) => {
    const info = itemInfo(it.guid);
    const perishable = Boolean(info?.freshness) || it.stacks.some((s) => s.freshness > 0);
    const status = !original.has(it.guid) ? 'added' : original.get(it.guid) !== JSON.stringify(it.stacks) ? 'modified' : '';
    return it.stacks.map((s, j) => `
      <tr class="${status ? 'modified' : ''}">
        <td class="key">${j === 0
          ? `<span title="${escapeHtml(it.guid)}">${escapeHtml(itemName(it.guid))}</span>${status === 'added' ? ' <span class="count">new</span>' : ''}${info?.refrigerated ? ' <span class="tag" title="Needs refrigeration">❄</span>' : ''}`
          : '<span class="subtle stack-sub">another stack</span>'}</td>
        <td><input class="num inv-qty" type="number" min="1" step="1" value="${s.quantity}" data-item="${i}" data-stack="${j}" aria-label="Quantity"></td>
        <td>${perishable
          ? `<input class="num inv-fresh" type="number" min="0" step="1" value="${s.freshness}" data-item="${i}" data-stack="${j}" aria-label="Freshness" title="Freshness in 8-hour units${info?.freshness ? `, fully fresh = ${info.freshness}` : ''}"> <span class="subtle">${s.freshness ? freshnessLabel(s.freshness) : 'spoiled'}</span>`
          : '<span class="subtle">doesn’t spoil</span>'}</td>
        <td class="subtle">Day ${s.day}</td>
        <td class="subtle">${formatCredits(s.price)}</td>
        <td class="actions"><button class="link" data-remove-stack="${i}:${j}" title="Remove this stack">Remove</button></td>
      </tr>`).join('');
  }).join('');
}

function addInventoryItem() {
  const label = $('#inv-add-search').value.trim();
  const choice = ITEM_CHOICES.find((c) => c.label === label) ?? ITEM_CHOICES.find((c) => c.label.toLowerCase() === label.toLowerCase());
  const qty = Number($('#inv-add-qty').value);
  const hint = $('#inv-add-hint');
  if (!choice) { hint.textContent = 'Pick an item from the suggestions.'; hint.classList.add('error-text'); return; }
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) { hint.textContent = 'Quantity must be between 1 and 100,000.'; hint.classList.add('error-text'); return; }
  const info = itemInfo(choice.guid);
  const container = inventoryContainer(state.invKey);
  const items = editableItems(state.invKey);
  const stack = { price: 0, day: currentGameDay(state.current.save), quantity: qty, freshness: info?.freshness ?? 0 };
  const existing = items.find((it) => it.guid === choice.guid);
  if (existing) existing.stacks.push(stack);
  else items.push({ guid: choice.guid, stacks: [stack] });
  commitInventory(state.invKey);
  renderTab();
  const warn = info?.refrigerated && container.kind === 'venue' && container.storage !== 'refrigerated'
    ? ` Note: ${choice.name} normally goes in a fridge.` : '';
  toast(`Added ${qty} × ${choice.name}.${warn}`, warn ? 'error' : 'ok');
}

function makeAllFresh() {
  const items = editableItems(state.invKey);
  let n = 0;
  for (const it of items) {
    const max = itemInfo(it.guid)?.freshness;
    if (!max) continue;
    for (const s of it.stacks) if (s.freshness !== max) { s.freshness = max; n++; }
  }
  commitInventory(state.invKey);
  renderTab();
  toast(n ? `Refreshed ${n} stack${n === 1 ? '' : 's'}.` : 'Everything here is already fresh or doesn’t spoil.');
}


function overviewHtml() {
  const { entry, summary } = state.current;
  const money = state.edits.moneyCents ?? summary.moneyCents;
  const thumb = state.thumbs.get(entry.path);
  return `
    <div class="overview">
      <div class="shot">${thumb ? `<img src="${thumb}" alt="Screenshot of this save">` : '<div class="shot-missing">No screenshot</div>'}</div>
      <dl class="facts">
        <div><dt>Location</dt><dd>${escapeHtml(areaName(summary.sceneIndex))}</dd></div>
        <div><dt>In-game time</dt><dd>Day ${summary.gameDay + 1}, ${summary.gameClock}</dd></div>
        <div><dt>Playtime</dt><dd>${formatPlaytime(summary.playtimeSeconds)}</dd></div>
        <div><dt>Saved</dt><dd>${new Date(summary.savedAt).toLocaleString()}</dd></div>
        <div><dt>Story variables</dt><dd>${summary.variableCount.toLocaleString()}</dd></div>
        <div><dt>World objects</dt><dd>${summary.ghostBlockCount.toLocaleString()}</dd></div>
      </dl>
    </div>
    <section class="card">
      <h2>Money</h2>
      <div class="money-row">
        <label class="money-field ${state.edits.moneyCents !== undefined ? 'modified' : ''}">
          
          <input id="money-input" type="text" inputmode="decimal" autocomplete="off" value="${formatCredits(money)}" aria-label="Money in credits">
          <span class="currency">credits</span>
        </label>
        <div class="quick">
          ${[1000, 10000, 100000].map((c) => `<button class="btn btn-ghost" data-add-credits="${c}">+${c.toLocaleString()}</button>`).join('')}
          <button class="btn btn-ghost" id="money-reset" ${state.edits.moneyCents === undefined ? 'disabled' : ''}>Reset</button>
        </div>
      </div>
      <p class="hint" id="money-hint">Original: ${formatCredits(summary.moneyCents)} credits. Both copies in the save are updated.</p>
    </section>
    <section class="card muted-card">
      <h2>In-game time</h2>
      <p class="hint">Read-only. The clock is stamped into hundreds of world records (schedules, events), so changing it in one place would desync the world.</p>
    </section>`;
}

function variablesShellHtml() {
  const groups = new Map();
  for (const v of state.current.vars) groups.set(v.group, (groups.get(v.group) ?? 0) + 1);
  const f = state.filters;
  const options = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([g, n]) => `<option value="${escapeHtml(g)}" ${f.group === g ? 'selected' : ''}>${escapeHtml(g || '(no group)')} (${n})</option>`).join('');
  return `
    <div class="toolbar">
      <input id="var-search" type="search" placeholder="Search variables… e.g. Romance, Venue, Debt" value="${escapeHtml(f.q)}">
      <select id="var-group"><option value="">All groups</option>${options}</select>
      <select id="var-kind">
        <option value="">All types</option>
        <option value="bool" ${f.kind === 'bool' ? 'selected' : ''}>Flags</option>
        <option value="int" ${f.kind === 'int' ? 'selected' : ''}>Numbers</option>
        <option value="string" ${f.kind === 'string' ? 'selected' : ''}>Text</option>
      </select>
      <label class="check"><input id="var-modified" type="checkbox" ${f.modifiedOnly ? 'checked' : ''}> Changed only</label>
      <span class="subtle" id="var-count"></span>
    </div>
    <p class="hint">These are the game's story and progress flags. Changing them can skip or break quest steps; keep the automatic backup in mind.</p>
    <div class="table-wrap">
      <table class="vars">
        <thead><tr><th>Group</th><th>Variable</th><th>Value</th><th></th></tr></thead>
        <tbody id="var-rows"></tbody>
      </table>
    </div>`;
}

function valueEditorHtml(v) {
  const value = currentValue(v);
  if (v.kind === 'bool') {
    return `<label class="switch"><input type="checkbox" data-var="${escapeHtml(v.name)}" ${value ? 'checked' : ''}><span></span></label>`;
  }
  if (v.kind === 'int') {
    return `<input class="num" type="number" step="1" data-var="${escapeHtml(v.name)}" value="${value}">`;
  }
  return `<span class="text-value" title="Text variables are read-only for now">${value === '' ? '<em>empty</em>' : escapeHtml(value)} 🔒</span>`;
}

function renderVariableRows() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const rows = state.current.vars.filter((v) =>
    (!q || v.name.toLowerCase().includes(q))
    && (!f.group || v.group === f.group)
    && (!f.kind || v.kind === f.kind)
    && (!f.modifiedOnly || state.edits.variables.has(v.name)));
  $('#var-count').textContent = `${rows.length.toLocaleString()} shown`;
  $('#var-rows').innerHTML = rows.length ? rows.map((v) => {
    const changed = state.edits.variables.has(v.name);
    return `<tr class="${changed ? 'modified' : ''}">
      <td class="group">${escapeHtml(v.group)}</td>
      <td class="key">${escapeHtml(v.key)}</td>
      <td class="value">${valueEditorHtml(v)}</td>
      <td class="actions">${changed ? `<button class="link" data-revert="${escapeHtml(v.name)}" title="Original: ${escapeHtml(String(v.value))}">Revert</button>` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="4" class="none">No variables match.</td></tr>';
}

function compareHtml() {
  const others = state.saves.filter((s) => s.path !== state.current.entry.path);
  const c = state.compare;
  let result = '<p class="hint">Pick another save to see what changed between them. Handy for finding which flag a quest step sets.</p>';
  if (c) {
    const { header, variables } = c.diff;
    const headerLabels = { moneyCents: 'Money', gameSeconds: 'In-game time', sceneIndex: 'Location', playtimeSeconds: 'Playtime' };
    const fmtHeader = (field, v) => field === 'moneyCents' ? formatCredits(v)
      : field === 'sceneIndex' ? areaName(v)
        : field === 'playtimeSeconds' ? formatPlaytime(v)
          : `Day ${Math.floor(v / 86400) + 1}, ${new Date((v % 86400) * 1000).toISOString().slice(11, 16)}`;
    result = `
      <div class="card">
        <h2>Save info</h2>
        ${header.length ? `<table class="diff"><tbody>${header.map((h) => `<tr><td>${headerLabels[h.field]}</td><td class="before">${escapeHtml(fmtHeader(h.field, h.before))}</td><td>→</td><td class="after">${escapeHtml(fmtHeader(h.field, h.after))}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No differences.</p>'}
      </div>
      <div class="card">
        <h2>Story variables <span class="count">${variables.length}</span></h2>
        ${variables.length ? `<div class="table-wrap"><table class="diff vars"><thead><tr><th>Variable</th><th>${escapeHtml(displayName(c.entry))}</th><th></th><th>This save</th><th></th></tr></thead><tbody>
          ${variables.map((v) => `<tr>
            <td class="key">${escapeHtml(v.name)}</td>
            <td class="before">${escapeHtml(JSON.stringify(v.before))}</td><td>→</td>
            <td class="after">${escapeHtml(JSON.stringify(v.after))}</td>
            <td class="actions">${v.kind !== 'string' && v.before !== undefined ? `<button class="link" data-take="${escapeHtml(v.name)}" title="Stage the other save's value as an edit">Use other value</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="hint">No differences.</p>'}
      </div>`;
  }
  return `
    <div class="toolbar">
      <label>Compare with
        <select id="compare-select">
          <option value="">Choose a save…</option>
          ${others.map((s) => `<option value="${escapeHtml(s.path)}" ${c?.entry.path === s.path ? 'selected' : ''}>${displayName(s)} · ${formatDate(s.modifiedMs)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${result}`;
}

async function runCompare(path) {
  if (!path) { state.compare = null; renderTab(); return; }
  const entry = state.saves.find((s) => s.path === path);
  $('#tab-body').innerHTML = '<div class="empty"><div class="spinner"></div><p>Comparing…</p></div>';
  try {
    const other = parseSave(await readBytes(path));
    state.compare = { entry, diff: diffSaves(other, state.current.save) };
  } catch (e) {
    state.compare = null;
    toast(`Cannot compare: ${e.message}`, 'error');
  }
  renderTab();
}

// ---------- pending changes & saving ----------

function renderPending() {
  const n = pendingCount();
  $('#pending').hidden = n === 0;
  $('#pending-text').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
}

async function saveChanges() {
  const { entry, save } = state.current;
  if (await invoke('is_game_running')) {
    await message('Close Nivalis Nights first. The game can overwrite the save or ignore your changes while it is running.', { title: 'Game is running', kind: 'warning' });
    return;
  }
  let bytes;
  try {
    bytes = applyEdits(save, {
      moneyCents: state.edits.moneyCents,
      variables: Object.fromEntries(state.edits.variables),
      inventory: Object.fromEntries(state.edits.inventory),
    });
  } catch (e) {
    await message(e.message, { title: 'Cannot apply changes', kind: 'error' });
    return;
  }
  const ok = await ask(`Write ${pendingCount()} change(s) to ${entry.name}.sav?\n\nA backup of the current file is stored in the SaveEditorBackups folder first.`, { title: 'Save changes', kind: 'info' });
  if (!ok) return;
  try {
    const backup = await invoke('write_save', bytes, { headers: { 'x-save-path': encodeURIComponent(entry.path) } });
    toast(`Saved. Backup: ${backup}`);
  } catch (e) {
    await message(String(e), { title: 'Save failed', kind: 'error' });
    return;
  }
  const tab = state.tab;
  await loadFolder(state.dir);
  const fresh = state.saves.find((s) => s.path === entry.path);
  state.current = null;
  state.tab = tab;
  await openSave(fresh);
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.path) await selectSave(t.dataset.path);
  else if (t.dataset.tab) { state.tab = t.dataset.tab; renderMain(); }
  else if (t.dataset.addCredits) {
    const base = state.edits.moneyCents ?? state.current.summary.moneyCents;
    const next = Math.min(INT32_MAX, base + Number(t.dataset.addCredits) * 100);
    state.edits.moneyCents = next === state.current.summary.moneyCents ? undefined : next;
    renderPending(); renderTab();
  } else if (t.id === 'money-reset') { state.edits.moneyCents = undefined; renderPending(); renderTab(); }
  else if (t.dataset.revert) { state.edits.variables.delete(t.dataset.revert); renderPending(); renderVariableRows(); }
  else if (t.id === 'inv-add') addInventoryItem();
  else if (t.id === 'inv-fresh-all') makeAllFresh();
  else if (t.id === 'inv-revert') { state.edits.inventory.delete(state.invKey); renderPending(); renderTab(); }
  else if (t.dataset.removeStack) {
    const [i, j] = t.dataset.removeStack.split(':').map(Number);
    const items = editableItems(state.invKey);
    items[i].stacks.splice(j, 1);
    if (!items[i].stacks.length) items.splice(i, 1);
    commitInventory(state.invKey);
    renderTab();
  }
  else if (t.dataset.take) {
    const d = state.compare.diff.variables.find((v) => v.name === t.dataset.take);
    setVariableEdit(d.name, d.before);
    toast(`${d.name} staged as ${JSON.stringify(d.before)}. Review it under Story variables.`);
  } else if (t.id === 'discard') { resetEdits(); renderPending(); renderTab(); }
  else if (t.id === 'save') await saveChanges();
  else if (t.id === 'choose-folder') {
    const dir = await open({ directory: true, defaultPath: state.dir ?? undefined, title: 'Choose the Nivalis Nights save folder' });
    if (dir) {
      if (pendingCount() && !(await ask('Discard your unsaved changes?', { title: 'Unsaved changes', kind: 'warning' }))) return;
      resetEdits(); renderPending();
      state.current = null;
      $('#main').innerHTML = $('#empty')?.outerHTML ?? '<div class="empty"><h2>Select a save</h2></div>';
      await loadFolder(dir);
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'money-input') {
    const cents = parseCreditsInput(t.value);
    t.closest('.money-field').classList.toggle('invalid', cents === null);
    if (cents === null) { $('#money-hint').textContent = 'Enter an amount like 1558.80 (max 21,474,836.47).'; return; }
    state.edits.moneyCents = cents === state.current.summary.moneyCents ? undefined : cents;
    t.closest('.money-field').classList.toggle('modified', state.edits.moneyCents !== undefined);
    $('#money-hint').textContent = `Original: ${formatCredits(state.current.summary.moneyCents)} credits. Both copies in the save are updated.`;
    $('#money-reset').disabled = state.edits.moneyCents === undefined;
    renderPending();
  } else if (t.id === 'var-search') { state.filters.q = t.value; renderVariableRows(); }
  else if (t.matches('.inv-qty, .inv-fresh')) {
    const isQty = t.classList.contains('inv-qty');
    const v = Number(t.value);
    const ok = /^\d+$/.test(t.value) && v <= INT32_MAX && (!isQty || v >= 1);
    t.classList.toggle('invalid', !ok);
    if (!ok) return;
    const items = editableItems(state.invKey);
    items[Number(t.dataset.item)].stacks[Number(t.dataset.stack)][isQty ? 'quantity' : 'freshness'] = v;
    commitInventory(state.invKey);
    t.closest('tr').classList.add('modified');
  } else if (t.id === 'inv-add-search') { $('#inv-add-hint').classList.remove('error-text'); }
  else if (t.matches('input.num[data-var]')) {
    const ok = /^-?\d+$/.test(t.value) && Math.abs(Number(t.value)) <= INT32_MAX;
    t.classList.toggle('invalid', !ok);
    if (ok) {
      setVariableEdit(t.dataset.var, Number(t.value));
      t.closest('tr').classList.toggle('modified', state.edits.variables.has(t.dataset.var));
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'var-group') { state.filters.group = t.value; renderVariableRows(); }
  else if (t.id === 'var-kind') { state.filters.kind = t.value; renderVariableRows(); }
  else if (t.id === 'var-modified') { state.filters.modifiedOnly = t.checked; renderVariableRows(); }
  else if (t.id === 'compare-select') runCompare(t.value);
  else if (t.id === 'inv-container') { state.invKey = t.value; renderTab(); }
  else if (t.matches('.inv-qty, .inv-fresh')) renderTab();
  else if (t.matches('input[type=checkbox][data-var]')) { setVariableEdit(t.dataset.var, t.checked); renderVariableRows(); }
  else if (t.matches('input.num[data-var]')) renderVariableRows();
});

async function pollGameRunning() {
  try {
    $('#game-running').hidden = !(await invoke('is_game_running'));
  } catch {
    // Not fatal; the check runs again before saving.
  }
}

async function init() {
  $('#app-version').textContent = `v${__APP_VERSION__}`;
  getCurrentWindow().onCloseRequested(async (event) => {
    if (pendingCount() && !(await ask('You have unsaved changes. Close anyway?', { title: 'Unsaved changes', kind: 'warning' }))) {
      event.preventDefault();
    }
  });
  const dir = await invoke('default_save_dir');
  if (dir) await loadFolder(dir);
  else $('#save-list').innerHTML = '<li class="save-list-empty">Save folder not found. Use “Change folder…”.</li>';
  pollGameRunning();
  setInterval(pollGameRunning, 5000);
}

init();
