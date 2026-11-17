# 客户端用户账号

桌面端与自托管工作台可通过左下角 **用户账号**（或 **设置 → 用户账号**）连接 `back/grey` Java 后端。
这与工作台的访问密码登录是两套独立认证；退出服务器账号不会删除本地会话，也不会把工作台锁回访问密码页。

## 使用

1. 启动 Java 后端，在运维台的「入场码」页面签发入场码。首次启动生成的入场码也可使用。
2. 在客户端填写 Java 后端地址（例如 `http://localhost:8080`）、邮箱、入场码。
   显示名称和设备名称可选；已有用户的显示名称遵循后端入场码接口的现有规则。
3. 点击「登录并连接」。账号页显示 Java 返回的用户、角色和当前设备；侧栏同步显示名称或邮箱。
4. 点击「刷新账号」重新核验身份。凭据被撤销时会显示错误并回到登录表单；本地工作不受影响。
5. 「退出服务器账号」需确认，先撤销 Java 登录凭据，再删除宿主连接配置并停止心跳/云端任务认领。
   若服务器不可达，退出不会假装成功，保留凭据供重试；已过期（401）的凭据可直接清理。

Java 后端地址是**宿主可访问的地址**：远程工作台中的 `localhost` 指宿主服务器，而不是浏览器所在电脑。
纯浏览器预览没有宿主，因此不提供账号登录。通过宿主转发请求不需要额外配置前端跨域。

## 安全与接口

- `POST /api/auth/enroll`：入场码登录，沿用 Java 的邮箱、显示名称、设备名称、平台契约。
- `GET /api/auth/me`：核验当前用户与设备，仅公开身份字段返回前端；用户 Long ID 按字符串保留。
- `POST /api/auth/logout`：撤销当前 token（不撤销其他设备）。
- 宿主命令：`control_plane_connect`、`control_plane_account`、`control_plane_logout`。
  所有命令均要求工作台宿主认证，不开放匿名命令入口。
- token 仅存于宿主数据目录的 `control-plane.json`（0600），不进入 Pinia、localStorage 或设置快照。
- 用户账号与原有「控制面」设置共享连接；原有「断开」仅清除本机配置，不等于服务端撤销登录凭据。
- `GREYWORK_CONTROL_URL` / `GREYWORK_CONTROL_TOKEN` 同时配置时，账号由环境变量管理：界面可查看身份，不能换号或退出。

## 验证

```bash
pnpm --filter @greywork/host-node exec vitest run tests/control-plane.test.ts
pnpm --filter @greywork/workbench exec vitest run tests/unit/stores/user-account.test.ts src/features/account/__tests__/UserAccountPane.dom.test.ts src/features/shell/__tests__/SiderFooter.dom.test.ts
```

宿主测试使用本地 HTTP 服务验证 Java 接口契约、Bearer 请求、重启恢复、登出撤销与失败处理。
组件测试覆盖登录、共享侧栏身份、失效刷新、二次确认以及预览/环境变量门禁。
