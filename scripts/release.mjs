import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// run keeps arguments separate from executable code and reports build diagnostics.
async function run(command, args, environment = process.env) {
  const result = await execute(command, args, { cwd: root, env: environment, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

// checksums records the actual release bytes in a portable, sorted manifest.
async function checksums(directory, relative = '') {
  const result = {};
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await checksums(directory, name));
    else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

// release builds into a fresh directory and never replaces an existing release.
export async function buildRelease(values = {}) {
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const dirty = (await execute('git', ['status', '--porcelain'], { cwd: root })).stdout.trim() !== '';
  const host = (await execute('go', ['env', 'GOOS', 'GOARCH'], { cwd: root })).stdout.trim().split('\n');
  const goos = values.goos ?? host[0];
  const goarch = values.goarch ?? host[1];
  if (!/^[a-z0-9]+$/.test(goos) || !/^[a-z0-9]+$/.test(goarch)) throw new Error('INVALID_GO_TARGET');
  const builtAt = new Date().toISOString();
  const version = `${revision}${dirty ? '-dirty' : ''}`;
  const name = `${revision.slice(0, 12)}${dirty ? '-dirty' : ''}-${builtAt.replace(/[-:.]/g, '')}-${goos}-${goarch}`;
  const outputRoot = path.resolve(values['output-root'] ?? path.join(root, '.local', 'releases'));
  await mkdir(outputRoot, { recursive: true });
  const directory = path.join(outputRoot, name);
  await mkdir(directory);
  try {
    await run('npm', ['run', 'typecheck']);
    await run('npm', ['exec', '--workspace', '@island/web', '--', 'vite', 'build', '--outDir', path.join(directory, 'web')]);
    const binary = path.join(directory, goos === 'windows' ? 'island.exe' : 'island');
    await run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.buildVersion=${version} -X main.buildTime=${builtAt}`, '-o', binary, './cmd/island'], { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' });
    await cp(path.join(root, 'deploy'), path.join(directory, 'deploy'), { recursive: true, errorOnExist: true, force: false });
    await cp(path.join(root, 'spec', 'ENGINEERING', 'OPERATIONS.md'), path.join(directory, 'operations.md'), { errorOnExist: true, force: false });
    const migrationFiles = await checksums(path.join(root, 'migrations'));
    const manifest = { version, revision, dirty, built_at: builtAt, goos, goarch, files: await checksums(directory), migrations: migrationFiles };
    await writeFile(path.join(directory, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await writeReleaseChecksums(directory);
    console.log(JSON.stringify({ event: '发布构建完成', directory, version, goos, goarch }));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// writeReleaseChecksums includes the release manifest while avoiding a self-referential hash.
export async function writeReleaseChecksums(directory) {
  const files = await checksums(directory);
  delete files.SHA256SUMS;
  await writeFile(path.join(directory, 'SHA256SUMS'), Object.entries(files)
    .map(([name, checksum]) => `${checksum}  ${name}`).join('\n') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'output-root': { type: 'string' }, goos: { type: 'string' }, goarch: { type: 'string' } } });
  buildRelease(values).catch((error) => {
    console.error(JSON.stringify({ event: '发布构建失败', error: error.message, stderr: error.stderr }));
    process.exitCode = 1;
  });
}
