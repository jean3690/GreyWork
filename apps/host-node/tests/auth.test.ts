import { argon2id } from "hash-wasm";
import { describe, expect, it } from "vitest";

import { COOKIE_NAME, LoginThrottle, SessionStore, clearCookie, passwordChecker, sessionCookie, tokenFromCookie } from "../src/auth.js";

describe("passwordChecker", () => {
  it("校验明文密码（常量时间比较，长度不同也不抛）", async () => {
    const check = passwordChecker({ passwordHash: null, password: "s3cret-pass" });
    await expect(check("s3cret-pass")).resolves.toBe(true);
    await expect(check("wrong")).resolves.toBe(false);
    await expect(check("s3cret-pass-longer")).resolves.toBe(false);
  });

  it("校验 argon2 PHC 串（与 Electron 的 GREYWORK_PASSWORD_HASH 同格式）", async () => {
    const hash = await argon2id({
      password: "s3cret-pass",
      salt: new Uint8Array(16),
      parallelism: 1,
      iterations: 1,
      memorySize: 1024,
      hashLength: 32,
      outputType: "encoded",
    });
    const check = passwordChecker({ passwordHash: hash, password: null });
    await expect(check("s3cret-pass")).resolves.toBe(true);
    await expect(check("nope")).resolves.toBe(false);
  });

  it("什么凭据都没配时一律拒绝（fail-closed）", async () => {
    const check = passwordChecker({ passwordHash: null, password: null });
    await expect(check("anything")).resolves.toBe(false);
  });
});

describe("SessionStore", () => {
  it("签发 → 校验 → 撤销；过期后失效", async () => {
    let now = 1_000;
    const store = new SessionStore(
      async () => true,
      60,
      () => now,
    );
    const token = await store.login("pw");
    expect(token).toBeTruthy();
    expect(store.authenticate(token)).toBe(1_000 + 60_000);
    store.revoke(token);
    expect(store.authenticate(token)).toBeNull();

    const second = await store.login("pw");
    now += 61_000;
    expect(store.authenticate(second)).toBeNull();
  });

  it("密码错误不签发 token", async () => {
    const store = new SessionStore(async () => false, 60);
    await expect(store.login("pw")).resolves.toBeNull();
  });
});

describe("cookie", () => {
  it("写入与清除使用同一套属性（Secure 必须一致，否则清不掉）", () => {
    expect(sessionCookie("tok", 3600, false)).toBe(`${COOKIE_NAME}=tok; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600`);
    expect(sessionCookie("tok", 3600, true)).toContain("; Secure");
    expect(clearCookie(true)).toContain("Max-Age=0");
    expect(clearCookie(true)).toContain("; Secure");
  });

  it("只认同名 cookie 键", () => {
    expect(tokenFromCookie("a=1; gw_session=tok; b=2")).toBe("tok");
    expect(tokenFromCookie("gw_session=")).toBeNull();
    expect(tokenFromCookie(undefined)).toBeNull();
  });
});

describe("LoginThrottle", () => {
  it("5 次失败后锁定，窗口过去自动解除", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < 5; i += 1) throttle.recordFailure("1.2.3.4");
    expect(throttle.isBlocked("1.2.3.4")).toBe(true);
    expect(throttle.isBlocked("5.6.7.8")).toBe(false);
    now += 61_000;
    expect(throttle.isBlocked("1.2.3.4")).toBe(false);
  });

  it("成功登录清零计数", () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 4; i += 1) throttle.recordFailure("1.2.3.4");
    throttle.recordSuccess("1.2.3.4");
    for (let i = 0; i < 4; i += 1) throttle.recordFailure("1.2.3.4");
    expect(throttle.isBlocked("1.2.3.4")).toBe(false);
  });
});
