// Parser/editor for Nivalis Nights .sav files (save version 151).
//
// Layout knowledge (reverse-engineered, see README):
//   header        version, scene, playtime, unix time, in-game seconds, money (cents), GUID list, ..., "END_HEADER"
//   sections      manager saves keyed by an uppercase GUID string, no length prefix
//   variables     articy global variables, stored twice with different type enums
//   Ghost blocks  "Ghost_<guid>" tag, int32 absolute end offset, payload, closing tag
//   player money  int32 cents directly after the player's Ghost block (duplicate of the header value)
//
// Phase 1 only performs same-size edits (int32 / bool), so no offsets ever move.

import {
  readInt32, writeInt32, readFloat32, readString, encodeString,
  asciiBytes, indexOf, bytesEqual,
} from './binary.js';

export const SUPPORTED_VERSION = 151;
export const INT32_MAX = 2147483647;

export const VARIABLE_TABLES = [
  { id: 'primary', key: 'BD57C1E7-3EAE-4896-A466-73822A382AE4', types: { 1: 'int', 3: 'bool', 4: 'string' } },
  { id: 'mirror', key: '53BD367F-1E7D-4886-91D8-D8988CDF96EC', types: { 3: 'int', 2: 'bool', 4: 'string' } },
];

const PLAYER_MANAGER_TAG = 'Guid_PLAYER_MANAGER_SAVE';
const GHOST_PREFIX = asciiBytes('Ghost_');
const END_HEADER = asciiBytes('END_HEADER');

export class SaveFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaveFormatError';
  }
}

export class UnsupportedEditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedEditError';
  }
}

function parseHeader(bytes) {
  if (bytes.length < 32) throw new SaveFormatError('File is too small to be a Nivalis Nights save');
  const version = readInt32(bytes, 0);
  if (version !== SUPPORTED_VERSION) {
    throw new SaveFormatError(`Unsupported save version ${version} (this editor supports ${SUPPORTED_VERSION})`);
  }
  let pos = 24;
  const guidCount = readInt32(bytes, pos);
  pos += 4;
  if (guidCount < 0 || guidCount > 1000) throw new SaveFormatError(`Implausible header GUID count ${guidCount}`);
  const guids = [];
  for (let i = 0; i < guidCount; i++) {
    const s = readString(bytes, pos);
    guids.push(s.value);
    pos = s.end;
  }
  const endHeader = indexOf(bytes, END_HEADER, pos);
  if (endHeader < 0 || endHeader > 64 * 1024) throw new SaveFormatError('END_HEADER marker not found');
  return {
    version,
    sceneIndex: readInt32(bytes, 4),
    playtimeSeconds: readFloat32(bytes, 8),
    savedAt: new Date(readInt32(bytes, 12) * 1000),
    gameSeconds: readInt32(bytes, 16),
    moneyCents: readInt32(bytes, 20),
    moneyOffset: 20,
    guids,
    end: endHeader + END_HEADER.length,
  };
}

// Finds every Ghost block by validating that its end offset points exactly past a matching closing tag.
export function indexGhostBlocks(bytes) {
  const blocks = [];
  let i = indexOf(bytes, GHOST_PREFIX, 0);
  while (i !== -1) {
    const len = bytes[i - 1];
    let next = i + 1;
    if (len > GHOST_PREFIX.length && len < 128 && i + len + 4 <= bytes.length) {
      const tagEnd = i + len;
      const end = readInt32(bytes, tagEnd);
      const close = end - 1 - len;
      if (end > tagEnd + 4 && end <= bytes.length && close >= tagEnd + 4 && bytes[close] === len
          && bytesEqual(bytes.subarray(close + 1, end), bytes.subarray(i, tagEnd))) {
        blocks.push({ start: i - 1, tag: readString(bytes, i - 1).value, endOffsetPos: tagEnd, end });
        next = tagEnd + 4;
      }
    }
    i = indexOf(bytes, GHOST_PREFIX, next);
  }
  return blocks;
}

function parseVariableTable(bytes, def) {
  const marker = encodeString(def.key);
  const at = indexOf(bytes, marker, 0);
  if (at < 0) throw new SaveFormatError(`Variable table ${def.key} not found`);
  let pos = at + marker.length;
  const count = readInt32(bytes, pos);
  pos += 4;
  if (count < 0 || count > 100000) throw new SaveFormatError(`Implausible variable count ${count} in ${def.key}`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = readString(bytes, pos);
    const typeCode = readInt32(bytes, name.end);
    const kind = def.types[typeCode];
    pos = name.end + 4;
    let value;
    const valueOffset = pos;
    if (kind === 'int') {
      value = readInt32(bytes, pos);
      pos += 4;
    } else if (kind === 'bool') {
      const raw = bytes[pos];
      if (raw > 1) throw new SaveFormatError(`Variable ${name.value} has non-boolean byte ${raw}`);
      value = raw === 1;
      pos += 1;
    } else if (kind === 'string') {
      const s = readString(bytes, pos);
      value = s.value;
      pos = s.end;
    } else {
      throw new SaveFormatError(`Unknown variable type ${typeCode} for ${name.value} in ${def.key}`);
    }
    entries.push({ name: name.value, kind, value, valueOffset });
  }
  return { id: def.id, key: def.key, start: at, end: pos, entries };
}

