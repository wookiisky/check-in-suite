import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import { ViewTabs } from '../../components/ViewTabs';
import { CalendarPage } from './CalendarPage';
import { StatsPage } from './StatsPage';
import { WeeklyRecords } from './WeeklyRecords';
import content from './content.json';
import './reports.css';

/** 三个视图共享当前账户，成员权限失效时由上层切回本人。 */
export interface ReportsProps {
  client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>; // 当前会话的请求和业务时钟。
  session: Session; // 登录账户及限制。
  accountID?: number; // 查询目标，省略时为本人。
  onAccessDenied?: () => void; // 只用于同组访问失效。
}

const views = [
  { id: 'month', label: content.monthView },
  { id: 'week', label: content.weekView },
  { id: 'stats', label: content.statsView },
] as const;

// 默认打开月视图，仅挂载当前标签对应的查询。
export function ReportsPage(props: ReportsProps) {
  const [view, setView] = useState<(typeof views)[number]['id']>('month');
  return <div className="reports-workspace">
    <ViewTabs label={content.viewLabel} items={views} value={view} onChange={setView}>
      {view === 'month' && <CalendarPage {...props} />}
      {view === 'week' && <WeeklyRecords {...props} />}
      {view === 'stats' && <StatsPage {...props} />}
    </ViewTabs>
  </div>;
}
