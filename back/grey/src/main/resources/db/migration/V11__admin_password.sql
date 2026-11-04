-- 管理员密码登录：app_user 增列 password_hash（bcrypt）。
-- 为什么复用 app_user 而不是单独建 admin_account：管理员本来就是 app_user 里 role=admin 的账号，
-- 再建一张表就要做两套身份、两次同步；密码只是「这个账号额外可用的一种登录方式」。
-- 普通用户此列为 NULL —— 不影响入场码 / OIDC 登录，也与 role 无关。
-- 首次启动时 AdminCredentialBootstrap 会为 grey.auth.admin-emails 里的邮箱建号并写入初始密码
-- （GREY_ADMIN_PASSWORD 未配置则随机生成并打印到日志）。之后可在运维台「修改密码」里更换。
ALTER TABLE app_user
    ADD COLUMN password_hash VARCHAR(100) NULL AFTER role;
