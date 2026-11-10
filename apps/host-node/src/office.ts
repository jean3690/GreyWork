/**
 * 云端 Office 预览 + 扫码授权 + 本地 LibreOffice 转换：
 * 移植 crates/greywork-host/src/services/office/（mod + oauth + auth + store + convert）。
 *
 * 设计约束与 Rust 一致：
 * - 凭证只在宿主从环境变量解析（渲染端只传变量名与配方），密钥不进渲染端 / 落盘 / 日志；
 * - 配方是受限数据不是代码：只描述「往哪发、怎么发、从响应哪里取 URL」；
 * - 文件不经渲染端中转：宿主凭路径读，授权校验收在 WorkspaceAccess.readBinary 一处；
 * - 失败一律不静默降级：返回 Error，由渲染端决定回落本地 viewer 并把原因显示出来。
 *
 * OAuth（腾讯文档开放平台）：宿主**不持有在飞会话** —— begin 生成 state 后交渲染端保管，
 * submit 时原样回传校验；令牌按 client_id 落在 <dataDir>/office/credentials.json（0600）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

/** 上传失败诊断里错误体的截断长度（按字符，避免切坏中文）。 */
const ERROR_BODY_CHARS = 200;
/** 包体形态：整文件原始字节。 */
const BODY_RAW = "raw-bytes";
/** 包体形态：multipart 表单。 */
const BODY_MULTIPART = "multipart";
/** 凭证请求头模板里的保留占位符：由宿主代入已存的 OAuth access_token。 */
const OAUTH_TOKEN_PLACEHOLDER = "{{OAUTH_ACCESS_TOKEN}}";

export interface OfficeRecipe {
  method: string;
  url: string;
  body: string;
  fileField?: string | null;
  contentType?: string | null;
  credentialHeader?: string | null;
  viewUrlPointer: string;
}

export interface PreviewOpenArgs {
  path: string;
  recipe: OfficeRecipe;
  credentialEnv?: string | null;
  headers?: Record<string, string> | null;
  oauth?: OAuthClientArgs | null;
}

export interface PreviewResult {
  url: string;
  filename: string;
}

/* ===== 纯逻辑 ===== */

/** 取路径末段文件名（兼容 Windows 分隔符与结尾斜杠）。 */
export function filenameOf(target: string): string {
  const segments = target.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? target;
}

/** 按 URL 路径段规则编码：只放行 unreserved 字符（RFC 3986），其余一律 %XX。 */
function encodePathSegment(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(character)) out += character;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** 渲染请求地址模板：{filename} → URL 编码后的文件名。 */
export function renderUrl(template: string, filename: string): string {
  return template.replaceAll("{filename}", encodePathSegment(filename));
}

