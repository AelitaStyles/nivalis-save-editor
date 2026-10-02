// Builds src/data/items.json (items, dishes, vendor and venue names) from a Nivalis Nights install:
//   node scripts/build-item-catalog.mjs "<Steam>/steamapps/common/Nivalis Nights"
//
// Item definitions are MonoBehaviours of one script class (item) or another (dish) in
// sharedassets0.assets / resources.assets. Each has m_Name, then its GUID string (the id used in
// save files), then the fields read by readItemFields (base price, max freshness, refrigerated).
// Unity strings are int32 length + bytes, padded to 4 bytes; a PPtr is int32 fileID + int64 pathID.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameDir = process.argv[2];
if (!gameDir) {
  console.error('Usage: node scripts/build-item-catalog.mjs "<path to Nivalis Nights install>"');
  process.exit(1);
}
const dataDir = join(gameDir, 'Nivalis Nights_Data');
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'items.json');

// m_Script PPtr pathIDs of the MonoScripts, verified against ids found in save files. Game updates
// renumber them (1408/3640/1725 before the 2026-10-01 patch), so they are re-learned from the GUIDs
// of the existing catalog when there is one; these values are only the fallback.
const DEFAULT_CLASSES = { 1412: 'item', 3647: 'dish', 1730: 'vendor' };
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_PREFIX = Buffer.from([36, 0, 0, 0]);

function readAlignedString(b, pos) {
  const len = b.readInt32LE(pos);
  if (len < 0 || len > 4096) return null;
  return { value: b.toString('utf8', pos + 4, pos + 4 + len), end: pos + 4 + len + ((4 - (len % 4)) % 4) };
}

// Every "named object with a GUID" in the file: { i: offset of the GUID string, guid, name, pathID of its script }.
function findCandidates(b) {
  const out = [];
  for (let i = b.indexOf(GUID_PREFIX); i !== -1 && i < b.length - 44; i = b.indexOf(GUID_PREFIX, i + 1)) {
    const guid = b.toString('latin1', i + 4, i + 40);
    if (!GUID_RE.test(guid)) continue;
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
    if (nameStart < 0 || b.readInt32LE(nameStart - 12) !== 1) continue;
    out.push({ i, guid, name, pathID: Number(b.readBigInt64LE(nameStart - 8)) });
  }
  return out;
}

// Maps script pathIDs to kinds by looking up where the GUIDs of the previous catalog ended up.
function learnClasses(candidates, previous) {
  if (!previous) return DEFAULT_CLASSES;
  const kindOf = new Map(Object.entries(previous.items ?? {}).map(([guid, e]) => [guid, e.kind]));
  for (const guid of Object.keys(previous.vendors ?? {})) kindOf.set(guid, 'vendor');
  const votes = new Map();
  for (const c of candidates) {
    const kind = kindOf.get(c.guid);
    if (!kind) continue;
    const v = votes.get(c.pathID) ?? {};
    v[kind] = (v[kind] ?? 0) + 1;
    votes.set(c.pathID, v);
  }
  const classes = {};
  for (const [pathID, v] of votes) {
    const kinds = Object.keys(v);
    if (kinds.length !== 1) throw new Error(`Script ${pathID} matches several kinds (${JSON.stringify(v)}); the asset layout changed`);
    classes[pathID] = kinds[0];
  }
  return Object.keys(classes).length ? classes : DEFAULT_CLASSES;
}

// Fields of an item/dish definition, starting right after its GUID (offsets checked against the
// stacks found in save files):
//   string locKey, PPtr, string prefabGuid (32 hex), int32, float basePrice, 9 x int32/float,
//   int32 n, n x PPtr, string cropKey, 16 bytes, int32 perishable (0/1), int32 maxFreshness,
//   int32 refrigerated (0/1), int32 flags
function readItemFields(b, pos) {
  const locKey = readAlignedString(b, pos);
  const prefab = locKey && readAlignedString(b, locKey.end + 12);
  if (!prefab || !/^[0-9a-f]{32}$/.test(prefab.value)) return null;
  const price = Math.round(b.readFloatLE(prefab.end + 4) * 100);
  const n = b.readInt32LE(prefab.end + 40);
  if (n < 0 || n > 64) return null;
  const cropKey = readAlignedString(b, prefab.end + 44 + 12 * n);
  if (!cropKey || !/^[\x20-\x7e]{0,64}$/.test(cropKey.value)) return null;
  const p = cropKey.end + 16;
  const [perishable, freshness, refrigerated] = [b.readInt32LE(p), b.readInt32LE(p + 4), b.readInt32LE(p + 8)];
  if (perishable < 0 || perishable > 1 || refrigerated < 0 || refrigerated > 1 || freshness < 0 || freshness > 2000) return null;
  return { price, freshness, refrigerated: refrigerated === 1 };
}

function collect(b, candidates, classes, items, vendors) {
  for (const { i, guid, name, pathID } of candidates) {
    const kind = classes[pathID];
    if (!kind || items[guid]) continue;
    if (kind === 'vendor') {
      vendors[guid] ??= name;
      continue;
    }

    const fields = readItemFields(b, i + 40);
    if (!fields) throw new Error(`Cannot read the fields of ${kind} "${name}" (${guid}); the asset layout changed`);
    const entry = { name, kind, price: fields.price };
    if (fields.freshness > 0) entry.freshness = fields.freshness;
    if (fields.refrigerated) entry.refrigerated = true;
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
function scanVenues(b, venues) {
  for (const prefix of ['Venue_', 'Greenhouse']) scanVenuePrefix(b, Buffer.from(prefix, 'latin1'), venues);
}

function scanVenuePrefix(b, prefix, venues) {
  for (let i = b.indexOf(prefix); i !== -1; i = b.indexOf(prefix, i + 1)) {
    const internal = readAlignedString(b, i - 4);
    // "Greenhouses" alone is a dialogue label; the GUIDs near it are not venues.
    if (!internal || internal.value === 'Greenhouses' || !/^(Venue_|Greenhouse)[\w' -]+$/.test(internal.value)) continue;
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
const files = ['sharedassets0.assets', 'resources.assets'].map((f) => {
  console.log(`Scanning ${f}…`);
  const b = readFileSync(join(dataDir, f));
  return { b, candidates: findCandidates(b) };
});
const previous = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
const classes = learnClasses(files.flatMap((f) => f.candidates), previous);
console.log(`Script classes: ${JSON.stringify(classes)}`);
for (const { b, candidates } of files) {
  collect(b, candidates, classes, items, vendors);
  scanVenues(b, venues);
}
if (!Object.keys(items).length || !Object.keys(vendors).length || !Object.keys(venues).length) {
  console.error('Found no items, vendors or venues; the asset layout changed. Catalog left untouched.');
  process.exit(1);
}
const sorted = Object.fromEntries(Object.entries(items).sort((a, b) => a[1].name.localeCompare(b[1].name)));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), items: sorted, vendors, venues })}\n`);
const counts = Object.values(sorted).reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
console.log(`Wrote ${outFile}: ${JSON.stringify(counts)}, ${Object.keys(vendors).length} vendors, ${Object.keys(venues).length} venues`);
