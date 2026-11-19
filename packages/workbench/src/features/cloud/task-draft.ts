import { shallowRef } from "vue";

/** 对话提案只携带草稿；用户在云端编辑器确认后才真正创建，不再写本地自动化表。 */
export interface CloudTaskDraft {
  name: string;
  intent: string;
  cron: string | null;
  onceAt: number | null;
  onCreated(id: string): void;
}
export const pendingCloudTaskDraft = shallowRef<CloudTaskDraft | null>(null);

export function formatCloudTime(epoch: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  const field = (key: string): string => parts.find((part) => part.type === key)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}`;
}
