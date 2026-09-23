/**
 * ```sendfile 围栏解析：AI 回复里声明的「把这些文件发给远程用户」→ 绝对路径列表。
 *
 * 为什么不是工具调用：与 ```schedule / ```cowork 同一条理由 —— 宿主没有向 agent 注册
 * 工具的通道，agent 侧也不存在 SendFile 这个工具（调了只会 not found）。输出围栏是既有
 * 同构模式，宿主在回合收尾解析。只认**带标签的围栏**，不扫裸路径 / 裸 JSON：模型输出的
 * 普通代码块里出现一个绝对路径，不该被当成发送指令。
 */

const SEND_FENCE = /```sendfile\s*([\s\S]*?)```/gi;

/** 绝对路径判定：POSIX 的 `/…`，或 Windows 的 `C:\` / `C:/`。 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

/**
 * 从模型输出里解析所有 sendfile 围栏，返回去重后的绝对路径（保持出现顺序）。
 *
 * 容错策略：JSON 坏、元素不是字符串、路径不是绝对路径的条目**整条丢弃** ——
 * 半份指令没有价值，而相对路径宿主无从解析（它会按自己的 cwd 猜，猜错就发错文件）。
 * 只做形状校验，不碰文件系统：路径是否存在、是否在授权面内由宿主在发送时判定。
 */
export function parseSendFences(output: string): string[] {
  const paths: string[] = [];
  for (const match of output.matchAll(SEND_FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]?.trim() ?? "");
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const path = entry.trim();
      if (!path || !isAbsolutePath(path) || paths.includes(path)) continue;
      paths.push(path);
    }
  }
  return paths;
}

/** 去掉全部 sendfile 围栏并修剪首尾空白：会话存档与通道文本都不该看见这段宿主指令。 */
export function stripSendFences(output: string): string {
  return output.replace(SEND_FENCE, "").trim();
}
