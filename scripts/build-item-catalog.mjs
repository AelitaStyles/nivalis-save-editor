// Builds src/data/items.json (items, dishes, vendor and venue names) from a Nivalis Nights install:
//   node scripts/build-item-catalog.mjs "<Steam>/steamapps/common/Nivalis Nights"
//
// Item definitions are MonoBehaviours of one script class (item) or another (dish) in
// sharedassets0.assets / resources.assets. Each has m_Name, then its GUID string (the id used in
// save files), then fields including the base price and, for perishables, max freshness and a
// refrigerated flag. Unity strings are int32 length + bytes, padded to 4 bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameDir = process.argv[2];
if (!gameDir) {
  console.error('Usage: node scripts/build-item-catalog.mjs "<path to Nivalis Nights install>"');
  process.exit(1);
}
const dataDir = join(gameDir, 'Nivalis Nights_Data');
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'items.json');

// m_Script PPtr (fileID, pathID) of the MonoScripts, verified against ids found in save files.
const CLASSES = { 1408: 'item', 3640: 'dish', 1725: 'vendor' };
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_PREFIX = Buffer.from([36, 0, 0, 0]);
const PERISHABLE_MARKERS = new Set([31, 62, 63]);

function readAlignedString(b, pos) {
  const len = b.readInt32LE(pos);
  if (len < 0 || len > 4096) return null;
  return { value: b.toString('utf8', pos + 4, pos + 4 + len), end: pos + 4 + len + ((4 - (len % 4)) % 4) };
}

function scan(file, items, vendors) {
  const b = readFileSync(file);
  for (let i = b.indexOf(GUID_PREFIX); i !== -1 && i < b.length - 44; i = b.indexOf(GUID_PREFIX, i + 1)) {
    const guid = b.toString('latin1', i + 4, i + 40);
    if (!GUID_RE.test(guid) || items[guid]) continue;
    // m_Name precedes the GUID; the m_Script PPtr precedes m_Name.
    let nameStart = -1;
    let name = null;
    for (let len = 1; len <= 120; len++) {
      const s = i - ((4 - (len % 4)) % 4) - len - 4;
      if (s < 12) break;
      if (b.readInt32LE(s) === len) {
        const t = b.toString('utf8', s + 4, s + 4 + len);
        if (!/[\x00-\x1f�]/.test(t)) { nameStart = s; name = t; }
        break;
      }
    }
    if (nameStart < 0) continue;
    const kind = b.readInt32LE(nameStart - 12) === 1 ? CLASSES[Number(b.readBigInt64LE(nameStart - 8))] : undefined;
    if (!kind) continue;
    if (kind === 'vendor') {
      vendors[guid] ??= name;
      continue;
    }

    const entry = { name, kind };
    let p = i + 40;
    const locKey = readAlignedString(b, p);
    if (locKey) p = locKey.end;
    // prefab GUID (32 hex chars) is followed by: int32, float basePrice
    for (let j = p; j < p + 80; j += 4) {
      if (b.readInt32LE(j) === 32 && /^[0-9a-f]{32}$/.test(b.toString('latin1', j + 4, j + 36))) {
        entry.price = Math.round(b.readFloatLE(j + 40) * 100);
        break;
      }
    }
    // perishables: int32 maxFreshness, int32 refrigerated (0/1), int32 marker
    for (let j = p; j < p + 600; j += 4) {
      const shelf = b.readInt32LE(j);
      const fridge = b.readInt32LE(j + 4);
      if (PERISHABLE_MARKERS.has(b.readInt32LE(j + 8)) && (fridge === 0 || fridge === 1) && shelf >= 0 && shelf < 2000) {
        if (shelf > 0) entry.freshness = shelf;
        if (fridge === 1) entry.refrigerated = true;
        break;
      }
    }
    // Spoiled food is the end state of perishables; its own freshness fields are not meaningful.
    if (name === 'RottenFood') {
      delete entry.freshness;
      delete entry.refrigerated;
    }
    items[guid] = entry;
  }
}

// Venues: aligned string "Venue_<Area>_<Name>" (or "Greenhouse…"), then the venue GUID, then for
// restaurants a display key "VENUE_<NAME>".
function scanVenues(file, venues) {
  const b = readFileSync(file);
  for (const prefix of ['Venue_', 'Greenhouse']) scanVenuePrefix(b, Buffer.from(prefix, 'latin1'), venues);
}

function scanVenuePrefix(b, prefix, venues) {
  for (let i = b.indexOf(prefix); i !== -1; i = b.indexOf(prefix, i + 1)) {
    const internal = readAlignedString(b, i - 4);
    if (!internal || !/^(Venue_|Greenhouse)[\w' -]+$/.test(internal.value)) continue;
    for (let j = internal.end; j < internal.end + 160; j += 4) {
      if (b.readInt32LE(j) !== 36) continue;
      const guid = b.toString('latin1', j + 4, j + 40);
      if (!GUID_RE.test(guid)) break;
      let key = null;
      for (let k = j + 40; k < j + 240; k += 4) {
        const s = readAlignedString(b, k);
        if (s && /^VENUE_[A-Z0-9_]+$/.test(s.value)) { key = s.value; break; }
      }
      venues[guid] ??= { internal: internal.value, key };
      break;
    }
  }
}

const items = {};
const vendors = {};
const venues = {};
for (const f of ['sharedassets0.assets', 'resources.assets']) {
  console.log(`Scanning ${f}…`);
  scan(join(dataDir, f), items, vendors);
  scanVenues(join(dataDir, f), venues);
}
const sorted = Object.fromEntries(Object.entries(items).sort((a, b) => a[1].name.localeCompare(b[1].name)));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), items: sorted, vendors, venues })}\n`);
const counts = Object.values(sorted).reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
console.log(`Wrote ${outFile}: ${JSON.stringify(counts)}, ${Object.keys(vendors).length} vendors, ${Object.keys(venues).length} venues`);
