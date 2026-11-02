-- 控制面角色：目前只有 user / admin 两档。
-- 为什么不做权限点表：单用户自托管的运维面只有「管用户」与「发入场码」两件事，
-- 两档角色 + URL 前缀门禁足够；等真的出现第三方协作用户再谈细粒度权限。
ALTER TABLE app_user
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user' AFTER status;

-- 引导用：按邮箱把已有账号提成 admin（见 AdminBootstrap），按 role 过滤是启动时的唯一查询。
CREATE INDEX idx_app_user_role ON app_user (role);
