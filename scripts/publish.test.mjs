import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual Bash script while replacing the machine and service boundaries.
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'island-publish-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'installation with spaces');
  const release = path.join(directory, 'release');
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'commands');
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(release, 'deploy'), { recursive: true });
  await mkdir(bin);
  const { cp } = await import('node:fs/promises');
  await cp(new URL('../deploy/publish.sh', import.meta.url), path.join(release, 'deploy/publish.sh'));
  await cp(new URL('../deploy/publish.messages.sh', import.meta.url), path.join(release, 'deploy/publish.messages.sh'));
  await cp(new URL('../deploy/app.production.example.yaml', import.meta.url), path.join(release, 'deploy/app.production.example.yaml'));
  await writeFile(path.join(root, 'config/app.yaml'), 'existing configuration\n');
  const database = path.join(root, 'data/island.db');
  await writeFile(database, 'original');
  for (const suffix of ['-wal', '-shm']) await writeFile(database + suffix, 'original');
  const fake = async (name, source) => {
    const file = path.join(bin, name);
    await writeFile(file, '#!/bin/bash\nset -eu\n' + source);
    await chmod(file, 0o755);
  };
  await fake('id', 'if [[ "$1" == "-u" ]]; then echo "${EFFECTIVE_UID:-0}"; fi\n');
  await fake('sudo', 'export EFFECTIVE_UID=0\nunset SSH_CONNECTION\nexec "$@"\n');
  await fake('runuser', 'shift 3\nexec "$@"\n');
  await fake('systemctl', 'echo "systemctl $*" >> "$TEST_LOG"\nif [[ "$1" == "cat" ]]; then [[ "${UNIT_EXISTS:-yes}" == yes ]]; exit; fi\nif [[ "$1" == "show" ]]; then case "$3" in --property=WorkingDirectory) echo "${SERVICE_ROOT:-$TEST_ROOT}";; --property=User) echo island;; --property=ExecStart) echo "{ path=$TEST_ROOT/current/island ; argv[]=$TEST_ROOT/current/island serve -config $TEST_ROOT/config/app.yaml ; }";; esac; fi\nif [[ "$1" == "stop" && "${FAIL_STOP:-}" == yes ]]; then exit 1; fi\n');
  await fake('curl', 'echo "health" >> "$TEST_LOG"\n[[ "${FAIL_HEALTH:-}" != yes ]]\n');
  await fake('chown', ':\n');
  await fake('flock', ':\n');
  await fake('install', 'while (($#)); do case "$1" in -d) shift;; -m|-o|-g) shift 2;; *) mkdir -p -- "$1"; shift;; esac; done\n');
  await fake('mv', `if [[ "$1" == -fT ]]; then shift; exec "$TEST_NODE" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$2" "$3"; fi
exec /bin/mv "$@"
`);
  await fake('ffprobe', ':\n');
  const island = `#!/bin/bash
set -eu
echo "island $*" >> "$TEST_LOG"
if [[ "$1" == db-status ]]; then
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${DB_STATE:-current}" "$TEST_DB" "\${ACCOUNT_EXISTS:-true}" "\${DEMO_COMPLETE:-false}" 'http://127.0.0.1:8080' ffprobe "$TEST_ROOT/data/media" "$TEST_ROOT/data/tmp" "$TEST_ROOT/data/assets"
elif [[ "$1" == migrate ]]; then
  [[ "\${FAIL_MIGRATE:-}" != yes ]]
elif [[ "$1" == version ]]; then
  echo test
fi
`;
  await writeFile(path.join(release, 'island'), island);
  await chmod(path.join(release, 'island'), 0o755);
  const checksums = spawnSync('shasum', ['-a', '256', 'island', 'deploy/publish.sh', 'deploy/publish.messages.sh', 'deploy/app.production.example.yaml'], { cwd: release, encoding: 'utf8' });
  assert.equal(checksums.status, 0);
  await writeFile(path.join(release, 'SHA256SUMS'), checksums.stdout);
  // macOS has shasum; Linux production uses sha256sum.
  await fake('sha256sum', 'if [[ "$1" == "-c" ]]; then exec shasum -a 256 -c "$2"; fi\n');
  const run = (args = [], extra = {}, input = '') => spawnSync('bash', [path.join(release, 'deploy/publish.sh'), '--root', root, ...args], {
    encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_NODE: process.execPath, TEST_LOG: log, TEST_DB: database, TEST_ROOT: root, ...options, ...extra },
  });
  const commands = async () => readFile(log, 'utf8').catch(() => '');
  return { run, commands, database, root };
}

