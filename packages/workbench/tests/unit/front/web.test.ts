/**
 * WEB_FRONT 的特性子集契约。
 *
 * 这是「一个后端、多个前端」真正落地与否的证据文件：`apps/web` 与 `apps/desktop` 跑同一份
 * workbench，靠的就是这一份**静态声明**分叉。所以这里锁的不是「配置写对了没」，而是
 * 「哪几块被有意排除、以及为什么」——每条排除都对应一个具体的失败场景，改窄/改宽时它会红。
 *
 * 跨前端的不变量（子集关系、无重复 id）也在这里锁：`apps/web/tests/unit/main.dom.test.ts`
 * 引用的就是本文件（它把 WEB_FRONT 打桩成 `{ id: "web" }`，只验证「入口声明的是它自己那一份」，
 * 内容归这里管），而 workbench 目前没有独立的 `front/spec.test.ts`，两处各写一段同样的循环
 * 不如就地放一份。
 */
import { describe, expect, it } from "vitest";
import { ALL_FEATURES_FRONT } from "@/front/all";
import { WEB_FRONT } from "@/front/web";
import type { FrontSpec, ShellWiringId } from "@/front/types";

const idsOf = (front: FrontSpec) => front.features.map((f) => f.id);

describe("WEB_FRONT", () => {
  it("声明自己的前端身份：不是桌面端、也不是「未知」", () => {
    expect(WEB_FRONT.id).toBe("web");
    expect(WEB_FRONT.id).not.toBe(ALL_FEATURES_FRONT.id);
    expect(WEB_FRONT.label).not.toBe("");
  });

  it("特性集恰好是 guid / conversation / automation / plugins，顺序即路由优先级", () => {
    // 顺序是有意义的（先注册者赢同一路径多匹配），所以用精确数组而不是集合比较：
    // 顺带把「谁被加进来/挪了位置」都变成一次显式的评审。
    // plugins 是有意取用的（对标 vscode.dev 的浏览器端插件体验）：运行时纯前端，
    // 安装通道走 `plugin_market_*`（全部 desktop:false）；排除它才是需要评审的改动。
    expect(idsOf(WEB_FRONT)).toEqual(["guid", "conversation", "automation", "plugins"]);
  });

  it("不启用 channels：浏览器里开一个标签页，不该替用户把六条 IM 通道拨上线", () => {
    // channels 的 `setup` 拥有通道监听注册与自动连接（见 features/channels/spec.ts）。
    // 它在桌面端是「宿主就在本机、用户显式配过账号」的前提下的行为；搬到浏览器里，
    // 同一次 setup 会变成「页面一打开就连上用户所有通道」。这是静态特性集最实的收益，
    // 也是唯一一条**不是**纯粹产品取舍的排除项 —— 所以单独钉一条用例。
    expect(idsOf(WEB_FRONT)).not.toContain("channels");
    // 反向确认这条排除不是无效断言：全特性集合里确实有它，两边真的分叉了。
    expect(idsOf(ALL_FEATURES_FRONT)).toContain("channels");
  });

  it("特性都取自全量集合，没有凭空多出一个", () => {
    const known = new Set(idsOf(ALL_FEATURES_FRONT));
    for (const id of idsOf(WEB_FRONT)) expect(known).toContain(id);
  });

  it("特性 id 不重复：重复 = 同一份路由被注册两次，优先级也跟着变形", () => {
    const ids = idsOf(WEB_FRONT);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("接线留下 queueBridge，去掉托盘与关窗守卫", () => {
    // queueBridge 必须在 setup 期就位（补发由 store 内触发，晚一步走错分支，见 lib/queue-bridge.ts），
    // 所以它不能随「宿主集成」一起被乐观地删掉。
    expect(WEB_FRONT.shell.wiring).toContain("queueBridge");
    expect(WEB_FRONT.shell.wiring).toContain("hostNotifications");
    // 托盘与「点 X 关窗」是桌面壳独有的动作，浏览器里根本不存在这两个触发源。
    // 注意这是**语义**取舍而非修坏东西：这两条接线在无宿主环境下本来就安全
    //（桌面端在浏览器 dev 预览里就带着四条跑），去掉是因为它们在这里永远不会有输入。
    const wiring: readonly ShellWiringId[] = WEB_FRONT.shell.wiring;
    expect(wiring).not.toContain("tray");
    expect(wiring).not.toContain("closeGuard");
    // 接线 id 不重复：重复安装等于同一份订阅装两遍。
    expect(new Set(wiring).size).toBe(wiring.length);
  });

  it("面板本轮与全特性端一致 —— 外壳形态不在本阶段分叉", () => {
    // 收窄面板（例如 Web 端去掉活动带/终端）动的是 syncViewport() 的视口语义，
    // 值得单独一处改动。这条用例让「面板悄悄跟着特性一起被改窄」不能蒙混过去。
    expect(WEB_FRONT.shell.panels).toEqual(ALL_FEATURES_FRONT.shell.panels);
    for (const [name, visible] of Object.entries(WEB_FRONT.shell.panels)) {
      expect(typeof visible, `panel ${name} 应为布尔`).toBe("boolean");
    }
  });
});
