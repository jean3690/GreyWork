/** 宿主与 Java 控制面的公开契约。凭据只存在宿主，不进入前端状态。 */
export interface ControlPlaneStatus {
  configured: boolean;
  source: "env" | "file" | null;
  baseUrl: string | null;
  email: string | null;
  registered: boolean;
  tickSecs: number;
  lastHeartbeatAt: number | null;
  lastClaimAt: number | null;
  lastError: string | null;
  lastOutcome: { name: string; ok: boolean; detail: string } | null;
}

export interface ControlPlaneSession {
  user: { id: string; email: string; displayName: string | null; role: string };
  device: { id: string | number; name: string; platform: string };
}

export interface ControlPlaneAccount {
  status: ControlPlaneStatus;
  session: ControlPlaneSession | null;
  error: string | null;
}

export interface AccountLoginInput {
  baseUrl: string;
  email: string;
  code: string;
  displayName?: string;
  deviceName?: string;
}
