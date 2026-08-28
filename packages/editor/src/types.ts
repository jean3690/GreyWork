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

export interface GitStatusEntry {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged?: boolean;
}

export interface CommitResult {
  hash: string;
  message: string;
  timestamp: string;
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

export interface GitChange extends GitStatusEntry {
  /** 相对基线新增行数。 */
  add: number;
  /** 相对基线删除行数。 */
  del: number;
}

export interface GitService {
  status(): Promise<GitStatusEntry[]>;
  /** status + 每文件行级增删统计（供变更面板一次取全）。 */
  changes(): Promise<GitChange[]>;
  diff(path?: string): Promise<string>;
  commit(message: string): Promise<CommitResult>;
  currentBranch(): Promise<string>;
  branches(): Promise<string[]>;
}

export interface PreviewCapabilities {
  codeEditor: "codemirror";
  markdown: boolean;
  table: boolean;
  image: boolean;
  gitPanel: boolean;
}
