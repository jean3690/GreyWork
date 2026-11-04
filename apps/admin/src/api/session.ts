import type { UserSummary } from "../types";

/**
 * token 存 sessionStorage：关掉标签页即失效，比 localStorage 少一份长期驻留的凭据。
 * 运维台是「用完就关」的页面，没有跨会话记住登录的需求。
 */
const TOKEN_KEY = "grey.admin.token";
const USER_KEY = "grey.admin.user";

export function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function readUser(): UserSummary | null {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as UserSummary;
  } catch {
    return null;
  }
}

export function writeSession(token: string, user: UserSummary): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}
