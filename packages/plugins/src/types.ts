export interface CommandDecision {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
}

/** AI 可执行命令的策略：允许/拒绝/需要人工审批（执行面在 Rust 宿主 process_guard）。 */
export interface CommandPolicy {
  defaultAction: "allow" | "deny";
  allow?: string[];
  deny?: string[];
  requireApproval?: string[];
}
