import { ApiFailure, errorMessage } from '../../api/client';
import type { Product, Wallet } from './types';
import content from './content.json';

// 两种余额都必须达到价格，负余额不能购买免费商品。
export function canBuy(product: Product, wallet: Wallet): boolean {
  return (
    product.enabled &&
    !product.owned &&
    product.stock !== 0 &&
    wallet.coins >= product.coin_price &&
    wallet.diamonds >= product.diamond_price
  );
}

// 业务错误文案局限于商店，通用连接与授权错误复用请求模块。
export function shopError(error: unknown): string {
  if (error instanceof ApiFailure)
    return content.errors[error.detail.code as keyof typeof content.errors] ?? errorMessage(error);
  return errorMessage(error);
}

// 成功响应也可能在读取正文时截断；没有完整结果就保留原命令。
export function uncertainResult(error: unknown): boolean {
  return (
    !(error instanceof ApiFailure) ||
    error.detail.code === 'INVALID_RESPONSE' ||
    error.status === 0 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status >= 500
  );
}

// 已校验的版本化素材仅通过私有鉴权地址读取。
export function assetURL(key: string): string {
  return `/api/v1/assets/${encodeURIComponent(key)}`;
}

// 订单时间始终使用站点时区，避免设备设置改变展示日期。
export function purchaseTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
