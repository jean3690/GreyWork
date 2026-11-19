import { invoke } from "@greywork/host-ipc";

export type CloudCollection = "file" | "library";
export interface CloudStorageConfig {
  enabled: boolean;
  maxObjectBytes: number;
  reason: string | null;
}
export interface CloudObject {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  kind: CloudCollection;
  status: string;
  createdAt: string;
}
export interface CloudHost {
  deviceId: string;
  name: string;
  alive: boolean;
}
export interface CloudTask {
  id: string;
  name: string;
  schedule: string;
  cronExpr: string | null;
  onceAt: string | null;
  acpProviderId: string | null;
  target: string;
  intent: string;
  execution: "host" | "cloud";
  hostDeviceId: string | null;
  model: string | null;
  enabled: boolean;
  offlinePolicy: "replay" | "skip";
  nextRunAt: string | null;
}
export type CloudTaskInput = Omit<CloudTask, "id" | "nextRunAt">;
export interface CloudRun {
  id: string;
  taskId: string;
  name: string;
  status: string;
  detail: string | null;
  output: string | null;
  finishedAt: string | null;
}

export function cloudRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("cloud_request", { method, path, ...(body === undefined ? {} : { body }) });
}
export function cloudUpload(path: string, kind: CloudCollection): Promise<CloudObject> {
  return invoke<CloudObject>("cloud_upload_file", { path, kind });
}
export function cloudError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
export function formatCloudBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
