// Inventory section (InventoriesSave): every container in the world, including the player's
// inventory, venue storage (normal / refrigerated / furniture) and vendor stock.
//
//   section   string key INVENTORY_KEY, int32 containerCount, containers...
//   container string key, byte flagA (1 for vendors), byte flagB, int32 itemCount, items...,
//             12-byte trailer (byte hasCapacity, int32 capacity, 7 more bytes; kept verbatim)
//   item      string itemGuid (item definition id), int32 stackCount, stacks...
//   stack     int32 price (cents paid per unit, 0 = free), int32 day acquired,
//             int32 quantity, int32 freshness (8-hour units left, 0 = does not spoil)

import { readInt32, writeInt32, readString, encodeString, indexOf } from './binary.js';
import { SaveFormatError } from './errors.js';

export const INVENTORY_KEY = '2605882F-31F5-4D75-9F72-802B33601A6B';
const TRAILER_SIZE = 12;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VENUE_RE = /^([0-9a-f-]{36})_(Normal|Refridgerated|Furniture)Inventory$/;

export function classifyContainer(key) {
  if (key === 'PLAYER_INVENTORY') return { kind: 'player' };
  const venue = VENUE_RE.exec(key);
  if (venue) {
    const storage = { Normal: 'normal', Refridgerated: 'refrigerated', Furniture: 'furniture' }[venue[2]];
    return { kind: 'venue', venueId: venue[1], storage };
  }
  if (GUID_RE.test(key)) return { kind: 'vendor', vendorId: key };
  return { kind: 'other' };
}

export function parseInventory(bytes) {
  const marker = encodeString(INVENTORY_KEY);
  const at = indexOf(bytes, marker, 0);
  if (at < 0) throw new SaveFormatError('Inventory section not found');
  let pos = at + marker.length;
  const count = readInt32(bytes, pos);
  pos += 4;
  if (count < 0 || count > 100000) throw new SaveFormatError(`Implausible container count ${count}`);
  const bodyStart = pos;
  const containers = [];
  for (let c = 0; c < count; c++) {
    const key = readString(bytes, pos);
    pos = key.end;
    const flagA = bytes[pos];
    const flagB = bytes[pos + 1];
    pos += 2;
    const itemCount = readInt32(bytes, pos);
    pos += 4;
    if (itemCount < 0 || itemCount > 100000) throw new SaveFormatError(`Implausible item count ${itemCount} in container ${key.value}`);
    const items = [];
    for (let i = 0; i < itemCount; i++) {
      const guid = readString(bytes, pos);
      if (!GUID_RE.test(guid.value)) throw new SaveFormatError(`Bad item id in container ${key.value} at 0x${pos.toString(16)}`);
      pos = guid.end;
      const stackCount = readInt32(bytes, pos);
      pos += 4;
      if (stackCount < 0 || stackCount > 100000) throw new SaveFormatError(`Implausible stack count in container ${key.value}`);
      const stacks = [];
      for (let s = 0; s < stackCount; s++) {
        stacks.push({
          price: readInt32(bytes, pos),
          day: readInt32(bytes, pos + 4),
          quantity: readInt32(bytes, pos + 8),
          freshness: readInt32(bytes, pos + 12),
        });
        pos += 16;
      }
      items.push({ guid: guid.value, stacks });
    }
    const trailer = bytes.slice(pos, pos + TRAILER_SIZE);
    pos += TRAILER_SIZE;
    const hasCapacity = trailer[0] === 1;
    containers.push({
      key: key.value,
      ...classifyContainer(key.value),
      flagA,
      flagB,
      capacity: hasCapacity ? readInt32(trailer, 1) : null,
      trailer,
      items,
    });
  }
  // The next manager section key must follow immediately; otherwise the grammar is wrong for this save.
  if (bytes[pos] !== 0x24 || !/^[0-9A-F-]{36}$/.test(readString(bytes, pos).value)) {
    throw new SaveFormatError('Inventory section did not end at a section boundary');
  }
  return { start: at, bodyStart, end: pos, containers };
}

export function encodeInventoryBody(containers) {
  const parts = [];
  let size = 0;
  const push = (p) => { parts.push(p); size += p.length; };
  const int32 = (v) => { const b = new Uint8Array(4); writeInt32(b, 0, v); return b; };
  for (const c of containers) {
    push(encodeString(c.key));
    push(new Uint8Array([c.flagA, c.flagB]));
    push(int32(c.items.length));
    for (const item of c.items) {
      push(encodeString(item.guid));
      push(int32(item.stacks.length));
      const s = new Uint8Array(16 * item.stacks.length);
      item.stacks.forEach((st, i) => {
        writeInt32(s, i * 16, st.price);
        writeInt32(s, i * 16 + 4, st.day);
        writeInt32(s, i * 16 + 8, st.quantity);
        writeInt32(s, i * 16 + 12, st.freshness);
      });
      push(s);
    }
    push(c.trailer);
  }
  const out = new Uint8Array(size);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function validateInventoryItems(containerKey, items) {
  for (const item of items) {
    if (!GUID_RE.test(item.guid)) throw new SaveFormatError(`Invalid item id "${item.guid}" in ${containerKey}`);
    if (!item.stacks.length) throw new SaveFormatError(`Item ${item.guid} in ${containerKey} has no stacks`);
    for (const s of item.stacks) {
      for (const f of ['price', 'day', 'quantity', 'freshness']) {
        if (!Number.isInteger(s[f]) || s[f] < -2147483648 || s[f] > 2147483647) {
          throw new SaveFormatError(`${f} of ${item.guid} in ${containerKey} must be a 32-bit integer`);
        }
      }
      if (s.quantity < 1) throw new SaveFormatError(`Quantity of ${item.guid} in ${containerKey} must be at least 1`);
      if (s.price < 0 || s.freshness < 0) throw new SaveFormatError(`Price and freshness of ${item.guid} in ${containerKey} cannot be negative`);
    }
  }
}

