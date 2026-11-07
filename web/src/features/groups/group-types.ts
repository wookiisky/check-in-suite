import type { ApiClient } from '../../api/client';
import type { components } from '../../api/schema';

/** 组与成员只读协议由 OpenAPI 生成，避免前后端维护两份字段。 */
export type GroupState = components['schemas']['GroupState'];
export type MemberToday = components['schemas']['MemberToday'];

/** 组组件只依赖请求能力，测试无需构造完整客户端。 */
export type GroupClient = Pick<ApiClient, 'request'>;
