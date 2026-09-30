import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSave, applyEdits, roundTripCheck, diffSaves, listVariables, summarize,
  UnsupportedEditError, SaveFormatError, formatCredits, currentGameDay,
} from '../core/index.js';
import { encodeString, readString } from '../core/binary.js';

// Sample saves live next to the project (the folder this repo sits in) unless NN_SAVE_DIR says otherwise.
const saveDir = process.env.NN_SAVE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const saveFiles = existsSync(saveDir) ? readdirSync(saveDir).filter((f) => f.endsWith('.sav')) : [];
const load = (f) => parseSave(new Uint8Array(readFileSync(join(saveDir, f))));

test('string encoding round-trips, including multi-byte length prefixes', () => {
  for (const s of ['', 'abc', 'x'.repeat(127), 'y'.repeat(128), 'z'.repeat(20000), 'Café ☕']) {
    const enc = encodeString(s);
    const dec = readString(enc, 0);
    assert.equal(dec.value, s);
    assert.equal(dec.end, enc.length);
  }
});

test('formatCredits', () => {
  assert.equal(formatCredits(155880), '1558.80');
  assert.equal(formatCredits(5), '0.05');
  assert.equal(formatCredits(0), '0.00');
});

test('rejects non-save input', () => {
  assert.throws(() => parseSave(new Uint8Array(100)), SaveFormatError);
});

test('sample saves are present', { skip: saveFiles.length === 0 && 'no sample saves found' }, () => {
  assert.ok(saveFiles.length > 0);
});

for (const file of saveFiles) {
  test(`${file}: parses, is consistent and re-encodes losslessly`, () => {
    const save = load(file);
    assert.deepEqual(save.warnings, []);
    assert.ok(save.tablesConsistent);
    assert.equal(save.header.moneyCents, save.playerMoney.value);
    assert.ok(save.ghostBlocks.length > 1000);
    assert.deepEqual(roundTripCheck(save), []);
    const vars = listVariables(save);
    assert.ok(vars.length > 1000);
    assert.equal(summarize(save).variableCount, vars.length);
  });

  test(`${file}: money and variable edits verify and touch only intended bytes`, () => {
    const save = load(file);
    const vars = listVariables(save);
    const intVar = vars.find((v) => v.kind === 'int');
    const boolVar = vars.find((v) => v.kind === 'bool');
    const edited = applyEdits(save, {
      moneyCents: save.header.moneyCents + 1,
      variables: { [intVar.name]: intVar.value + 7, [boolVar.name]: !boolVar.value },
    });
    let changed = 0;
    for (let i = 0; i < edited.length; i++) if (edited[i] !== save.bytes[i]) changed++;
    assert.ok(changed >= 4 && changed <= 4 * 2 + 4 * 2 + 2, `changed ${changed} bytes`);

    const re = parseSave(edited);
    assert.equal(re.header.moneyCents, save.header.moneyCents + 1);
    assert.equal(re.playerMoney.value, save.header.moneyCents + 1);
    assert.ok(re.tablesConsistent);
    const d = diffSaves(save, re);
    assert.deepEqual(d.variables.map((v) => v.name).sort(), [intVar.name, boolVar.name].sort());
    // original buffer untouched
    assert.equal(load(file).header.moneyCents, save.header.moneyCents);
  });
}

for (const file of saveFiles) {
  test(`${file}: inventory edits add, change and remove items and keep the save consistent`, () => {
    const save = load(file);
    const player = save.inventory.containers.find((c) => c.kind === 'player');
    assert.ok(player, 'player inventory present');
    const vendorWithStock = save.inventory.containers.find((c) => c.kind === 'vendor' && c.items.length > 2);
    const newGuid = vendorWithStock.items[0].guid;
    const day = currentGameDay(save);

    // add a new item (grows the file), bump a quantity, and drop an item from a vendor (shrinks it)
    const playerItems = [
      ...player.items.map((it, i) => (i === 0 ? { ...it, stacks: it.stacks.map((s) => ({ ...s, quantity: s.quantity + 5 })) } : it)),
      { guid: newGuid, stacks: [{ price: 0, day, quantity: 3, freshness: 0 }] },
    ];
    const vendorItems = vendorWithStock.items.slice(1);
    const edited = applyEdits(save, {
      moneyCents: save.header.moneyCents + 100,
      inventory: { [player.key]: playerItems, [vendorWithStock.key]: vendorItems },
    });

    const re = parseSave(edited);
    assert.deepEqual(re.warnings, []);
    assert.deepEqual(roundTripCheck(re), []);
    assert.equal(re.ghostBlocks.length, save.ghostBlocks.length);
    assert.equal(re.header.moneyCents, save.header.moneyCents + 100);
    assert.equal(re.playerMoney.value, save.header.moneyCents + 100);
    const rePlayer = re.inventory.containers.find((c) => c.kind === 'player');
    assert.deepEqual(rePlayer.items, playerItems);
    assert.deepEqual(re.inventory.containers.find((c) => c.key === vendorWithStock.key).items, vendorItems);
    assert.deepEqual(diffSaves(save, re).variables, []);
    const expectedDelta = (37 + 4 + 16) - (37 + 4 + 16 * vendorWithStock.items[0].stacks.length);
    assert.equal(edited.length - save.bytes.length, expectedDelta);
  });
}

test('rejects invalid inventory edits', { skip: saveFiles.length === 0 && 'no sample saves found' }, () => {
  const save = load(saveFiles[0]);
  const key = save.inventory.containers.find((c) => c.kind === 'player').key;
  const good = { price: 0, day: 1, quantity: 1, freshness: 0 };
  const guid = save.inventory.containers.find((c) => c.items.length).items[0].guid;
  assert.throws(() => applyEdits(save, { inventory: { nope: [] } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { inventory: { [key]: [{ guid: 'not-a-guid', stacks: [good] }] } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { inventory: { [key]: [{ guid, stacks: [] }] } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { inventory: { [key]: [{ guid, stacks: [{ ...good, quantity: 0 }] }] } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { inventory: { [key]: [{ guid, stacks: [{ ...good, quantity: 1.5 }] }] } }), UnsupportedEditError);
});

test('rejects unsupported edits',{ skip: saveFiles.length === 0 && 'no sample saves found' }, () => {
  const save = load(saveFiles[0]);
  const strVar = listVariables(save).find((v) => v.kind === 'string');
  assert.throws(() => applyEdits(save, { variables: { [strVar.name]: 'x' } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { moneyCents: -1 }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { moneyCents: 1.5 }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { variables: { 'Nope.Nope': 1 } }), UnsupportedEditError);
  const boolVar = listVariables(save).find((v) => v.kind === 'bool');
  assert.throws(() => applyEdits(save, { variables: { [boolVar.name]: 1 } }), UnsupportedEditError);
});