function locatePlayerMoney(bytes, ghostBlocks) {
  const at = indexOf(bytes, asciiBytes(PLAYER_MANAGER_TAG), 0);
  if (at < 1 || bytes[at - 1] !== PLAYER_MANAGER_TAG.length) throw new SaveFormatError('Player manager block not found');
  const ghostStart = at + PLAYER_MANAGER_TAG.length;
  const block = ghostBlocks.find((b) => b.start === ghostStart);
  if (!block) throw new SaveFormatError('Player Ghost block not found after player manager tag');
  return { offset: block.end, value: readInt32(bytes, block.end) };
}

export function parseSave(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = parseHeader(bytes);
  const ghostBlocks = indexGhostBlocks(bytes);
  if (ghostBlocks.length === 0) throw new SaveFormatError('No Ghost blocks found');
  const tables = VARIABLE_TABLES.map((def) => parseVariableTable(bytes, def));
  const playerMoney = locatePlayerMoney(bytes, ghostBlocks);

  const warnings = [];
  if (playerMoney.value !== header.moneyCents) {
    warnings.push(`Header money (${header.moneyCents}) differs from player money (${playerMoney.value})`);
  }
  const [primary, mirror] = tables;
  let tablesConsistent = primary.entries.length === mirror.entries.length;
  if (tablesConsistent) {
    for (let i = 0; i < primary.entries.length; i++) {
      const a = primary.entries[i];
      const b = mirror.entries[i];
      if (a.name !== b.name || a.kind !== b.kind || a.value !== b.value) {
        tablesConsistent = false;
        warnings.push(`Variable tables disagree at ${a.name}`);
        break;
      }
    }
  } else {
    warnings.push('Variable tables have different lengths');
  }

  return { bytes, header, ghostBlocks, tables, playerMoney, tablesConsistent, warnings };
}

// Variables as a flat, UI-friendly list; group is the articy namespace before the first dot.
export function listVariables(save) {
  return save.tables[0].entries.map(({ name, kind, value }) => {
    const dot = name.indexOf('.');
    return { name, group: dot > 0 ? name.slice(0, dot) : '', key: dot > 0 ? name.slice(dot + 1) : name, kind, value };
  });
}

export function summarize(save) {
  const { header } = save;
  return {
    version: header.version,
    sceneIndex: header.sceneIndex,
    playtimeSeconds: header.playtimeSeconds,
    savedAt: header.savedAt.toISOString(),
    gameSeconds: header.gameSeconds,
    gameDay: Math.floor(header.gameSeconds / 86400),
    gameClock: formatClock(header.gameSeconds),
    moneyCents: header.moneyCents,
    variableCount: save.tables[0].entries.length,
    ghostBlockCount: save.ghostBlocks.length,
    fileSize: save.bytes.length,
    warnings: save.warnings,
  };
}

