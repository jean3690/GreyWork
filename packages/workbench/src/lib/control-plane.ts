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
  devices?: ControlPlaneDevice[];
}

export interface ControlPlaneDevice {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  createdAt: string | null;
  current: boolean;
}

export interface AccountLoginInput {
  baseUrl: string;
  email: string;
  password: string;
  /** true = 首次注册并登录（开放注册）；缺省按已有账号登录。 */
  register?: boolean;
  displayName?: string;
  deviceName?: string;
}
