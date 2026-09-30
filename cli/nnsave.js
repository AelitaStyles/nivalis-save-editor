#!/usr/bin/env node
// Command-line companion to the editor, mainly for development and verification.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  parseSave, summarize, listVariables, diffSaves, applyEdits, roundTripCheck, formatCredits,
} from '../core/index.js';

const USAGE = `Usage:
  nnsave info <file.sav>
  nnsave vars <file.sav> [filter]
  nnsave diff <old.sav> <new.sav>
  nnsave check <file.sav>...
  nnsave edit <file.sav> [--money <credits>] [--set Name.Var=value]... (-o <out.sav> | --in-place)`;

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
      let out;
      let inPlace = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--money') edits.moneyCents = parseCredits(rest[++i]);
        else if (a === '--set') {
          const [name, raw] = rest[++i].split('=');
          edits.variables[name] = parseValue(raw);
        } else if (a === '-o') out = rest[++i];
        else if (a === '--in-place') inPlace = true;
        else throw new Error(`Unknown option ${a}`);
      }
      if (!out && !inPlace) throw new Error('Specify -o <out.sav> or --in-place');
      const edited = applyEdits(load(path), edits);
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