test('compatible deployment migrates before switching and checking health', async t => {
  const f = await fixture(t, { DB_STATE: 'pending' });
  const result = f.run(['--database', 'auto', '--seed', 'no']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(await readFile(path.join(f.root, 'config/app.yaml'), 'utf8'), 'existing configuration\n');
  const log = await f.commands();
  assert.ok(log.indexOf('systemctl stop') < log.indexOf('island migrate'));
  assert.ok(log.indexOf('island migrate') < log.indexOf('systemctl start'));
  assert.match(log, /health/);
});

test('incompatible auto mode exits without stopping or changing database', async t => {
  const f = await fixture(t, { DB_STATE: 'incompatible' });
  const result = f.run(['--database', 'auto', '--seed', 'no']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(await f.commands(), /systemctl stop|island migrate/);
  assert.equal(await readFile(f.database, 'utf8'), 'original');
});

test('existing real account rejects seed before maintenance writes', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run(['--database', 'auto', '--seed', 'yes']).status, 0);
  assert.doesNotMatch(await f.commands(), /systemctl stop|island seed-demo/);
});

test('failed stop leaves database, WAL and SHM intact', async t => {
  const f = await fixture(t, { FAIL_STOP: 'yes' });
  assert.notEqual(f.run(['--database', 'reset', '--seed', 'yes', '--confirm-reset']).status, 0);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(await readFile(f.database + suffix, 'utf8'), 'original');
});

test('failed migration never starts service or replaces current link', async t => {
  const f = await fixture(t, { DB_STATE: 'pending', FAIL_MIGRATE: 'yes' });
  assert.notEqual(f.run(['--database', 'auto', '--seed', 'no']).status, 0);
  assert.doesNotMatch(await f.commands(), /systemctl start|health/);
});

test('startup health failure reports failure while keeping new release selected', async t => {
  const f = await fixture(t, { FAIL_HEALTH: 'yes' });
  assert.notEqual(f.run(['--database', 'auto', '--seed', 'no']).status, 0);
  const { readlink } = await import('node:fs/promises');
  assert.match(await readlink(path.join(f.root, 'current')), /releases\/release$/);
});


test('first installation generates config and a usable service unit before maintenance', async t => {
  const f = await fixture(t, { UNIT_EXISTS: 'no', ACCOUNT_EXISTS: 'false', DB_STATE: 'missing' });
  await rm(path.join(f.root, 'config/app.yaml'));
  const result = f.run(['--database', 'auto', '--seed', 'yes', '--listen', '0.0.0.0:8080']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const unit = await readFile(path.join(f.root, 'config/island.service'), 'utf8');
  assert.ok(unit.includes(`WorkingDirectory=${f.root}/.\n`), unit);
  assert.ok(unit.includes(`ExecStart=:/usr/bin/env "${f.root}/current/island" serve -config "${f.root}/config/app.yaml"`), unit);
  assert.match(await f.commands(), /systemctl link.*island.service/);
  assert.match(await f.commands(), /island seed-demo/);
});

test('explicit reset removes database and sidecars after stopping', async t => {
  const f = await fixture(t);
  const result = f.run(['--database', 'reset', '--seed', 'yes', '--confirm-reset']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const { access } = await import('node:fs/promises');
  for (const suffix of ['', '-wal', '-shm']) await assert.rejects(access(f.database + suffix), { code: 'ENOENT' });
  const log = await f.commands();
  assert.ok(log.indexOf('systemctl stop') < log.indexOf('island migrate'));
  assert.ok(log.indexOf('island migrate') < log.indexOf('island seed-demo'));
});


test('an existing service for another installation is rejected before stopping', async t => {
  const f = await fixture(t, { SERVICE_ROOT: '/srv/another-island' });
  assert.notEqual(f.run(['--database', 'auto', '--seed', 'no']).status, 0);
  assert.doesNotMatch(await f.commands(), /systemctl stop|island migrate/);
});


// Standalone publication must work without a public address or SSH connection metadata.
test('first installation needs no origin or server address, including through sudo', async t => {
  const f = await fixture(t, { UNIT_EXISTS: 'no', ACCOUNT_EXISTS: 'false', DB_STATE: 'missing', SSH_CONNECTION: '', EFFECTIVE_UID: '1000' });
  await rm(path.join(f.root, 'config/app.yaml'));
  const result = f.run(['--database', 'auto', '--seed', 'yes', '--listen', '[::]:39001']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const configuration = await readFile(path.join(f.root, 'config/app.yaml'), 'utf8');
  assert.doesNotMatch(configuration, /^public_origin:/m);
  assert.match(await f.commands(), /systemctl start/);
});
