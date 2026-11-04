/**
 * 内置登录：密码 → 不透明会话 token（cookie 或 Bearer 二选一），会话存内存。
 *
 * 与 apps/server/src/auth.rs 同语义：
 * - 会话表按 **token 的 SHA-256** 索引：内存泄露 / core dump 里看不到可用的 cookie 值。
 * - 密码优先用 GREYWORK_PASSWORD_HASH（argon2 PHC 串）校验；只给明文时直接常量时间比较
 *   （不落盘、不进日志）。
 * - 失败限流按来源 IP 计（5 次 / 60s → 429），与 Rust 侧同一档位的粗粒度。
 */
import { argon2Verify } from "hash-wasm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "gw_session";

export type PasswordCheck = (password: string) => Promise<boolean>;

/** 按配置决定校验方式：有 PHC 串走 argon2，否则退回明文常量时间比较。 */
export function passwordChecker(input: { passwordHash: string | null; password: string | null }): PasswordCheck {
  if (input.passwordHash) {
    const hash = input.passwordHash;
    return (password) => argon2Verify({ password, hash }).catch(() => false);
  }
  if (input.password) {
    const expected = Buffer.from(input.password, "utf8");
    return async (password) => {
      const actual = Buffer.from(password, "utf8");
      // 长度不同时 timingSafeEqual 会抛错：先比长度再比内容，长度本身不算秘密。
      if (actual.length !== expected.length) {
        // 仍然做一次比较，避免长度差异成为显式的时间侧信道。
        timingSafeEqual(expected, expected);
        return false;
      }
      return timingSafeEqual(actual, expected);
    };
  }
  return async () => false;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SessionStore {
  /** token 的 SHA-256 → 到期时刻（unix ms）。 */
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly checkPassword: PasswordCheck,
    private readonly ttlSecs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 校验密码并签发 token；失败返回 null（调用方统一回 401，不区分原因）。 */
  async login(password: string): Promise<string | null> {
    if (!(await this.checkPassword(password))) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(hashToken(token), this.now() + this.ttlSecs * 1000);
    return token;
  }

  /** 校验 token；有效则返回到期时刻。过期条目顺手清掉。 */
  authenticate(token: string | null | undefined): number | null {
    if (!token) return null;
    const key = hashToken(token);
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return null;
    if (expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return expiresAt;
  }

  revoke(token: string | null | undefined): void {
    if (token) this.sessions.delete(hashToken(token));
  }

  get ttlMs(): number {
    return this.ttlSecs * 1000;
  }
}

/**
 * 登录失败限流：按 IP 计固定窗口。比 Rust 的令牌桶粗，但足以挡住脚本爆破；
 * P1 会换成与 Rust 同参数的滑动窗口并补测试。
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private static readonly MAX_FAILURES = 5;
  private static readonly WINDOW_MS = 60_000;

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= LoginThrottle.MAX_FAILURES;
  }

  recordFailure(ip: string): void {
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= this.now()) {
      this.failures.set(ip, { count: 1, resetAt: this.now() + LoginThrottle.WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

export function sessionCookie(token: string, ttlSecs: number, secure: boolean): string {
  const base = `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${ttlSecs}`;
  return secure ? `${base}; Secure` : base;
}

export function clearCookie(secure: boolean): string {
  const base = `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
  return secure ? `${base}; Secure` : base;
}

/** 从 Cookie 头里取 token（与 Rust 的 token_from_cookie 等价：只认同名键）。 */
export function tokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === COOKIE_NAME) {
      const value = trimmed.slice(eq + 1);
      return value === "" ? null : value;
    }
  }
  return null;
}
