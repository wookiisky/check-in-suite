import { useEffect, useState } from 'react';
import { readReadiness } from './api/health';
import content from './content/zh-CN.json';

type ConnectionState = 'loading' | 'ready' | 'error';

// 最小工程页面通过真实服务状态证明开发链路可用。
export function IslandApp() {
  const [connection, setConnection] = useState<ConnectionState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setConnection('loading');
    readReadiness(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setConnection('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setConnection('error');
      });

    // 卸载和 StrictMode 重挂载均释放请求，旧响应不再更新界面。
    return () => controller.abort();
  }, [attempt]);

  return (
    <main className="island-shell">
      <header className="island-brand">{content.appName}</header>
      <section className="island-card" aria-labelledby="welcome-heading">
        <p className="island-stage">{content.stage}</p>
        <h1 id="welcome-heading">{content.heading}</h1>
        <p className="island-description">{content.description}</p>
        <div className="island-connection">
          <h2>{content.connectionLabel}</h2>
          <p role="status" aria-live="polite" className={`connection-${connection}`}>
            {content.connection[connection]}
          </p>
          {connection === 'error' && (
            <button type="button" onClick={() => setAttempt((current) => current + 1)}>
              {content.retry}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
