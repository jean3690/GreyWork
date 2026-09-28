/**
 * 第三方服务接入层：把「可对接的外部服务」从各领域里抽出来，收成一份注册表。
 *
 * 为什么落在 `@greywork/shell` 而不是新开包：这个包已经是 provider 注册表的家
 * （`DEFAULT_AGENT_PROVIDERS` / `DEFAULT_MODEL_PROVIDERS` / `createAgentProviderRegistry`），
 * 再开一个包会让「能对接什么外部服务」有两个真源。依赖方向也不允许 workbench 之外的地方
 * 自行定义（ESLint 强制 `shell ← core`，workbench 负责组合）。
 *
 * **凭证边界（沿用 llm.rs 的既有约束）**：这里只存凭证所在的**环境变量名**，
 * 明文凭证只在 Rust 宿主侧从环境变量解析。渲染端拿到的一律是「去哪个环境变量取」，
 * 因此设置快照、日志、IPC 载荷里都不会出现密钥。
 *
 * 本期只有 `office` 族真正被消费（见 `crates/greywork-host/src/office.rs`）；其余三族
 * 此处只固定类型接缝，各自的落点在注释里标明 —— 目的是让后续每个领域都是「加法」，
 * 而不是把接入层的形状再设计一遍。
 */

import type { ModelProviderConfig } from "./types";

/** 服务族。四族共用一套信封，但各自的 kind、落点、生命周期完全不同。 */
export type ServiceFamily = "office" | "model" | "storage" | "scheduler";

/**
 * 所有服务族的公共信封。
 *
 * 刻意保持「只有配置、没有行为」：行为一律在 Rust 宿主侧（网络、凭证、文件访问都在那边），
 * 这个接口只描述「用户配了什么」。往这里加方法会让渲染端产生「服务能自己发请求」的错觉，
 * 而实际边界是命令面。
 */
export interface ServiceProviderBase {
  id: string;
  name: string;
  enabled: boolean;
  /** 服务基址（厂商门户/网关地址）。具体请求路径由各族的 kind 或配方决定。 */
  baseUrl?: string;
  /** 凭证所在的**环境变量名**（宿主侧解析）；空/缺省 = 该服务不需要凭证。 */
  credentialEnv?: string;
  /**
   * 附加请求头。值支持 `{{ENV_VAR}}` 占位符，语义与 `ModelProviderConfig.headers` 一致 ——
   * 敏感值绝不随配置明文落盘，渲染端只保存占位符原文。
   */
  headers?: Record<string, string>;
  /**
   * 内嵌该服务页面时需要放进 CSP `frame-src` 的 origin（如 `https://docs.example.com`）。
   *
   * 之所以是**配置项**而不是预设里的常量：内嵌的是厂商返回的文档地址，其 origin 因厂商、
   * 因部署（公有云/私有化）而异，猜错的表现是 iframe 被 CSP 静默拦掉、页面一片空白。
   * 预设只提供「建议值」，最终以配置为准（服务端据此拼 CSP，见 apps/server/src/middleware.rs）。
   */
  frameOrigin?: string;
}

/* ===== office 族 ===== */

/**
 * 已支持的云端 Office 服务类别。
 *
 * 清单是**唯一真源**（`SERVICE_KINDS.office` 与设置页的下拉都取自它）：拆成「常量数组 +
 * 由它推导的联合类型」而不是各写一份，是为了让「加一个 kind」只改一处 —— 两份手改同步
 * 迟早会在某一侧漂移，而漂移的表现是设置页选得到、校验却拒收（或反过来）。
 */
export const OFFICE_PROVIDER_KINDS = ["wps365", "tencent-docs", "microsoft365", "custom"] as const;

export type OfficeProviderKind = (typeof OFFICE_PROVIDER_KINDS)[number];

/**
 * 「上传文件、换回一个可嵌入的文档地址」这一大类 API 的声明式配方。
 *
 * 为什么不给每个厂商写死一段代码：这类 API 的形状高度雷同（传字节 → 收 JSON → 取一个 URL），
 * 差异只在 URL、鉴权头、包体形态和响应结构上。把差异收进受限 JSON，一套逻辑覆盖全部厂商，
 * 也让「自定义」不用改代码 —— 这与 plugin-market 的声明式插件是同一套哲学：
 * **配置只描述，不执行**。
 */
