import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deploy, shellQuote, validateOptions } from './deploy.mjs';

// fixture runs the real process boundary with fake SSH/SCP executables and a tiny release.
async function fixture(t, settings = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'island-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const log = path.join(directory, 'calls.jsonl');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: require('node:path').basename(process.argv[1]), args }) + '\\n');
if (process.argv[1].endsWith('/scp') && process.env.FAKE_UPLOAD_FAIL) process.exit(9);
const command = args.at(-1);
if (command.includes('sha256sum -c') && process.env.FAKE_VERIFY_FAIL) process.exit(7);
if (command.includes('/deploy/publish.sh') && process.env.FAKE_PUBLISH_FAIL) process.exit(8);
if (command === 'uname -s; uname -m') process.stdout.write(process.env.FAKE_PLATFORM || 'Linux\\nx86_64\\n');
if (command === 'mktemp -d /tmp/island-upload.XXXXXXXX') process.stdout.write('/tmp/island-upload.abcd1234\\n');
`;
  for (const executable of ['ssh', 'scp']) {
    const file = path.join(bin, executable);
    await writeFile(file, fake);
    await chmod(file, 0o755);
  }
  const releaseDirectory = path.join(directory, 'release with spaces');
  await mkdir(path.join(releaseDirectory, 'deploy'), { recursive: true });
  await writeFile(path.join(releaseDirectory, 'deploy', 'publish.sh'), '#!/bin/bash\n');
  const builds = [];
  const messages = [];
  const dependencies = {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...settings },
    build: async (options) => { builds.push(options); return releaseDirectory; },
    output: (value) => messages.push(value),
  };
  return {
    dependencies, builds, messages,
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

const options = { host: '192.0.2.5', port: '2202', user: 'deploy', root: '/srv/island' };

test('deploy detects Linux architecture, uploads, then publishes with a terminal', async (t) => {
  const f = await fixture(t);
  const result = await deploy(options, f.dependencies);
  assert.deepEqual(f.builds, [{ goos: 'linux', goarch: 'amd64' }]);
  const calls = await f.calls();
  assert.deepEqual(calls.map((call) => call.command), ['ssh', 'ssh', 'scp', 'ssh', 'ssh']);
  assert.ok(calls[2].args.includes('-P'));
  assert.ok(calls[2].args.includes('2202'));
  assert.ok(calls.at(-1).args.includes('-t'));
  assert.match(calls.at(-1).args.at(-1), /bash '.*\/deploy\/publish.sh' --root '\/srv\/island'/);
  assert.match(result.publishCommand, /ssh/);
  assert.ok(!calls.at(-1).args.at(-1).includes("--server-host"));
});

test('upload-only preserves the uploaded release and returns its executable publication command', async (t) => {
  const f = await fixture(t, { FAKE_PLATFORM: 'Linux\naarch64\n' });
  const result = await deploy({ ...options, uploadOnly: true }, f.dependencies);
  assert.equal(f.builds[0].goarch, 'arm64');
  const calls = await f.calls();
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => !call.args.includes('-t')));
  assert.match(result.publishCommand, /--root/);
});

test('upload failure never extracts or publishes', async (t) => {
  const f = await fixture(t, { FAKE_UPLOAD_FAIL: '1' });
  await assert.rejects(deploy(options, f.dependencies));
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).command, 'scp');
});

test('unsupported targets stop before build and upload', async (t) => {
  const f = await fixture(t, { FAKE_PLATFORM: 'Darwin\narm64\n' });
  await assert.rejects(deploy(options, f.dependencies), /DEPLOY_TARGET_UNSUPPORTED/);
  assert.equal(f.builds.length, 0);
  assert.equal((await f.calls()).length, 1);
});

test('shell quoting preserves spaces, apostrophes, and command substitutions as literal path data', async (t) => {
  const f = await fixture(t);
  const root = "/srv/family's island $(touch /tmp/injected)";
  await deploy({ ...options, root }, f.dependencies);
  assert.ok((await f.calls()).at(-1).args.at(-1).includes(`--root ${shellQuote(root)}`));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('invalid connection parameters fail before spawning any command', () => {
  for (const invalid of [{ host: '-oProxyCommand=bad' }, { host: 'example.com;bad' }, { port: '0' }, { port: '65536' }, { user: '-root' }, { root: 'relative/path' }, { root: '/srv/a\nb' }]) {
    assert.throws(() => validateOptions({ ...options, ...invalid }), /DEPLOY_/);
  }
  assert.equal(validateOptions({ ...options, host: '2001:db8::1' }).host, '2001:db8::1');
});


test('remote checksum failure prevents publication', async (t) => {
  const f = await fixture(t, { FAKE_VERIFY_FAIL: '1' });
  await assert.rejects(deploy(options, f.dependencies));
  assert.equal((await f.calls()).length, 4);
  assert.ok((await f.calls()).every((call) => !call.args.includes('-t')));
});

test('publication failure reports failure without a success message', async (t) => {
  const f = await fixture(t, { FAKE_PUBLISH_FAIL: '1' });
  await assert.rejects(deploy(options, f.dependencies), /SSH_PUBLISH_FAILED/);
  assert.equal((await f.calls()).length, 5);
  assert.ok(!f.messages.some((message) => message.includes('执行成功')));
});
