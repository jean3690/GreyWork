// happy-dom 环境 setup：组件测试的 DOM 全局挂载前准备。
//
// 前端身份没有缺省值（见 src/front/current.ts）：组件测试直接调 createAppRouter() /
// buildNavItems() / 单独挂载 Shell，必须有一个前端在场。这里统一声明全量集合，与拆分前的
// 缺省行为一致；想测某个子集的前端，在用例里自己 setFront 即可。
//
// **必须是 beforeAll 里的动态 import，不能在文件顶层静态 import**：setup 文件先于测试文件
// 求值，静态 import 会把 `@greywork/host-ipc` 等模块在 `vi.mock` 注册之前装进缓存，
// 于是测试里的 mock 全部失效（表现为 git / ACP 用例去打真实端口）。
import { beforeAll } from "vitest";

beforeAll(async () => {
  const [{ setFront }, { ALL_FEATURES_FRONT }] = await Promise.all([import("@/front/current"), import("@/front/all")]);
  setFront(ALL_FEATURES_FRONT);
});
