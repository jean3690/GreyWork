import { DEFAULT_COMMAND_POLICY } from "@greywork/plugins";
import type { AiLoopPolicy } from "./types";

export const DEFAULT_AI_LOOP_POLICY: AiLoopPolicy = {
  maxRounds: 12,
  commandGuard: DEFAULT_COMMAND_POLICY,
  toolAllowlist: ["read_file", "web_search", "spatial_query", "git_diff"],
  requireApproval: ["git push", "rm -rf", "publish"],
};
