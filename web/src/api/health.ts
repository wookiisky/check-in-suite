import type { components } from './schema';

// 只在 HTTP 与健康状态均成功时将服务视为就绪。
export async function readReadiness(signal: AbortSignal): Promise<components['schemas']['HealthResponse']> {
  const response = await fetch('/health/ready', { signal, cache: 'no-store' });
  const health: components['schemas']['HealthResponse'] = await response.json();
  if (!response.ok || health.status !== 'ok') {
    throw new Error('Service readiness check failed');
  }
  return health;
}
