import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';

export type Product = components['schemas']['Product'];
export type ProductInput = components['schemas']['ProductCreate'];
export type Purchase = components['schemas']['Purchase'];
export type PurchaseInput = components['schemas']['PurchaseCreate'];
export type PurchaseResult = components['schemas']['PurchaseResult'];
export type PurchaseList = components['schemas']['PurchaseList'];
export type Equipment = components['schemas']['Equipment'];
export type Wallet = components['schemas']['Wallet'];
export type Camp = components['schemas']['CampResponse'];
export type Asset = components['schemas']['Asset'];
export type ShopClient = Pick<ApiClient, 'request'>;

// 页面共享当前会话，不保存第二份认证状态。
export interface ShopProps {
  client: ShopClient; // 已绑定会话的HTTP请求入口。
  session: Session; // 账户信息及生效限制。
}
