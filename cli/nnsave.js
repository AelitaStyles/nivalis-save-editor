#!/usr/bin/env node
// Command-line companion to the editor, mainly for development and verification.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  parseSave, summarize, listVariables, diffSaves, applyEdits, roundTripCheck, formatCredits, currentGameDay,
} from '../core/index.js';

const { items: CATALOG } = JSON.parse(readFileSync(new URL('../src/data/items.json', import.meta.url), 'utf8'));
const itemName = (guid) => CATALOG[guid]?.name ?? `Unknown item ${guid}`;

function findItem(query) {
  if (CATALOG[query]) return query;
  const matches = Object.entries(CATALOG).filter(([, e]) => e.name.toLowerCase() === query.toLowerCase());
  if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Unknown'} item "${query}" (use the item GUID)`);
  return matches[0][0];
}

const USAGE = `Usage:
  nnsave info <file.sav>
  nnsave vars <file.sav> [filter]
  nnsave diff <old.sav> <new.sav>
  nnsave check <file.sav>...
  nnsave inv <file.sav> [container]
  nnsave edit <file.sav> [--money <credits>] [--set Name.Var=value]... [--add-item <container>:<item>:<qty>]...
              (-o <out.sav> | --in-place)`;

const load = (path) => parseSave(new Uint8Array(readFileSync(path)));
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  throw new Error(`Cannot parse value "${raw}" (use an integer, true or false)`);
}

function parseCredits(raw) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw new Error(`Invalid credit amount "${raw}" (e.g. 1558.80)`);
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'info': {
      const s = summarize(load(args[0]));
      console.log(`Saved at      ${s.savedAt}`);
      console.log(`Scene index   ${s.sceneIndex}`);
      console.log(`Playtime      ${(s.playtimeSeconds / 3600).toFixed(2)} h`);
      console.log(`In-game time  day ${s.gameDay}, ${s.gameClock}`);
      console.log(`Money         ${formatCredits(s.moneyCents)} credits`);
      console.log(`Variables     ${s.variableCount}`);
      console.log(`Ghost blocks  ${s.ghostBlockCount}`);
      for (const w of s.warnings) console.log(`WARNING       ${w}`);
      return 0;
    }
    case 'vars': {
      const filter = (args[1] ?? '').toLowerCase();
      for (const v of listVariables(load(args[0]))) {
        if (!filter || v.name.toLowerCase().includes(filter)) console.log(`${v.name.padEnd(60)} ${v.kind.padEnd(6)} ${show(v.value)}`);
      }
      return 0;
    }
    case 'inv': {
      const save = load(args[0]);
      for (const c of save.inventory.containers) {
        if (args[1] ? c.key !== args[1] : !c.items.length || c.kind === 'vendor') continue;
        console.log(`
${c.key} (${c.kind}${c.storage ? `, ${c.storage}` : ''}, ${c.items.length} items)`);
        for (const it of c.items) {
          const qty = it.stacks.reduce((n, s) => n + s.quantity, 0);
          console.log(`  ${itemName(it.guid).padEnd(36)} x${String(qty).padEnd(5)} ${it.stacks.map((s) => `[${s.quantity} @${formatCredits(s.price)} day ${s.day} fresh ${s.freshness}]`).join(' ')}`);
        }
      }
      return 0;
    }
    case 'diff': {
      const d = diffSaves(load(args[0]), load(args[1]));
      for (const h of d.header) console.log(`[header] ${h.field}: ${h.before} -> ${h.after}`);
      for (const v of d.variables) console.log(`${v.name}: ${show(v.before)} -> ${show(v.after)}`);
      console.log(`${d.variables.length} variable(s) changed`);
      return 0;
    }
    case 'check': {
      let failed = 0;
      for (const path of args) {
        try {
          const save = load(path);
          const problems = [...save.warnings, ...roundTripCheck(save)];
          console.log(`${problems.length ? 'FAIL' : 'OK  '} ${path}${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`);
          if (problems.length) failed++;
        } catch (e) {
          console.log(`FAIL ${path}\n     ${e.message}`);
          failed++;
        }
      }
      return failed ? 1 : 0;
    }
    case 'edit': {
      const [path, ...rest] = args;
      const edits = { variables: {} };
      const addItems = [];
      let out;
      let inPlace = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--money') edits.moneyCents = parseCredits(rest[++i]);
        else if (a === '--set') {
          const [name, raw] = rest[++i].split('=');
          edits.variables[name] = parseValue(raw);
        } else if (a === '--add-item') addItems.push(rest[++i]);
        else if (a === '-o') out = rest[++i];
        else if (a === '--in-place') inPlace = true;
        else throw new Error(`Unknown option ${a}`);
      }
      if (!out && !inPlace) throw new Error('Specify -o <out.sav> or --in-place');
      const save = load(path);
      if (addItems.length) {
        edits.inventory = {};
        for (const spec of addItems) {
          const [key, query, qtyRaw] = spec.split(':');
          const container = save.inventory.containers.find((c) => c.key === key);
          if (!container) throw new Error(`Unknown container "${key}"`);
          const guid = findItem(query);
          const quantity = Number(qtyRaw ?? 1);
          const items = (edits.inventory[key] ??= structuredClone(container.items));
          const stack = { price: 0, day: currentGameDay(save), quantity, freshness: CATALOG[guid]?.freshness ?? 0 };
          const existing = items.find((it) => it.guid === guid);
          if (existing) existing.stacks.push(stack);
          else items.push({ guid, stacks: [stack] });
        }
      }
      const edited = applyEdits(save, edits);
      const target = out ?? path;
      if (inPlace) {
        const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        copyFileSync(path, backup);
        console.log(`Backup written to ${backup}`);
      } else if (existsSync(target)) {
        throw new Error(`${target} already exists`);
      }
      writeFileSync(target, edited);
      console.log(`Wrote ${target}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
}
