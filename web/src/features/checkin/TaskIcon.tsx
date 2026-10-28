/** 记录与任务直接读取持久化版本素材，文字已提供名称，因此图片作为装饰。 */
export function TaskIcon({ name }: { name: string }) {
  return <img className="checkin-icon" src={`/api/v1/assets/${encodeURIComponent(name)}`} alt="" aria-hidden="true" />;
}
