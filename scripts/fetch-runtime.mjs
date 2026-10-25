// Release-build helper only. End users receive this runtime inside the app.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { version: { type: 'string', default: '24.21.0' }, platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch }, out: { type: 'string', default: '.runtime' } } });
const { version, platform, arch } = values;
if (!/^24\.\d+\.\d+$/.test(version) || !['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Expected pinned Node 24.x runtime on darwin/linux arm64/x64.');
const name = `node-v${version}-${platform}-${arch}`;
const out = resolve(values.out);
const target = join(out, name);
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response;
}
const sums = await (await get(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').map((s) => s.trim().split(/\s+/)).find((p) => p[1] === `${name}.tar.gz`)?.[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official checksum for the requested archive is missing.');
if (existsSync(join(target, 'archive.sha256')) && readFileSync(join(target, 'archive.sha256'), 'utf8').trim() === expected && existsSync(join(target, 'bin', 'node'))) {
  console.log(join(target, 'bin', 'node'));
} else {
  const temp = mkdtempSync(join(tmpdir(), 'agentshark-runtime-'));
  try {
    const bytes = Buffer.from(await (await get(`https://nodejs.org/dist/v${version}/${name}.tar.gz`)).arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node archive SHA-256 does not match the official checksum.');
    const archive = join(temp, 'runtime.tar.gz');
    writeFileSync(archive, bytes);
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    if (listing.status !== 0 || listing.stdout.split('\n').filter(Boolean).some((p) => !p.startsWith(`${name}/`) || p.split('/').includes('..'))) throw new Error('Unexpected runtime archive layout.');
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', temp], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(`Runtime extraction failed: ${unpack.stderr}`);
    writeFileSync(join(temp, name, 'archive.sha256'), expected + '\n');
    mkdirSync(out, { recursive: true });
    if (existsSync(target)) throw new Error(`Unverified runtime directory already exists: ${target}. Choose another --out directory.`);
    renameSync(join(temp, name), target);
    console.log(join(target, 'bin', 'node'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