function formatClock(seconds) {
  const s = ((seconds % 86400) + 86400) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatCredits(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Returns a new byte array with the edits applied. `edits` = { moneyCents?, variables?: { name: value } }.
// Only same-size edits are supported; the result is re-parsed and verified before being returned.
export function applyEdits(save, edits) {
  const out = new Uint8Array(save.bytes);
  const changedOffsets = new Set();
  const write32 = (pos, v) => { writeInt32(out, pos, v); for (let i = 0; i < 4; i++) changedOffsets.add(pos + i); };

  if (edits.moneyCents !== undefined) {
    const cents = edits.moneyCents;
    if (!Number.isInteger(cents) || cents < 0 || cents > INT32_MAX) {
      throw new UnsupportedEditError(`Money must be a whole number of cents between 0 and ${INT32_MAX}`);
    }
    if (save.playerMoney.value !== save.header.moneyCents) {
      throw new UnsupportedEditError('Money copies disagree in this save; refusing to edit money');
    }
    write32(save.header.moneyOffset, cents);
    write32(save.playerMoney.offset, cents);
  }

  const varEdits = Object.entries(edits.variables ?? {});
  if (varEdits.length) {
    if (!save.tablesConsistent) throw new UnsupportedEditError('Variable tables disagree in this save; refusing to edit variables');
    const indexByName = new Map(save.tables[0].entries.map((e, i) => [e.name, i]));
    for (const [name, value] of varEdits) {
      const idx = indexByName.get(name);
      if (idx === undefined) throw new UnsupportedEditError(`Unknown variable ${name}`);
      for (const table of save.tables) {
        const entry = table.entries[idx];
        if (entry.kind === 'int') {
          if (!Number.isInteger(value) || value < -INT32_MAX - 1 || value > INT32_MAX) {
            throw new UnsupportedEditError(`${name} must be a 32-bit integer`);
          }
          write32(entry.valueOffset, value);
        } else if (entry.kind === 'bool') {
          if (typeof value !== 'boolean') throw new UnsupportedEditError(`${name} must be true or false`);
          out[entry.valueOffset] = value ? 1 : 0;
          changedOffsets.add(entry.valueOffset);
        } else {
          throw new UnsupportedEditError(`${name} is a text variable; text edits are not supported yet`);
        }
      }
    }
  }

  verifyEdited(save, out, edits, changedOffsets);
  return out;
}

function verifyEdited(original, bytes, edits, changedOffsets) {
  if (bytes.length !== original.bytes.length) throw new SaveFormatError('Edited file changed size');
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== original.bytes[i] && !changedOffsets.has(i)) {
      throw new SaveFormatError(`Unexpected byte change at 0x${i.toString(16)}`);
    }
  }
  const reparsed = parseSave(bytes);
  if (reparsed.ghostBlocks.length !== original.ghostBlocks.length) throw new SaveFormatError('Ghost block index changed after edit');
  if (!reparsed.tablesConsistent) throw new SaveFormatError('Variable tables inconsistent after edit');
  if (edits.moneyCents !== undefined
      && (reparsed.header.moneyCents !== edits.moneyCents || reparsed.playerMoney.value !== edits.moneyCents)) {
    throw new SaveFormatError('Money did not verify after edit');
  }
  const vars = new Map(reparsed.tables[0].entries.map((e) => [e.name, e.value]));
  for (const [name, value] of Object.entries(edits.variables ?? {})) {
    if (vars.get(name) !== value) throw new SaveFormatError(`${name} did not verify after edit`);
  }
}

// Re-encodes the parsed structures and compares them with the original bytes; proves the model is lossless.
export function roundTripCheck(save) {
  const problems = [];
  for (const [def, table] of VARIABLE_TABLES.map((d, i) => [d, save.tables[i]])) {
    const codeFor = Object.fromEntries(Object.entries(def.types).map(([code, kind]) => [kind, Number(code)]));
    const parts = [encodeString(def.key), int32Bytes(table.entries.length)];
    for (const e of table.entries) {
      parts.push(encodeString(e.name), int32Bytes(codeFor[e.kind]));
      if (e.kind === 'int') parts.push(int32Bytes(e.value));
      else if (e.kind === 'bool') parts.push(new Uint8Array([e.value ? 1 : 0]));
      else parts.push(encodeString(e.value));
    }
    const encoded = concat(parts);
    if (!bytesEqual(encoded, save.bytes.subarray(table.start, table.end))) {
      problems.push(`Variable table ${table.id} does not re-encode identically`);
    }
  }
  const money = save.header.moneyCents;
  if (readInt32(save.bytes, save.header.moneyOffset) !== money) problems.push('Header money mismatch');
  for (const b of save.ghostBlocks) {
    if (readInt32(save.bytes, b.endOffsetPos) !== b.end) problems.push(`Ghost block ${b.tag} offset mismatch`);
  }
  return problems;
}

function int32Bytes(v) {
  const b = new Uint8Array(4);
  writeInt32(b, 0, v);
  return b;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// Differences between two saves: header values and variables.
export function diffSaves(a, b) {
  const headerFields = ['sceneIndex', 'gameSeconds', 'moneyCents', 'playtimeSeconds'];
  const header = headerFields
    .filter((f) => a.header[f] !== b.header[f])
    .map((f) => ({ field: f, before: a.header[f], after: b.header[f] }));
  const before = new Map(a.tables[0].entries.map((e) => [e.name, e]));
  const variables = [];
  for (const e of b.tables[0].entries) {
    const old = before.get(e.name);
    if (!old) variables.push({ name: e.name, kind: e.kind, before: undefined, after: e.value });
    else if (old.value !== e.value) variables.push({ name: e.name, kind: e.kind, before: old.value, after: e.value });
    before.delete(e.name);
  }
  for (const old of before.values()) variables.push({ name: old.name, kind: old.kind, before: old.value, after: undefined });
  return { header, variables };
}
