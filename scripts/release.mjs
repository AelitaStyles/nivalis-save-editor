// Builds a distributable zip: tests -> portable release exe -> release/out/NivalisSaveEditor-v<version>.zip
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tauriConf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'))[1];
if (tauriConf.version !== version || cargoVersion !== version) {
  throw new Error(`Version mismatch: package.json ${version}, tauri.conf.json ${tauriConf.version}, Cargo.toml ${cargoVersion}`);
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
run('npm test');
run('npx tauri build --no-bundle');

const name = `NivalisSaveEditor-v${version}`;
const outDir = join(root, 'release', 'out');
const stage = join(outDir, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(join(root, 'src-tauri', 'target', 'release', 'nivalis-save-editor.exe'), join(stage, 'NivalisSaveEditor.exe'));
const readme = readFileSync(join(root, 'release', 'README.txt'), 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replace(/\r?\n/g, '\r\n');
writeFileSync(join(stage, 'README.txt'), readme);
// Ship the license text and copyright notice with every copy (CC BY-NC 4.0 attribution).
writeFileSync(join(stage, 'LICENSE.txt'), readFileSync(join(root, 'LICENSE.txt'), 'utf8').replace(/\r?\n/g, '\r\n'));

const zip = join(outDir, `${name}.zip`);
rmSync(zip, { force: true });
// Windows' bundled bsdtar writes zip archives with -a; Git Bash's GNU tar cannot.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', outDir, name], { stdio: 'inherit' });

const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
console.log(`\nRelease ready: ${zip}`);
console.log(`Size:   ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`SHA256: ${sha256}`);
