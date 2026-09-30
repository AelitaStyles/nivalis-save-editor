import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSave, applyEdits, roundTripCheck, diffSaves, listVariables, summarize,
  UnsupportedEditError, SaveFormatError, formatCredits,
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

test('rejects unsupported edits', { skip: saveFiles.length === 0 && 'no sample saves found' }, () => {
  const save = load(saveFiles[0]);
  const strVar = listVariables(save).find((v) => v.kind === 'string');
  assert.throws(() => applyEdits(save, { variables: { [strVar.name]: 'x' } }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { moneyCents: -1 }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { moneyCents: 1.5 }), UnsupportedEditError);
  assert.throws(() => applyEdits(save, { variables: { 'Nope.Nope': 1 } }), UnsupportedEditError);
  const boolVar = listVariables(save).find((v) => v.kind === 'bool');
  assert.throws(() => applyEdits(save, { variables: { [boolVar.name]: 1 } }), UnsupportedEditError);
});
