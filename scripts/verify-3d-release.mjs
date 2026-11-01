import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = process.argv[2];
const servers = new Set(); // 只保存本脚本创建的进程，不按名称或端口终止其他服务。
const account = { username: 'p1-release-check', login: 'P1-Release-Login-2026', management: 'P1-Release-Manage-2026' }; // 仅写入临时测试库。
let temporary;
let interrupted = false;

// 输出只包含步骤、版本、资源校验与计数，不输出命令输入或认证响应。
function report(step, fields = {}) { console.log(JSON.stringify({ step, ...fields })); }
function check(condition, message) { if (!condition) throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

// 用参数数组调用进程，捕获而不输出初始化提示、密码与进程日志。
function command(executable, args, input = '', timeout = 30_000) {
  const result = spawnSync(executable, args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  check(!result.error && result.status === 0, `${path.basename(executable)} ${args[0] ?? ''} 未成功退出`);
  return result.stdout;
}

// 每次监听前取得一个空闲临时端口；启动后还需收到自己进程的已绑定日志。
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

// 超时只终止等待；所属进程由统一 finally 清理。
async function deadline(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// 配置中的数据库与所有持久目录均位于本次 mkdtemp 内。
async function configuration(directory, staticDirectory) {
  const port = await freePort();
  const configPath = path.join(directory, 'app.yaml');
  const values = {
    listen_address: `127.0.0.1:${port}`, database_path: path.join(directory, 'island.db'),
    media_directory: path.join(directory, 'media'), assets_directory: path.join(directory, 'assets'),
    temp_directory: path.join(directory, 'uploads-tmp'), static_directory: staticDirectory,
    sqlite_busy_timeout: '1s', http_timeout: '10s', ffprobe_path: 'ffprobe', media_probe_timeout: '2s', upload_timeout: '10s',
  };
  await writeFile(configPath, Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  return { path: configPath, database: values.database_path, origin: `http://127.0.0.1:${port}` };
}

// 只有自己的二进制确认绑定成功后才请求该端口，避免端口竞争时误访问未知服务。
async function startServer(binary, config) {
  const child = spawn(binary, ['serve', '-config', config.path], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let startedResolve, startedReject, exitedResolve;
  const started = new Promise((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
  const exited = new Promise((resolve) => { exitedResolve = resolve; });
  const item = { child, exited, done: false };
  servers.add(item);
  let partial = '';
  child.stderr.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.msg === '服务启动成功' && `http://${event.address}` === config.origin) startedResolve();
      } catch { /* 非结构化依赖日志不作为启动证据，也不公开。 */ }
    }
    if (partial.length > 65_536) partial = partial.slice(-65_536);
  });
  child.once('error', () => { item.done = true; startedReject(new Error('发行进程无法启动')); exitedResolve({ code: null }); });
  child.once('exit', (code, signal) => { item.done = true; exitedResolve({ code, signal }); });
  await deadline(Promise.race([started, exited.then(() => { throw new Error('发行进程在绑定前退出'); })]), 30_000, '发行进程未在期限内绑定端口');
  const readiness = await fetch(`${config.origin}/health/ready`, { signal: AbortSignal.timeout(10_000) });
  check(readiness.status === 200, '发行进程就绪检查失败');
  return item;
}

// 仅向持有的 ChildProcess 发送信号，并等待它退出后才清理临时文件。
async function stopServer(item) {
  if (!item.done) {
    item.child.kill('SIGTERM');
    try { await deadline(item.exited, 12_000, '发行进程优雅退出超时'); }
    catch { if (!item.done) item.child.kill('SIGKILL'); await deadline(item.exited, 5_000, '发行进程无法退出'); }
  }
  servers.delete(item);
}

// 会话只保存在内存；每次重启后重新登录，不复用原 Cookie 或 CSRF。
async function client(origin) {
  let cookie = '', csrf = '';
  const request = async (route, method = 'GET', body, expected = 200) => {
    let response;
    try {
      response = await fetch(origin + route, {
        method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error(`${method} ${route} 请求失败`); }
    check(response.status === expected, `${method} ${route} 状态不符：${response.status}，预期 ${expected}`);
    return response;
  };
  const login = await request('/api/v1/auth/login', 'POST', { username: account.username, password: account.login });
  const session = await login.json();
  cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0]; csrf = session.csrf_token;
  check(cookie && typeof csrf === 'string' && csrf.length > 0, '登录未返回有效会话');
  return { request, json: async (...args) => (await request(...args)).json() };
}

// 用当前源码 builtin 核实正式发行进程返回的实际字节与类型。
async function verifyAssets(api) {
  const keys = [
    ['character-medium-v1', 'glb'], ['character-exercise-v1', 'glb'],
    ...['wall', 'doorway', 'floor', 'roof'].map((key) => [`camp-${key}-v1`, 'glb']),
    ...['hair', 'upper', 'lower', 'shoes'].flatMap((slot) => ['rogue', 'barbarian'].map((variant) => [`wearable-${slot}-${variant}-v1`, 'png'])),
  ];
  const result = [];
  for (const [key, extension] of keys) {
    const response = await api.request(`/api/v1/assets/${key}`);
    const expectedMIME = extension === 'glb' ? 'model/gltf-binary' : 'image/png';
    check(response.headers.get('content-type')?.split(';')[0] === expectedMIME, `${key} MIME 不符`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(path.join(root, 'internal', 'assets', 'builtin', `${key}.${extension}`));
    const hash = sha256(bytes);
    check(bytes.length === expected.length && hash === sha256(expected), `${key} 发行字节与 builtin 不同`);
    if (extension === 'glb') check(bytes.subarray(0, 4).toString() === 'glTF', `${key} 不是实际 GLB`);
    result.push({ key, sha256: hash, bytes: bytes.length, mime: expectedMIME });
  }
  return result;
}

// 构造完整请求时只选择可写字段，不把响应目录或库存重新提交。
function appearanceInput(state) {
  return { expected_version: state.version, character_key: state.character_key, hair_purchase_id: state.hair_purchase_id, upper_purchase_id: state.upper_purchase_id, lower_purchase_id: state.lower_purchase_id, shoes_purchase_id: state.shoes_purchase_id };
}
function layoutInput(state) { return { expected_version: state.version, scene_key: state.scene_key, environment_key: state.environment_key, placements: state.placements }; }

const oldSchemaBuilder = `
import sqlite3,json,sys
p=json.load(sys.stdin);c=sqlite3.connect(p['database']);c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA foreign_keys=ON')
for migration in p['migrations']:
 c.executescript(migration['sql'])
 c.execute('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)',(migration['version'],migration['name'],migration['checksum'],1700000000000));c.commit()
c.execute("INSERT INTO accounts(id,username,display_name,login_password_hash,management_password_hash,created_at,updated_at) VALUES (1,'old-schema-check','旧库保留验证','unusable-old-hash','unusable-old-hash',1700000000000,1700000000000)")
c.execute('INSERT INTO wallets(account_id,coins,diamonds,version) VALUES (1,17,3,1)');c.commit();c.close()
`;
const logicalSnapshot = `
import sqlite3,json,sys
p=json.load(sys.stdin);c=sqlite3.connect(p['database'])
schema=c.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
tables=[r[1] for r in schema if r[0]=='table'];counts={}
for name in tables: counts[name]=c.execute('SELECT COUNT(*) FROM "'+name.replace('"','""')+'"').fetchone()[0]
value={'journal_mode':c.execute('PRAGMA journal_mode').fetchone()[0],'schema':schema,'row_counts':counts,'migrations':c.execute('SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version').fetchall(),'sentinel':c.execute('SELECT username,display_name,version FROM accounts WHERE id=1').fetchone(),'wallet':c.execute('SELECT coins,diamonds,version FROM wallets WHERE account_id=1').fetchone()}
print(json.dumps(value,sort_keys=True,ensure_ascii=False));c.close()
`;

// 使用冻结旧提交的真实 SQL 和校验值，比较逻辑内容而不是 WAL 的物理字节。
async function verifyOldSchema(binary, staticDirectory) {
  const directory = await mkdtemp(path.join(temporary, 'old-schema-'));
  const config = await configuration(directory, staticDirectory);
  const files = command('git', ['ls-tree', '-r', '--name-only', '8bbc54d', 'migrations']).trim().split('\n').filter((name) => /^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(name));
  check(files.length > 0, '冻结旧提交中没有迁移 SQL');
  const migrations = files.sort().map((name) => {
    const sql = command('git', ['show', `8bbc54d:${name}`]);
    return { name: path.basename(name), version: Number(path.basename(name).slice(0, 3)), sql, checksum: sha256(Buffer.from(sql)) };
  });
  command('python3', ['-c', oldSchemaBuilder], JSON.stringify({ database: config.database, migrations }));
  const before = command('python3', ['-c', logicalSnapshot], JSON.stringify({ database: config.database }));
  check(JSON.parse(before).journal_mode === 'wal', '旧库未以 WAL 模式建立');
  const result = spawnSync(binary, ['serve', '-config', config.path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' });
  check(!result.error && result.status !== null && result.status !== 0 && result.stderr.includes('migration history mismatch'), '发行进程未明确拒绝不兼容旧库');
  const after = command('python3', ['-c', logicalSnapshot], JSON.stringify({ database: config.database }));
  check(before === after, '旧库拒绝启动后逻辑结构或业务行发生变化');
  return { source_revision: '8bbc54d', migrations: migrations.length, logical_sha256: sha256(Buffer.from(before)) };
}

// 收到中断时只停止本脚本进程，清理仍由 finally 等待完成。
function interrupt() { interrupted = true; for (const item of servers) if (!item.done) item.child.kill('SIGTERM'); }
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  check(typeof releaseDirectory === 'string' && path.isAbsolute(releaseDirectory), '请提供发行目录的绝对路径');
  const release = await readFile(path.join(releaseDirectory, 'release.json'), 'utf8').then(JSON.parse);
  const binary = path.join(releaseDirectory, release.goos === 'windows' ? 'island.exe' : 'island');
  const identity = JSON.parse(command(binary, ['version']));
  check(identity.version === release.version && identity.goos === release.goos && identity.goarch === release.goarch, '二进制身份与 release.json 不同');
  report('发行身份核对', { version: release.version, goos: identity.goos, goarch: identity.goarch });
  temporary = await mkdtemp(path.join(tmpdir(), 'check-in-p1-release-'));
  const staticDirectory = path.join(releaseDirectory, 'web');
  const config = await configuration(temporary, staticDirectory);
  command(binary, ['migrate', '-config', config.path]);
  command(binary, ['init', '-config', config.path], [account.username, '发行包验证', account.login, account.login, account.management, account.management, ''].join('\n'));
  report('空库迁移与初始化通过');
  let server = await startServer(binary, config);
  let api = await client(config.origin);
  const indexResponse = await api.request('/');
  const indexBytes = Buffer.from(await indexResponse.arrayBuffer());
  check(sha256(indexBytes) === sha256(await readFile(path.join(staticDirectory, 'index.html'))), '静态页面不是发行包 web/index.html');
  const initialAppearance = await api.json('/api/v1/appearance');
  const initialLayout = await api.json('/api/v1/island/layout');
  check(initialAppearance.version === 1 && initialLayout.version === 1 && initialAppearance.characters?.length > 0 && initialLayout.placements?.length > 0, '空库未返回初始人物与布局');
  const assets = await verifyAssets(api);
  report('静态页面与十四项资源通过', { assets });
  const appearanceBody = appearanceInput(initialAppearance), layoutBody = layoutInput(initialLayout);
  const savedAppearance = await api.json('/api/v1/appearance', 'PUT', appearanceBody);
  const savedLayout = await api.json('/api/v1/island/layout', 'PUT', layoutBody);
  check(savedAppearance.version === initialAppearance.version + 1 && savedLayout.version === initialLayout.version + 1, '完整保存未递增版本');
  check((await api.json('/api/v1/appearance', 'PUT', appearanceBody, 409)).code === 'VERSION_CONFLICT', '外观旧版本没有冲突');
  check((await api.json('/api/v1/island/layout', 'PUT', layoutBody, 409)).code === 'VERSION_CONFLICT', '布局旧版本没有冲突');
  report('外观与布局保存及版本冲突通过', { appearance_version: savedAppearance.version, layout_version: savedLayout.version });
  await stopServer(server);
  const restartedConfig = await configuration(temporary, staticDirectory);
  server = await startServer(binary, restartedConfig); api = await client(restartedConfig.origin);
  const restartedAppearance = await api.json('/api/v1/appearance'), restartedLayout = await api.json('/api/v1/island/layout');
  check(JSON.stringify(appearanceInput(restartedAppearance)) === JSON.stringify(appearanceInput(savedAppearance)), '重启后外观版本或选择发生变化');
  check(JSON.stringify(layoutInput(restartedLayout)) === JSON.stringify(layoutInput(savedLayout)), '重启后布局版本或位置发生变化');
  check(JSON.stringify(await verifyAssets(api)) === JSON.stringify(assets), '重启后素材字节或类型发生变化');
  await stopServer(server);
  report('同一持久目录重启与新会话通过', { appearance_version: restartedAppearance.version, layout_version: restartedLayout.version, resources: assets.length });
  report('旧 WAL 数据库拒绝启动且逻辑内容不变', await verifyOldSchema(binary, staticDirectory));
  check(!interrupted, '验证被中断');
  report('P1正式发行包冒烟通过', { version: release.version, resources: assets.length, restarted: true, old_schema_rejected: true });
} catch (error) {
  process.stderr.write(JSON.stringify({ step: 'P1正式发行包冒烟失败', error: error.message }) + '\n'); process.exitCode = interrupted ? 130 : 1;
} finally {
  for (const item of [...servers]) { try { await stopServer(item); } catch { process.exitCode = 1; } }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
