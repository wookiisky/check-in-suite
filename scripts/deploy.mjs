import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildRelease } from './release.mjs';

const executeFile = promisify(execFile);
const messages = JSON.parse(await readFile(new URL('./deploy-content.json', import.meta.url), 'utf8'));

// text reads CLI copy from the resource file and substitutes explicit values.
function text(key, values = {}) {
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), messages[key]);
}

// shellQuote preserves one literal argument in the shell used by the SSH server.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// validateOptions rejects SSH option injection before connecting to the server.
export function validateOptions(options) {
  const host = options.host?.replace(/^\[(.*)\]$/, '$1');
  if (!host || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|[a-fA-F0-9]*:[a-fA-F0-9:]+)$/.test(host)) throw new Error('DEPLOY_HOST_INVALID');
  const port = String(options.port ?? '22');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('DEPLOY_PORT_INVALID');
  const user = options.user ?? userInfo().username;
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(user)) throw new Error('DEPLOY_USER_INVALID');
  const root = options.root ?? '/srv/island';
  if (!root.startsWith('/') || path.posix.normalize(root) === '/' || /[\x00-\x1f\x7f]/.test(root)) throw new Error('DEPLOY_ROOT_INVALID');
  return { host, port, user, root, uploadOnly: Boolean(options.uploadOnly) };
}

// terminalCommand shares the local terminal with SSH for remote release questions.
async function terminalCommand(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`SSH_PUBLISH_FAILED (${signal ?? code})`)));
  });
}

// deploy builds for the inspected server and uploads before invoking its release script.
export async function deploy(rawOptions, { build = buildRelease, env = process.env, output = console.log } = {}) {
  const options = validateOptions(rawOptions);
  const connection = ['-p', options.port, '-l', options.user, '--', options.host];
  const remote = async (command) => {
    const result = await executeFile('ssh', [...connection, command], { env, maxBuffer: 16 * 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout.trim();
  };
  const platform = (await remote('uname -s; uname -m')).split(/\r?\n/);
  const goarch = { x86_64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[platform[1]];
  if (platform[0] !== 'Linux' || !goarch) throw new Error('DEPLOY_TARGET_UNSUPPORTED');
  output(text('target', { architecture: goarch }));
  const releaseDirectory = await build({ goos: 'linux', goarch });
  const stage = await remote('mktemp -d /tmp/island-upload.XXXXXXXX');
  if (!/^\/tmp\/island-upload\.[a-zA-Z0-9]+$/.test(stage)) throw new Error('DEPLOY_REMOTE_DIRECTORY_INVALID');
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'island-package-'));
  try {
    const archive = path.join(temporaryDirectory, 'release.tar.gz');
    const name = path.basename(releaseDirectory);
    await executeFile('tar', ['-czf', archive, '-C', path.dirname(releaseDirectory), '--', name], { env });
    const scpHost = options.host.includes(':') ? `[${options.host}]` : options.host;
    await executeFile('scp', ['-P', options.port, '--', archive, `${options.user}@${scpHost}:${stage}/release.tar.gz`], { env });
    const remoteDirectory = `${stage}/${name}`;
    await remote(`tar -xzf ${shellQuote(`${stage}/release.tar.gz`)} -C ${shellQuote(stage)} && cd ${shellQuote(remoteDirectory)} && sha256sum -c SHA256SUMS`);
    output(text('uploaded', { directory: remoteDirectory }));
    const command = `bash ${shellQuote(`${remoteDirectory}/deploy/publish.sh`)} --root ${shellQuote(options.root)}`;
    const publishArguments = ['-t', ...connection, command];
    const publishCommand = ['ssh', ...publishArguments].map(shellQuote).join(' ');
    output(text('publish_command', { command: publishCommand }));
    if (!options.uploadOnly) {
      await terminalCommand('ssh', publishArguments, env);
      output(text('completed'));
    }
    return { releaseDirectory, remoteDirectory, publishCommand };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// main accepts explicit flags in automation and prompts for missing values at a terminal.
async function main() {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, port: { type: 'string' }, user: { type: 'string' }, root: { type: 'string' },
    'upload-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(text('usage')); return; }
  if (process.stdin.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const [key, fallback] of [['host', ''], ['port', '22'], ['user', userInfo().username], ['root', '/srv/island']]) {
        if (values[key] === undefined) values[key] = (await terminal.question(text(`${key}_prompt`, { default: fallback }))).trim() || fallback;
      }
    } finally { terminal.close(); }
  }
  if (!values.host) throw new Error('DEPLOY_HOST_REQUIRED');
  await deploy({ ...values, uploadOnly: values['upload-only'] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(text('failed', { error: messages.errors[error.message] ?? error.message }));
    if (error.stderr) process.stderr.write(error.stderr);
    process.exitCode = 1;
  });
}