/** 按扩展名猜 Content-Type（配方没显式给时用）；认不出按八位字节流。 */
export function contentTypeFor(filename: string): string {
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (extension) {
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "pdf":
      return "application/pdf";
    case "csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}

/** 归一化 JSON 指针：用户常写成 webUrl 或 data.url，补一个前导斜杠。 */
function normalizePointer(pointer: string): string {
  const trimmed = pointer.trim();
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

function pointerGet(body: unknown, pointer: string): unknown {
  const normalized = normalizePointer(pointer);
  if (normalized === "") return body;
  let current: unknown = body;
  for (const rawToken of normalized.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** 从响应 JSON 取文档地址。 */
export function extractViewUrl(body: unknown, pointer: string): string {
  const found = pointerGet(body, pointer);
  const url = typeof found === "string" ? found.trim() : "";
  if (url === "") {
    throw new Error(
      "响应里取不到文档地址：JSON 指针 " +
        normalizePointer(pointer) +
        " 未命中，或命中的不是非空字符串（请对照厂商文档核对 viewUrlPointer）",
    );
  }
  return url;
}

/** 配方自检：在发起网络请求**之前**把明显不可用的配方拦掉。 */
export function validateRecipe(recipe: OfficeRecipe): void {
  const method = recipe.method.trim().toUpperCase();
  if (method !== "POST" && method !== "PUT") {
    throw new Error("配方 method 只支持 POST / PUT，收到 " + JSON.stringify(recipe.method));
  }
  const url = recipe.url.trim();
  if (url === "") throw new Error("配方 url 为空");
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error("配方 url 必须是 http(s) 地址");
  }
  const body = recipe.body.trim();
  if (body !== BODY_RAW && body !== BODY_MULTIPART) {
    throw new Error("配方 body 只支持 " + BODY_RAW + " / " + BODY_MULTIPART + "，收到 " + JSON.stringify(recipe.body));
  }
  if (recipe.viewUrlPointer.trim() === "") {
    throw new Error("配方 viewUrlPointer 为空（不知道该从响应哪里取文档地址）");
  }
}

/** 拆「请求头模板」（Name: value）为 (名, 值模板)。空模板 → null。 */
function splitHeaderTemplate(template: string | null | undefined): [string, string] | null {
  const trimmed = (template ?? "").trim();
  if (trimmed === "") return null;
  const hint = "（应形如 Authorization: Bearer {{YOUR_TOKEN_ENV}}）";
  const colon = trimmed.indexOf(":");
  if (colon < 0) throw new Error("凭证请求头模板缺少冒号" + hint);
  const name = trimmed.slice(0, colon).trim();
  if (name === "") throw new Error("凭证请求头模板缺少头名" + hint);
  return [name, trimmed.slice(colon + 1).trim()];
}

function envSetHint(name: string): string {
  return process.platform === "win32" ? "set " + name + "=…" : "export " + name + "=…";
}

/** 凭证预检：声明了变量名却没设值 → 直接给出可操作的错误。 */
function ensureCredential(credentialEnv: string | null | undefined): void {
  const name = (credentialEnv ?? "").trim();
  if (name === "") return; // 本地 / 无鉴权服务
  if ((process.env[name] ?? "") === "") {
    throw new Error(
      "未设置云端 Office 凭证：先在本机终端执行 " + envSetHint(name) + "，再从同一终端启动 GreyWork（设置页 → 服务 可查看/修改变量名）",
    );
  }
}

/** 配方（凭证头或任一附加头）里是否用到 OAuth token 占位符 —— 即「是否走 OAuth 取件」。 */
function usesOauthToken(args: PreviewOpenArgs): boolean {
  const inCredential = (args.recipe.credentialHeader ?? "").includes(OAUTH_TOKEN_PLACEHOLDER);
  const inHeaders = Object.values(args.headers ?? {}).some((value) => value.includes(OAUTH_TOKEN_PLACEHOLDER));
  return inCredential || inHeaders;
}

function substituteOauthToken(template: string, token: string | null): string {
  return token === null ? template : template.replaceAll(OAUTH_TOKEN_PLACEHOLDER, token);
}

/** 按字符截断（不是字节）。 */
function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/* ===== OAuth（腾讯文档开放平台） ===== */

/** 腾讯文档开放平台授权端点。 */
export const DEFAULT_AUTHORIZE_URL = "https://docs.qq.com/oauth/v2/authorize";
/** 腾讯文档开放平台换 / 刷 token 端点。 */
export const DEFAULT_TOKEN_URL = "https://docs.qq.com/oauth/v2/token";
/** 未显式指定 scope 时的缺省值。 */
const DEFAULT_SCOPE = "all";
/** expires_in 缺失时的兜底有效期（秒）：不让缺字段变成「永不过期」。 */
const DEFAULT_EXPIRES_IN_SECS = 7200;
/** 应用数据目录下的子目录名。 */
const DIR_NAME = "office";
/** 令牌文件名。 */
const CREDENTIALS_FILE = "credentials.json";
/** 提前多久视为「需要刷新」——留出刷新与请求在途的时间。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface OAuthClientArgs {
  clientId: string;
  clientSecretEnv?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  redirectUri: string;
  scope?: string | null;
}

interface OAuthClientConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** 归一成 OAuthClientConfig，缺省项落到官方端点。各字段都去空白（client_id 同时是落盘键）。 */
function clientConfig(args: OAuthClientArgs): OAuthClientConfig {
  return {
    authorizeUrl: nonBlank(args.authorizeUrl) ?? DEFAULT_AUTHORIZE_URL,
    tokenUrl: nonBlank(args.tokenUrl) ?? DEFAULT_TOKEN_URL,
    clientId: args.clientId.trim(),
    redirectUri: args.redirectUri.trim(),
    scope: nonBlank(args.scope),
  };
}

/** 从环境变量取 client_secret；未配置变量名 / 未设值 → 指路错误。密钥绝不进渲染端 / 落盘 / 日志。 */
function clientSecret(args: OAuthClientArgs): string {
  const name = (args.clientSecretEnv ?? "").trim();
  if (name === "") {
    throw new Error("未提供 clientSecretEnv：client_secret 必须由宿主从环境变量读取（不进渲染端）");
  }
  const value = process.env[name] ?? "";
  if (value.trim() === "") {
    throw new Error(
      "未设置云端 Office 应用密钥：先在本机终端执行 " + envSetHint(name) + "，再从同一终端启动 GreyWork（设置页 → 服务 可查看/修改变量名）",
    );
  }
  return value;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** 绝对过期时刻（毫秒时间戳），由 expires_in 换算。 */
  expiresAt: number;
  scope?: string | null;
  userId?: string | null;
  clientId?: string | null;
}

export type CallbackOutcome = { kind: "code"; code: string; state: string } | { kind: "denied"; error: string; description: string | null };

/** 查询参数值编码（RFC 3986）：空格 → %20（不用表单编码的 +）。 */
function encodeQuery(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(character)) out += character;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function appendQuery(base: string, query: string): string {
  const trimmed = base.trim();
  const separator = trimmed.includes("?") ? "&" : "?";
  return trimmed + separator + query;
}

/** 拼授权 URL：用户用浏览器打开 → 扫码同意 → 跳回 redirect_uri?code=..&state=..。 */
export function buildAuthorizeUrl(cfg: OAuthClientConfig, state: string): string {
  const scope = cfg.scope ?? DEFAULT_SCOPE;
  const pairs = [
    ["client_id", cfg.clientId],
    ["redirect_uri", cfg.redirectUri],
    ["new_login", "1"],
    ["response_type", "code"],
    ["scope", scope],
    ["state", state],
  ];
  return appendQuery(cfg.authorizeUrl, pairs.map(([key, value]) => encodeQuery(key) + "=" + encodeQuery(value)).join("&"));
}

/** 解析回调：允许整条回调 URL，也允许只给查询串。 */
export function parseCallback(raw: string): CallbackOutcome {
  const trimmed = raw.trim();
  const question = trimmed.indexOf("?");
  const query = question >= 0 ? trimmed.slice(question + 1) : trimmed;

  let code: string | null = null;
  let state: string | null = null;
  let error: string | null = null;
  let description: string | null = null;
  const params = new URLSearchParams(query);
  for (const [key, value] of params.entries()) {
    if (key === "code") code = value;
    else if (key === "state") state = value;
    else if (key === "error") error = value;
    else if (key === "error_description") description = value;
  }
  if (error !== null) return { kind: "denied", error, description };
  if (code !== null && code !== "") return { kind: "code", code, state: state ?? "" };
  throw new Error("回调地址里没有 code（授权被取消，或粘贴的不是回调 URL；请重新授权后复制完整回调地址）");
}

/** 取字段并去空白；空串 / 缺字段一律当「没有」。数字（如 user_id）也收。 */
function nonEmpty(json: Record<string, unknown>, key: string): string | null {
  const value = json[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/** expires_in 可能是数字或字符串，都认。 */
function expiresInSecs(json: Record<string, unknown>): number | null {
  const value = json.expires_in;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 令牌是否已过期。skewMs 是提前量：留出刷新与请求在途的时间。 */
export function isExpired(set: TokenSet, nowMs: number, skewMs: number): boolean {
  return nowMs + skewMs >= set.expiresAt;
}

/** 把 token 端点的 JSON 回包映射成 TokenSet。 */
export function tokenJsonToSet(json: Record<string, unknown>, nowMs: number, clientId: string): TokenSet {
  const accessTokenRaw = json.access_token;
  const accessToken = typeof accessTokenRaw === "string" ? accessTokenRaw.trim() : "";
  if (accessToken === "") {
    throw new Error("token 响应缺少 access_token：" + truncateChars(JSON.stringify(json), ERROR_BODY_CHARS));
  }
  const expiresIn = expiresInSecs(json) ?? DEFAULT_EXPIRES_IN_SECS;
  const fallbackClientId = clientId.trim();
  return {
    accessToken,
    refreshToken: nonEmpty(json, "refresh_token"),
    expiresAt: nowMs + expiresIn * 1000,
    scope: nonEmpty(json, "scope"),
    userId: nonEmpty(json, "user_id"),
    clientId: nonEmpty(json, "client_id") ?? (fallbackClientId !== "" ? fallbackClientId : null),
  };
}

function nowMs(): number {
  return Date.now();
}

/** 拼换 / 刷 token 的 GET 地址（腾讯文档要求凭据走 query）。 */
function tokenUrl(cfg: OAuthClientConfig, clientSecretValue: string, grantType: string, extra: [string, string][]): string {
  const pairs: [string, string][] = [
    ["client_id", cfg.clientId],
    ["client_secret", clientSecretValue],
    ["redirect_uri", cfg.redirectUri],
    ["grant_type", grantType],
    ...extra,
  ];
  return appendQuery(cfg.tokenUrl, pairs.map(([key, value]) => encodeQuery(key) + "=" + encodeQuery(value)).join("&"));
}

/** 发请求并解析成 TokenSet。错误里不能带完整 URL（query 里有 client_secret）。 */
async function fetchToken(cfg: OAuthClientConfig, url: string): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (caught) {
    // 剥掉 URL：fetch 错误消息可能带完整地址。
    throw new Error(
      "请求 token 端点失败: " + truncateChars(String((caught as Error).message).replaceAll(url, "<token-url>"), ERROR_BODY_CHARS),
      { cause: caught },
    );
  }
  const status = response.status;
  const text = await response.text();
  if (!status.toString().startsWith("2")) {
    throw new Error("token 端点返回 " + status + "：" + truncateChars(text, ERROR_BODY_CHARS));
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error("token 响应不是 JSON: " + (error as Error).message + "（响应体：" + truncateChars(text, ERROR_BODY_CHARS) + "）", {
      cause: error,
    });
  }
  return tokenJsonToSet(json, nowMs(), cfg.clientId);
}

/** 用授权码换 token。 */
export function exchangeCode(cfg: OAuthClientConfig, secret: string, code: string): Promise<TokenSet> {
  return fetchToken(cfg, tokenUrl(cfg, secret, "authorization_code", [["code", code]]));
}

/** 用 refresh_token 换新 token。 */
export function refresh(cfg: OAuthClientConfig, secret: string, refreshToken: string): Promise<TokenSet> {
  return fetchToken(cfg, tokenUrl(cfg, secret, "refresh_token", [["refresh_token", refreshToken]]));
}

/* ===== 令牌落盘（<dataDir>/office/credentials.json，0600） ===== */

type TokenStore = Record<string, TokenSet>;

function credentialsPath(dataDir: string): string {
  return path.join(dataDir, DIR_NAME, CREDENTIALS_FILE);
}

/** 读整份令牌库；缺失 / 损坏 / 形状不符一律当「空」。 */
function readStore(dataDir: string): TokenStore {
  try {
    const raw = readFileSync(credentialsPath(dataDir), "utf8");
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as TokenStore;
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 写整份令牌库（unix 0600，与 channels 凭据同一套威胁模型）。 */
function writeStore(dataDir: string, store: TokenStore): void {
  const target = credentialsPath(dataDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const json = JSON.stringify(store, null, 2) + "\n";
  writeFileSync(target, json, { mode: 0o600 });
}

/** 读某个 client 的令牌；没有 → null。 */
export function loadToken(dataDir: string, clientId: string): TokenSet | null {
  return readStore(dataDir)[clientId.trim()] ?? null;
}

/** 写某个 client 的令牌（同文件里其它 client 的条目原样保留）。 */
export function saveToken(dataDir: string, clientId: string, set: TokenSet): void {
  const key = clientId.trim();
  if (key === "") throw new Error("client_id 为空，无法落盘令牌");
  const store = readStore(dataDir);
  store[key] = set;
  writeStore(dataDir, store);
}

/** 清除某个 client 的令牌；该 client 不存在视为成功。删空后连文件一起删。 */
export function clearToken(dataDir: string, clientId: string): void {
  const store = readStore(dataDir);
  const key = clientId.trim();
  if (store[key] === undefined) return;
  delete store[key];
  const target = credentialsPath(dataDir);
  if (Object.keys(store).length === 0) {
    try {
      rmSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("删除 " + target + " 失败: " + (error as Error).message, { cause: error });
      }
    }
    return;
  }
  writeStore(dataDir, store);
}

/** 取可用 access_token：新鲜则直接返回；已过期且有 refresh_token → 先刷新并落盘。 */
export async function resolveAccessToken(dataDir: string, cfg: OAuthClientConfig, secret: string): Promise<string> {
  const stored = loadToken(dataDir, cfg.clientId);
  if (stored === null) {
    throw new Error("尚未完成该服务的扫码授权（未找到 client_id 对应的凭证）：请先在设置页完成扫码授权");
  }
  if (!isExpired(stored, nowMs(), REFRESH_SKEW_MS)) return stored.accessToken;
  const refreshToken = (stored.refreshToken ?? "").trim();
  if (refreshToken === "") {
    throw new Error("该服务的授权已过期且没有 refresh_token：请重新扫码授权");
  }
  let refreshed: TokenSet;
  try {
    refreshed = await refresh(cfg, secret, refreshToken);
  } catch (error) {
    throw new Error("刷新授权失败（请重新扫码授权）：" + (error as Error).message, { cause: error });
  }
  // 刷新响应可能不回 refresh_token —— 保留旧的，否则下次再过期就没得刷了。
  const merged: TokenSet = { ...refreshed, refreshToken: refreshed.refreshToken ?? stored.refreshToken ?? null };
  saveToken(dataDir, cfg.clientId, merged);
  return merged.accessToken;
}

/* ===== 扫码授权的命令面（auth.rs 移植） ===== */

/** office_oauth_begin 结果：授权页地址 + 本次 state（渲染端保管，提交时原样回传）。 */
export interface OAuthBeginResult {
  authorizeUrl: string;
  state: string;
}

/** 授权状态。绝不回 access_token / refresh_token —— 渲染端只需要知道「有没有、还新不新」。 */
export interface OAuthStatus {
  authorized: boolean;
  /** 是否已过期。未授权恒为 false。字面到期时刻判定，不带刷新提前量。 */
  expired: boolean;
  expiresAt?: number;
  scope?: string | null;
  userId?: string | null;
}

function statusFromToken(set: TokenSet): OAuthStatus {
  return {
    authorized: true,
    expired: isExpired(set, nowMs(), 0),
    expiresAt: set.expiresAt,
    scope: set.scope ?? null,
    userId: set.userId ?? null,
  };
}

/** 拼授权页地址 + 生成一次性 state。纯函数，不发网络请求。 */
export function oauthBegin(args: { client: OAuthClientArgs }): OAuthBeginResult {
  const cfg = clientConfig(args.client);
  if (cfg.clientId === "") throw new Error("缺少 clientId（开放平台应用的 client_id）");
  if (cfg.redirectUri === "") throw new Error("缺少 redirectUri（须与开放平台登记的回调地址逐字一致）");
  // 一次性 state：16 字节随机 → 32 位十六进制。
  const state = randomBytes(16).toString("hex");
  return { authorizeUrl: buildAuthorizeUrl(cfg, state), state };
}

/** 交回调换 token 并落盘。先解析回调、再取密钥、最后才发请求（拒绝时报「授权被拒绝」）。 */
export async function oauthSubmit(
  dataDir: string,
  args: { client: OAuthClientArgs; callback: string; expectedState?: string | null },
): Promise<OAuthStatus> {
  const cfg = clientConfig(args.client);
  const outcome = parseCallback(args.callback);
  if (outcome.kind === "denied") {
    const detail = (outcome.description ?? "").trim();
    throw new Error(detail === "" ? "授权被拒绝：" + outcome.error : "授权被拒绝：" + outcome.error + "（" + detail + "）");
  }
  const code = outcome.code;
  const expected = (args.expectedState ?? "").trim();
  if (expected !== "" && outcome.state !== expected) {
    throw new Error("回调里的 state 与本次授权不一致：可能粘贴了别的会话的回调地址，请重新授权");
  }
  const secret = clientSecret(args.client);
  const set = await exchangeCode(cfg, secret, code);
  saveToken(dataDir, cfg.clientId, set);
  return statusFromToken(set);
}

/** 查某 client 的授权状态。查不到 = 未授权（不是错误）。 */
export function oauthStatus(dataDir: string, args: { clientId: string }): OAuthStatus {
  const set = loadToken(dataDir, args.clientId);
  return set === null ? { authorized: false, expired: false } : statusFromToken(set);
}

/** 退出登录：清掉该 client 的令牌。 */
export function oauthLogout(dataDir: string, args: { clientId: string }): void {
  clearToken(dataDir, args.clientId);
}

/* ===== 本地 LibreOffice 转换（convert.rs 移植） ===== */

/** 转换超时：首次运行要建字体缓存，给足；正常文档约 1–3s。 */
const CONVERT_TIMEOUT_MS = 120_000;
/** 输入上限：与 fs_read_binary 的 20MB 契约一致。 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 产物上限：转换产物走二进制返回，不经 20MB 读上限，故另设一档。 */
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
/** 诊断文本（stdout/stderr）截断长度。 */
const DIAG_CHARS = 400;
/** 单股输出的读取上限（到顶后继续读但丢弃，避免管道写满阻塞子进程）。 */
const STREAM_CAP = 64 * 1024;
/** 进程内自增序号：配合时间戳与 pid 保证 scratch 目录唯一。 */
let scratchSeq = 0;

export type SofficeSource = "config" | "path" | "bundle";

export interface ConvertInfo {
  /** 宿主是否具备可用的 soffice。 */
  available: boolean;
  /** 解析到的 soffice 路径（诊断用）。 */
  path: string | null;
  /** 来源。path 为 null 但 source 为 config 表示「配了但不可用」。 */
  source: SofficeSource | null;
}

let cachedSoffice: { tool: SofficeTool } | null = null;

export class SofficeTool {
  private constructor(
    private readonly programPath: string | null,
    readonly source: SofficeSource | null,
  ) {}

  static fromPath(programPath: string | null, source: SofficeSource | null): SofficeTool {
    return new SofficeTool(programPath, source);
  }

  info(): ConvertInfo {
    return { available: this.programPath !== null, path: this.programPath, source: this.source };
  }
}

function probeProgram(program: string): string | null {
  // 绝对路径直接探测；裸名按 PATH 解析（纯文件系统命中，不起进程）。
  const candidates = path.isAbsolute(program)
    ? [program]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => entry !== "")
        .map((entry) => path.join(entry, program));
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return candidate;
    } catch {
      // 试下一个。
    }
  }
  return null;
}

/** macOS 上 LibreOffice 通常不在 PATH，而在应用包内。 */
function probeMacosBundle(): string | null {
  if (process.platform !== "darwin") return null;
  const home = process.env.HOME ?? "";
  const candidates = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ...(home !== "" ? [path.join(home, "Applications/LibreOffice.app/Contents/MacOS/soffice")] : []),
  ];
  for (const candidate of candidates) {
    const found = probeProgram(candidate);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 解析顺序：显式配置（GREYWORK_SOFFICE_PATH）→ PATH 探测 → macOS 应用包。
 * 显式配置**优先且权威**：配了却不可用时不回落 PATH，记为「配置了但不可用」。
 */
export function discoverSoffice(): SofficeTool {
  if (cachedSoffice !== null) return cachedSoffice.tool;
  let tool: SofficeTool;
  const explicit = (process.env.GREYWORK_SOFFICE_PATH ?? "").trim();
  if (explicit !== "") {
    const found = probeProgram(explicit);
    tool = SofficeTool.fromPath(found, "config");
  } else {
    const onPath = probeProgram("soffice" + (process.platform === "win32" ? ".exe" : ""));
    if (onPath !== null) {
      tool = SofficeTool.fromPath(onPath, "path");
    } else {
      const bundled = probeMacosBundle();
      tool = SofficeTool.fromPath(bundled, bundled !== null ? "bundle" : null);
    }
  }
  cachedSoffice = { tool };
  return tool;
}

/** 找不到 soffice 时的错误文案：区分「配了但不可用」与「压根没装」。 */
function missingSofficeMessage(tool: SofficeTool): string {
  if (tool.source === "config") {
    return "GREYWORK_SOFFICE_PATH 指向的 soffice 不可用：请确认该路径存在且可执行";
  }
  return "未找到 LibreOffice（soffice）。Docker 镜像已内置；本机请安装 LibreOffice，或设置 GREYWORK_SOFFICE_PATH 指向 soffice 可执行文件";
}

/** -env:UserInstallation= 需要的 file:// URI（空格与中文必须编码）。 */
export function fileUri(target: string): string {
  const normalized = target.replaceAll("\\\\", "/");
  const absolute = normalized.startsWith("/") ? normalized : "/" + normalized;
  let out = "";
  for (const byte of Buffer.from(absolute, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~/~-]/.test(character)) out += character;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return "file://" + out;
}

/** soffice 的产物路径约定：out_dir/<输入主名>.pdf。 */
export function expectedOutputPath(outDir: string, input: string): string {
  const stem = path.basename(input, path.extname(input));
  return path.join(outDir, stem + ".pdf");
}

/** 建一次性 scratch 目录（<dataDir>/office/convert/<时间戳>-<pid>-<序号>）。 */
function scratchDir(dataDir: string): string {
  scratchSeq += 1;
  const dir = path.join(dataDir, DIR_NAME, "convert", Date.now() + "-" + process.pid + "-" + scratchSeq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 起 soffice 跑一次转换，回收合并前的 stdout / stderr。成功与否以「产物是否存在」为准。 */
function spawnConvert(program: string, profile: string, outDir: string, input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--norestore",
      "--invisible",
      "--nolockcheck",
      "--nodefault",
      "--nologo",
      "-env:UserInstallation=" + fileUri(profile),
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      input,
    ];
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const readCapped = (stream: NodeJS.ReadableStream | null): Promise<string> => {
      if (!stream) return Promise.resolve("");
      return new Promise((done) => {
        let buffer = Buffer.alloc(0);
        stream.on("data", (chunk: Buffer) => {
          if (buffer.length < STREAM_CAP) buffer = Buffer.concat([buffer, chunk.subarray(0, STREAM_CAP - buffer.length)]);
        });
        stream.on("end", () => done(buffer.toString("utf8")));
        stream.on("error", () => done(buffer.toString("utf8")));
      });
    };
    const stdoutPromise = readCapped(child.stdout);
    const stderrPromise = readCapped(child.stderr);
    const timer = setTimeout(() => {
      // 超时：先收整棵进程树，再回收直接子进程。
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        // 已退出。
      }
      child.kill("SIGKILL");
      reject(new Error("LibreOffice 转换超时（" + CONVERT_TIMEOUT_MS / 1000 + "s）"));
    }, CONVERT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error("启动 LibreOffice 失败: " + error.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      void Promise.all([stdoutPromise, stderrPromise]).then(
        ([stdout, stderr]) => resolve({ stdout, stderr }),
        (error: Error) => reject(error),
      );
    });
  });
}

/** 定位产物：先按约定名，退化到扫描 out/ 里第一个 .pdf。 */
function findOutput(outDir: string, input: string): string | null {
  const expected = expectedOutputPath(outDir, input);
  try {
    if (statSync(expected).isFile()) return expected;
  } catch {
    // 退化扫描。
  }
  try {
    for (const entry of readdirSync(outDir)) {
      if (entry.toLowerCase().endsWith(".pdf")) {
        const candidate = path.join(outDir, entry);
        if (statSync(candidate).isFile()) return candidate;
      }
    }
  } catch {
    // 无产物。
  }
  return null;
}

function diagnostics(stdout: string, stderr: string): string {
  const trimmed = (stdout + "\n" + stderr).trim();
  return trimmed === "" ? "（无输出）" : truncateChars(trimmed, DIAG_CHARS);
}

/** 把一份**已授权**的 Office 文件转成 PDF，返回字节。 */
export async function convertToPdf(dataDir: string, access: WorkspaceAccess, tool: SofficeTool, args: { path: string }): Promise<Buffer> {
  const program = tool.info().path;
  if (program === null) throw new Error(missingSofficeMessage(tool));

  // 授权先于一切：未授权路径在起进程之前就拒。
  const input = access.resolveExisting(args.path);
  const size = statSync(input).size;
  if (size > MAX_INPUT_BYTES) {
    throw new Error("文件超过 20MB 上限，无法用 LibreOffice 转换");
  }

  const scratch = scratchDir(dataDir);
  try {
    const profile = path.join(scratch, "profile");
    const outDir = path.join(scratch, "out");
    mkdirSync(profile, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    const { stdout, stderr } = await spawnConvert(program, profile, outDir, input);
    const output = findOutput(outDir, input);
    if (output === null) {
      throw new Error("LibreOffice 未产出 PDF：" + diagnostics(stdout, stderr));
    }
    const outputSize = statSync(output).size;
    if (outputSize > MAX_OUTPUT_BYTES) {
      throw new Error("转换产物超过 128MB 上限");
    }
    return readFileSync(output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ===== 云端预览上传取件（mod.rs::open_preview 移植） ===== */

/** 上传工作区文件并取回可嵌入的文档地址。 */
export async function openPreview(dataDir: string, access: WorkspaceAccess, args: PreviewOpenArgs): Promise<PreviewResult> {
  validateRecipe(args.recipe);

  // 凭证来源二选一：配方里用了 {{OAUTH_ACCESS_TOKEN}} → 取已存的 OAuth access_token；
  // 否则沿用「从环境变量解析」的老路（credentialEnv 为空 = 本地/无鉴权服务）。
  let oauthToken: string | null = null;
  if (usesOauthToken(args)) {
    if (args.oauth === undefined || args.oauth === null) {
      throw new Error(
        "配方使用了 " +
          OAUTH_TOKEN_PLACEHOLDER +
          "，但调用未提供 oauth 配置（请在服务配置里填好 clientId / clientSecretEnv / redirectUri）",
      );
    }
    const secret = clientSecret(args.oauth);
    oauthToken = await resolveAccessToken(dataDir, clientConfig(args.oauth), secret);
  } else {
    ensureCredential(args.credentialEnv);
  }

  const bytes = access.readBinary(args.path);
  const filename = filenameOf(args.path);
  const url = renderUrl(args.recipe.url.trim(), filename);

  const contentType = nonBlank(args.recipe.contentType) ?? contentTypeFor(filename);

  const method = args.recipe.method.trim().toUpperCase() === "PUT" ? "PUT" : "POST";
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    headers[key.toLowerCase()] = resolveHeaderPlaceholders(substituteOauthToken(value, oauthToken));
  }
  const credentialHeader = splitHeaderTemplate(args.recipe.credentialHeader);
  if (credentialHeader !== null) {
    const [name, value] = credentialHeader;
    headers[name.toLowerCase()] = resolveHeaderPlaceholders(substituteOauthToken(value, oauthToken));
  }

  let body: BodyInit;
  if (args.recipe.body.trim() === BODY_MULTIPART) {
    // multipart 用于多数国内厂商的「上传文件」接口；undici 的 FormData 自动生成边界。
    const field = nonBlank(args.recipe.fileField) ?? "file";
    const form = new FormData();
    form.append(field, new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
    body = form;
  } else {
    // raw-bytes 用于 Microsoft Graph 那类「PUT 整文件到路径」的接口。
    headers["content-type"] = contentType;
    body = new Uint8Array(bytes);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error("云端 Office 上传失败（网络层）: " + (error as Error).message, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error("云端 Office 上传失败 (" + response.status + ")：" + truncateChars(text, ERROR_BODY_CHARS));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      "云端 Office 响应不是 JSON: " + (error as Error).message + "（响应体：" + truncateChars(text, ERROR_BODY_CHARS) + "）",
      {
        cause: error,
      },
    );
  }
  return { url: extractViewUrl(parsed, args.recipe.viewUrlPointer), filename };
}

/** 解析请求头值里的 {{ENV_VAR}} 占位符；变量缺失就报错，绝不把模板原样发出去。 */
function resolveHeaderPlaceholders(value: string): string {
  let out = "";
  let rest = value;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) {
      // 只有 {{ 没有 }}：按字面量保留，交给服务端判定合法性。
      out += rest.slice(start);
      break;
    }
    const name = after.slice(0, end).trim();
    const resolved = process.env[name] ?? "";
    if (resolved === "") {
      throw new Error(
        "未设置环境变量 " +
          name +
          "：请求头占位符 {{" +
          name +
          "}} 无法解析，请先 export 后从同一终端启动 GreyWork（或到设置页修改该请求头）",
      );
    }
    out += resolved;
    rest = after.slice(end + 2);
  }
  return out;
}

/* ===== 宿主侧事实查询 ===== */

/** 桌面壳静态 CSP 里放行的 frame-src 来源（三个预设厂商的文档域名）。 */
export const EMBEDDABLE_FRAME_ORIGINS = ["https://www.kdocs.cn", "https://docs.qq.com", "https://view.officeapps.live.com"];

/** 查询宿主侧事实：回「变量名是否已设置」，不是值 —— 密钥永不回渲染端。 */
export function hostInfo(
  embeddableFrameOrigins: string[],
  envNames: string[],
): { embeddableFrameOrigins: string[]; envPresent: string[]; envMissing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of envNames) {
    const trimmed = name.trim();
    if (trimmed === "") continue;
    if ((process.env[trimmed] ?? "") === "") missing.push(trimmed);
    else present.push(trimmed);
  }
  return { embeddableFrameOrigins, envPresent: present, envMissing: missing };
}
