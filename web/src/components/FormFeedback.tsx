import { ApiFailure, errorCodeMessage, errorMessage } from '../api/client';

// 全局错误保持在当前表单内，让用户保留输入重试。
export function FormFeedback({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="form-error" role="alert">{errorMessage(error)}</p>;
}

// 字段错误通过固定ID关联到输入框，未知字段错误仍由表单全局提示覆盖。
export function FieldError({ error, field, id }: { error: unknown; field: string; id?: string }) {
  const code = error instanceof ApiFailure ? error.detail.field_errors?.[field] : undefined;
  if (!code) return null;
  return <p className="field-error" id={id} role="alert">{errorCodeMessage(code)}</p>;
}
