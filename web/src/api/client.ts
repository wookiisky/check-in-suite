import content from '../content/zh-CN.json';
import type { ApiError } from './types';

// ApiFailure保留机器错误码、字段与请求编号，界面只从资源文件查找文案。
export class ApiFailure extends Error {
  readonly status: number; // HTTP状态码；网络错误为零。
  readonly detail: ApiError; // 服务端结构化错误，或客户端连接错误。

  constructor(status: number, detail: ApiError) {
    super(detail.code);
    this.status = status;
    this.detail = detail;
  }
}

// RequestOptions只包含各业务真正使用的请求参数。
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

// ApiClient将Cookie和CSRF留在当前会话中，不在持久存储保存凭据。
export class ApiClient {
  private csrfToken = ''; // 由登录或会话查询提供的防跨站请求令牌。
  private serverOffsetMs = 0; // 仅收到真实服务端时间时校准，不因页面切换重置。
  private readonly onAuthorizationFailure: (status: number) => void; // 统一清除失效权限的页面内容。

  constructor(onAuthorizationFailure: (status: number) => void = () => {}) {
    this.onAuthorizationFailure = onAuthorizationFailure;
  }

  // 更新令牌时不影响其他页面的编辑草稿。
  setCsrfToken(token: string) { this.csrfToken = token; }

  // 将真实响应中的服务端时间与当前设备时钟对齐。
  recordServerTime(serverNow: string) { this.serverOffsetMs = Date.parse(serverNow) - Date.now(); }

  // 页面共用持续推进的服务端时间估计，避免重新锚定旧会话。
  now(): Date { return new Date(Date.now() + this.serverOffsetMs); }

  // 读取与写入都返回实际服务JSON，未知写入结果交由业务保留原请求恢复。
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const requestToken = this.csrfToken;
    const headers = new Headers({ Accept: 'application/json' });
    const isForm = options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers.set('Content-Type', 'application/json');
    if (method !== 'GET' && this.csrfToken) headers.set('X-CSRF-Token', this.csrfToken);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (options.signal) init.signal = options.signal;
    if (options.body !== undefined) init.body = isForm ? options.body as FormData : JSON.stringify(options.body);
    let response: Response;
    try { response = await fetch(`/api/v1${path}`, init); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' });
    }
    if (!response.ok) {
      let detail: ApiError;
      try { detail = await response.json(); }
      catch { detail = { code: 'INVALID_RESPONSE', field_errors: {}, request_id: '' }; }
      // 跨日只读是本次业务限制，不撤销已解锁的管理状态。
      const authorizationDenied = response.status === 403 && detail.code !== 'HISTORY_READ_ONLY';
      if (requestToken === this.csrfToken && ((response.status === 401 && path !== '/auth/login') || authorizationDenied)) {
        if (response.status === 401) this.csrfToken = '';
        this.onAuthorizationFailure(response.status);
      }
      throw new ApiFailure(response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new ApiFailure(response.status, { code: 'INVALID_RESPONSE', field_errors: {}, request_id: '' }); }
  }
}

// 未识别错误统一提示，不向用户展示原始服务异常。
export function errorMessage(error: unknown): string {
  return error instanceof ApiFailure ? errorCodeMessage(error.detail.code) : content.errors.NETWORK_ERROR;
}

// 字段和全局错误使用同一资源映射，避免解析服务端中文。
export function errorCodeMessage(code: string): string {
  return content.errors[code as keyof typeof content.errors] ?? content.errors.INVALID_REQUEST;
}
