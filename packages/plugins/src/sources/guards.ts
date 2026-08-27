/** 源适配层共用的运行时形状守卫（本包唯一规范定义，勿在调用点重建）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串字段；空串视为缺失。 */
export function strField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
