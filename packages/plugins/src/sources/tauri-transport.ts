import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import type { SkillsMarketTransport } from "./types";

/** 桌面端传输：搜索/下载/安装/卸载全部经 Rust 宿主（skills_market.rs）。 */
export class TauriSkillsTransport implements SkillsMarketTransport {
  available(): boolean {
    return isTauriRuntime();
  }

  search(query: string): Promise<unknown> {
    return invoke("skills_search", { query });
  }

  download(entryRef: string): Promise<unknown> {
    return invoke("skills_download", { entryRef });
  }

  install(
    workspaceRoot: string,
    skillId: string,
    files: { path: string; contents: string }[],
  ): Promise<{ dir: string; filesWritten: number }> {
    return invoke("skills_install", { workspaceRoot, skillId, files });
  }

  uninstall(workspaceRoot: string, skillId: string): Promise<void> {
    return invoke("skills_uninstall", { workspaceRoot, skillId });
  }
}