export interface OfficeRecipe {
  method: "POST" | "PUT";
  /** 请求地址模板；`{filename}` 会被替换为 URL 编码后的文件名。 */
  url: string;
  /** 包体形态：原始字节（PUT 整文件）或 multipart 表单。 */
  body: "raw-bytes" | "multipart";
  /** `body=multipart` 时的文件字段名；缺省 `file`。 */
  fileField?: string;
  /** `body=raw-bytes` 时的 Content-Type；缺省按扩展名猜。 */
  contentType?: string;
  /**
   * 凭证请求头模板，形如 `Authorization: Bearer {{ENV}}`。
   * `{{ENV}}` 由宿主替换为 `credentialEnv` 指向的环境变量值。
   */
  credentialHeader?: string;
  /** 从响应 JSON 里取文档 URL 的 JSON 指针（如 `/data/url`）。 */
  viewUrlPointer: string;
}

export interface OfficeProviderConfig extends ServiceProviderBase {
  family: "office";
  kind: OfficeProviderKind;
  /**
   * 上传取件配方。
   *
   * 预设只填「厂商文档地址 / 凭证变量名 / 建议 frame origin」这些能确证的信息，
   * **不预填端点** —— 各家的上传接口与响应结构随手册版本变动，写死一份没核实过的调用路径
   * 比留空更糟（症状是运行时 404/解析失败，而不是配置页上一句提示）。填一次后随服务配置落盘。
   */
  recipe?: OfficeRecipe;
  /** 厂商开放平台文档地址（预设提供，供填写配方时对照）。 */
  docsUrl?: string;
}

/* ===== 其余三族的接缝（本期只固定形状，不接 UI、不接 dispatch） ===== */

/**
 * 云端存储族。
 * 长期落点：只读浏览接口 `list` / `stat` / `readBytes`，前端挂点是
 * `packages/workbench/src/state/workspaceFiles.ts` 与 `stores/vfs.ts`，
 * Rust 侧唯一收口是 `workspace_fs.rs`。
 *
 * 注意：既有的 `lib/webdav.ts` / `lib/remote-store-config.ts` 只服务「浏览器态会话落盘」
 * （见 StorageSettings.vue），**不是**通用存储抽象，不要往那个方向长。
 */
export type StorageProviderKind = "s3" | "oss" | "cos" | "webdav";

export interface StorageProviderConfig extends ServiceProviderBase {
  family: "storage";
  kind: StorageProviderKind;
  /** 桶名 / 根路径。 */
  bucket?: string;
}

/**
 * 定时任务族：把「到期后怎么执行」做成可插拔后端。
 * 长期落点：`crates/greywork-host/src/host_exec.rs` 与 `automation_due` 队列。
 * 本期只实现了「宿主成为主执行者」，见 `GREYWORK_AUTOMATION_HOST_PRIMARY`。
 */
export type SchedulerProviderKind = "host" | "webhook";

export interface SchedulerProviderConfig extends ServiceProviderBase {
  family: "scheduler";
  kind: SchedulerProviderKind;
}

/**
 * 模型族的信封：与既有的 `ModelProviderConfig` 同构（用交叉类型而不是重写一遍字段，
 * 免得两份定义各自漂移）。`family` 只用于把它并进统一列表展示。
 *
 * 长期接缝：`ModelProviderConfig.kind` 今日有 `anthropic` / `ollama`，但宿主 `llm.rs`
 * 目前一律走 openai-compatible 线格式（见该文件顶部注释的 Phase 1 说明）——
 * `kind → 协议适配器` 的落点在 `crates/greywork-host/src/llm.rs`。
 */
export type ModelServiceProviderConfig = ModelProviderConfig & { family: "model" };

export type ServiceProviderConfig = OfficeProviderConfig | StorageProviderConfig | SchedulerProviderConfig | ModelServiceProviderConfig;

/* ===== 预设 ===== */

/**
 * 云端 Office 预设。
 *
 * `recipe` 一律留空（理由见 `OfficeProviderConfig.recipe`）：预设能确证的只有文档地址、
 * 凭证变量名和内嵌页面的 origin，这三样正是「少踩坑」的部分，配方由用户对照文档填一次。
 */
