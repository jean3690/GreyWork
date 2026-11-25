# 客户端用户账号

桌面端与自托管工作台可通过左下角 **用户账号**（或 **设置 → 用户账号**）连接 `back/grey` Java 后端。
这与工作台的访问密码登录是两套独立认证；退出服务器账号不会删除本地会话，也不会把工作台锁回访问密码页。

## 使用

1. 启动 Java 后端；管理员账号由启动引导按 `GREY_ADMIN_EMAILS` + `GREY_ADMIN_PASSWORD` 种入。
2. 在客户端填写 Java 后端地址（例如 `http://localhost:8080`）、邮箱和密码。
   没有账号就点「注册并连接」（开放注册，注册即登录）；显示名称和设备名称可选。
3. 点击「登录并连接」。账号页显示 Java 返回的用户、角色和当前设备；侧栏同步显示名称或邮箱。
4. 点击「刷新账号」重新核验身份。凭据被撤销时会显示错误并回到登录表单；本地工作不受影响。
5. 「退出服务器账号」需确认，先撤销 Java 登录凭据，再删除宿主连接配置并停止心跳/云端任务认领。
   若服务器不可达，退出不会假装成功，保留凭据供重试；已过期（401）的凭据可直接清理。

## 个人资料与设备安全

- 登录后可修改显示名称（去掉首尾空白，1–128 个字符），保存后侧栏立即同步；运维台刷新即可看到新名称。
  邮箱与角色不可通过资料表单修改，已有账号再次用密码登录也不会覆盖昵称。
- 「设备与登录安全」列出当前账号的设备、平台和最近活跃时间，明确标记当前设备。
  设备记录不等于在线会话；没有活跃时间时显示「暂无记录」，不推断在线状态。
- 「吊销设备」经二次确认，删除其他设备记录并撤销其登录凭据；不能在此吊销当前设备，当前设备请使用「退出服务器账号」。
- 「退出其他设备」经二次确认，撤销其他全部设备的会话，保留当前设备与其他设备记录。
- 设备加载失败可刷新重试；401 会清理前端身份与设备列表并停止宿主心跳。切换或断开账号后，晚到的请求不能恢复旧身份。
- 环境变量管理的账号只能查看资料和设备，不允许从界面修改资料或撤销设备/会话。

Java 后端地址是**宿主可访问的地址**：远程工作台中的 `localhost` 指宿主服务器，而不是浏览器所在电脑。
纯浏览器预览没有宿主，因此不提供账号登录。通过宿主转发请求不需要额外配置前端跨域。

## 安全与接口

- `POST /api/auth/login` / `POST /api/auth/register`：邮箱密码登录与开放注册（注册即登录），
  沿用 Java 的邮箱、显示名称、设备名称、平台契约。
- `GET /api/auth/me`：核验当前用户与设备，仅公开身份字段返回前端；用户 Long ID 按字符串保留。
- `PATCH /api/auth/me`：仅修改当前用户显示名称（`{ displayName }`）。
- `GET /api/devices`、`DELETE /api/devices/{id}`：列出/吊销本人设备，用户与设备 Long ID 均以字符串返回。
- `DELETE /api/auth/sessions?includeCurrent=false`：撤销其他设备的会话，保留当前设备。
- `POST /api/auth/logout`：撤销当前 token（不撤销其他设备）。
- 宿主命令：`control_plane_connect`、`control_plane_account`、`control_plane_logout`。
  所有命令均要求工作台宿主认证，不开放匿名命令入口。
- 账号管理命令：`control_plane_profile_update`、`control_plane_devices`、`control_plane_device_revoke`、
  `control_plane_sessions_revoke`；只允许固定后端路径，不提供任意 URL 或凭据转发。
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
账号管理测试补充昵称保存、超长设备 ID 原样传递、设备吊销、其他设备退出、当前设备保护与旧请求丢弃。
