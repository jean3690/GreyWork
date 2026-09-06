import { createAcpClient } from "@greywork/acp";

/** ACP client 单例：agent（会话域）与 runs（编排域）共享同一传输与事件流；
 *  监听器仍只由 agent store 注册一次，runs 经 bridge 路由。 */
export const acp = createAcpClient();