export const DEFAULT_OFFICE_PROVIDERS: OfficeProviderConfig[] = [
  {
    id: "wps365",
    name: "WPS 365 / 金山文档",
    family: "office",
    kind: "wps365",
    enabled: false,
    baseUrl: "https://open.wps.cn",
    credentialEnv: "WPS365_ACCESS_TOKEN",
    frameOrigin: "https://www.kdocs.cn",
    docsUrl: "https://open.wps.cn/docs/",
  },
  {
    id: "tencent-docs",
    name: "腾讯文档",
    family: "office",
    kind: "tencent-docs",
    enabled: false,
    baseUrl: "https://docs.qq.com",
    credentialEnv: "TENCENT_DOCS_TOKEN",
    frameOrigin: "https://docs.qq.com",
    docsUrl: "https://docs.qq.com/open/document/",
  },
  {
    id: "microsoft365",
    name: "Microsoft 365 / OneDrive",
    family: "office",
    kind: "microsoft365",
    enabled: false,
    baseUrl: "https://graph.microsoft.com/v1.0",
    credentialEnv: "MSGRAPH_ACCESS_TOKEN",
    // Office Online 的嵌入式查看器；它抓取的是 Graph 返回的 webUrl。
    frameOrigin: "https://view.officeapps.live.com",
    docsUrl: "https://learn.microsoft.com/graph/api/driveitem-put-content",
  },
  {
    id: "custom",
    name: "自定义",
    family: "office",
    kind: "custom",
    enabled: false,
  },
];

/** 某族可选的 kind 清单（设置表单据此渲染下拉，避免与类型漂移）。 */
export const SERVICE_KINDS: Readonly<Record<ServiceFamily, readonly string[]>> = {
  office: OFFICE_PROVIDER_KINDS,
  model: ["openai-compatible", "anthropic", "ollama", "custom"],
  storage: ["s3", "oss", "cos", "webdav"],
  scheduler: ["host", "webhook"],
};

/** 族清单（设置页分组顺序与之一致）。 */
export const SERVICE_FAMILIES: readonly ServiceFamily[] = ["office", "model", "storage", "scheduler"];

/* ===== 注册表 ===== */

/**
 * 服务注册表（与 `createAgentProviderRegistry` 同构）。
 *
 * 只做「按 id 存取 + 按族筛选」，不含任何行为 —— 真正的请求都在宿主侧。
 * 校验放在 `set`：脏数据一旦进了设置快照，后面每个人消费时都要各防一次。
 */
export function createServiceRegistry(seed: ServiceProviderConfig[] = []) {
  const providers = new Map<string, ServiceProviderConfig>(seed.map((provider) => [provider.id, provider]));
  return {
    list(): ServiceProviderConfig[] {
      return Array.from(providers.values());
    },
    listByFamily(family: ServiceFamily): ServiceProviderConfig[] {
      return Array.from(providers.values()).filter((provider) => provider.family === family);
    },
    get(id: string): ServiceProviderConfig | undefined {
      return providers.get(id);
    },
    set(provider: ServiceProviderConfig) {
      if (!provider.id) throw new Error("provider.id is required");
      if (!SERVICE_FAMILIES.includes(provider.family)) {
        throw new Error(`unknown service family: ${provider.family}`);
      }
      if (!SERVICE_KINDS[provider.family].includes(provider.kind)) {
        throw new Error(`${provider.family} provider kind must be one of ${SERVICE_KINDS[provider.family].join(" / ")}`);
      }
      providers.set(provider.id, provider);
    },
  };
}

/**
 * 取当前可用的 office provider（预览决策用）。
 *
 * 「可用」= 已启用 **且** 填了配方 —— 只有开关没有配方的服务商跑不出结果，
 * 把它算作可用会让预览白白失败一次再回落，不如一开始就走本地 viewer。
 */
export function enabledOfficeProvider(providers: readonly OfficeProviderConfig[], selectedId?: string | null): OfficeProviderConfig | null {
  const usable = providers.filter((provider) => provider.enabled && provider.recipe);
  return usable.find((provider) => provider.id === selectedId) ?? usable[0] ?? null;
}
