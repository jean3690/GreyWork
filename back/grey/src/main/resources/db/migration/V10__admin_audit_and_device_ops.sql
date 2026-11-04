-- 运维操作审计：记录谁在何时做了禁用/踢人/改角色/吊销设备/签发或撤销入场码。
-- 设计口径与「已用入场码不能撤销」一致：审计线索是证据，删掉等于掩盖历史，
-- 所以本表只追加、不更新、不软删（全局 logic-delete 配的是 deleted_at，本表不含该列，不受影响）。
CREATE TABLE audit_log (
    id          BIGINT        NOT NULL PRIMARY KEY,
    actor_id    BIGINT        NULL,
    actor_email VARCHAR(255)  NOT NULL,
    action      VARCHAR(64)   NOT NULL,
    target_type VARCHAR(32)   NOT NULL,
    target_id   BIGINT        NULL,
    detail      VARCHAR(1024) NULL,
    created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_log_target ON audit_log (target_type, target_id);
-- 注：user_identity 按 user_id 反查的索引 idx_user_identity_user 在 V1 baseline 里已经建过，
-- 这里不要再 CREATE 一遍（MySQL 没有 CREATE INDEX IF NOT EXISTS，重复会 1061 直接中断迁移）。
