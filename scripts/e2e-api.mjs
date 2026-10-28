import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 浏览器测试使用临时数据库和编译产物，结束后随服务一并清理。
const directory = await mkdtemp(join(tmpdir(), 'island-e2e-'));
const binary = join(directory, process.platform === 'win32' ? 'island.exe' : 'island');
const configPath = join(directory, 'app.yaml');

try {
  const config = {
    listen_address: '127.0.0.1:18080',
    public_origin: 'http://127.0.0.1:15173',
    database_path: join(directory, 'island.db'),
    media_directory: join(directory, 'media'),
    assets_directory: join(directory, 'assets'),
    temp_directory: join(directory, 'tmp'),
    sqlite_busy_timeout: '5s',
    http_timeout: '10s',
    ffprobe_path: 'ffprobe',
    media_probe_timeout: '3s',
  };
  await writeFile(configPath, Object.entries(config)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n');
  execFileSync('go', ['build', '-o', binary, './cmd/island'], { stdio: 'inherit' });
  execFileSync(binary, ['migrate', '-config', configPath], { stdio: 'inherit' });
  // 仅在临时测试库建立账户；密码经标准输入传递，不进入命令参数。
  execFileSync(binary, ['init', '-config', configPath], {
    input: ['island-e2e', '测试小朋友', 'Island-Test-2026', 'Island-Test-2026',
      'Manage-Test-2026', 'Manage-Test-2026', ''].join('\n'),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const server = spawn(binary, ['serve', '-config', configPath], { stdio: 'inherit' });
  // Playwright 会向进程组发送信号；转发也支持手动停止此脚本。
  const stop = () => server.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const [code, signal] = await once(server, 'exit');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = signal === 'SIGTERM' ? 0 : (code ?? 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
