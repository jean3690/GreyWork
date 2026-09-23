export type FileKind = "file" | "directory";
export type EditorDocumentKind = "code" | "markdown" | "csv" | "json" | "image";

export interface FileEntry {
  path: string;
  kind: FileKind;
  size?: number;
  modifiedAt?: string;
  language?: string;
}

export interface EditorDocument {
  path: string;
  language: string;
  content: string;
  kind: EditorDocumentKind;
}

/** 变更状态；与宿主 `git.rs` 的 `letter_to_status` 映射一致。 */
export type GitChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface GitStatusEntry {
  path: string;
  status: GitChangeStatus;
  staged?: boolean;
}

export interface CommitResult {
  hash: string;
  message: string;
  timestamp: string;
}

/** 一条历史提交的元信息（不含 diff 正文 —— 正文由 `HistoryGitService.show` 按需取）。 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  /** committer date，ISO 8601（带时区偏移）。 */
  timestamp: string;
  /** 提交主题（消息首行）。 */
  subject: string;
  /** 指向这条提交的引用装饰（如 `HEAD -> main, tag: v1`）；空串 = 无。 */
  refs: string;
}

export interface WorkspaceFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** 写入二进制文件（xlsx 等产物）。二进制独立存储，不参与 snapshot/git/diff。 */
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  /** 读取二进制文件；非二进制路径抛错。 */
  readBinary(path: string): Promise<Uint8Array>;
  /** 删除文件（不存在时抛错）。 */
  delete(path: string): Promise<void>;
  /** 重命名 / 移动文件（源不存在时抛错；目标直接覆盖）。 */
  rename(from: string, to: string): Promise<void>;
  list(dir?: string): Promise<FileEntry[]>;
  exists(path: string): Promise<boolean>;
  /** 全量快照（path → content），供 git 基线与调试。不含二进制文件。 */
  snapshot(): Record<string, string>;
}

/**
 * 变更条目（**分侧**）。
 *
 * 同一个文件可以同时有「已暂存」和「未暂存」的改动（porcelain 的 `MM`），所以两侧各自
 * 带状态与行数 —— `null` 表示这一侧没有改动。提交只吃 index 侧，行数也只按侧统计。
 */
export interface GitChange {
  path: string;
  /** 重命名 / 复制的旧路径（index 侧），没有则为 null。 */
  oldPath: string | null;
  /** index（已暂存）侧的状态。 */
  index: GitChangeStatus | null;
  /** worktree（未暂存）侧的状态。 */
  worktree: GitChangeStatus | null;
  stagedAdd: number;
  stagedDel: number;
  /** worktree 侧行级增删。 */
  add: number;
  del: number;
}

export interface GitService {
  status(): Promise<GitStatusEntry[]>;
  /** status + 每文件分侧行级增删统计（供变更面板一次取全）。 */
  changes(): Promise<GitChange[]>;
  diff(path?: string): Promise<string>;
  commit(message: string): Promise<CommitResult>;
  currentBranch(): Promise<string>;
  branches(): Promise<string[]>;
}

/**
 * 带暂存能力的 Git 服务：**只有真实宿主 git 提供**。
 *
 * 内存工作区（`createMemoryGitService`）根本没有 index 概念，把 stage/unstage 塞进
 * 基接口只会逼它假装实现；需要暂存的调用方（变更面板）显式向上取这一层。
 */
export interface StagingGitService extends GitService {
  /** 暂存指定路径（相对仓库根）。 */
  stage(paths: string[]): Promise<void>;
  /** 暂存全部（含未跟踪文件）。 */
  stageAll(): Promise<void>;
  /** 取消暂存指定路径（重命名的旧路径由宿主自动成对处理）。 */
  unstage(paths: string[]): Promise<void>;
  /** 取消暂存全部。 */
  unstageAll(): Promise<void>;
  /** `staged = false` 看未暂存侧，`true` 看已暂存侧；缺省为未暂存侧。 */
  diff(path?: string, staged?: boolean): Promise<string>;
  /** `options.all` 为真时先 `add -A`（提交全部），否则只提交已暂存的内容。 */
  commit(message: string, options?: { all?: boolean }): Promise<CommitResult>;
}

/**
 * 带提交历史查询的 Git 服务：同样**只有真实宿主 git 提供**。
 *
 * 内存工作区（`createMemoryGitService`）只在 commit 时把当前快照换成新基线，压根不留历史，
 * 硬凑一份假列表没有意义；需要历史的调用方（变更面板的「历史」页）显式向上取这一层。
 */
export interface HistoryGitService extends StagingGitService {
  /** 历史提交（新 → 旧）。`limit` 缺省 50，`skip` 用于翻页。 */
  log(options?: { limit?: number; skip?: number }): Promise<GitCommit[]>;
  /** 单次提交引入的 unified diff 文本；`path` 限定时只看该路径。 */
  show(hash: string, path?: string): Promise<string>;
}

export interface PreviewCapabilities {
  codeEditor: "codemirror";
  markdown: boolean;
  table: boolean;
  image: boolean;
  gitPanel: boolean;
}
