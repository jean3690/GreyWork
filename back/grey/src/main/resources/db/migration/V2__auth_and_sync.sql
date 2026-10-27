-- 一次性入场码：自托管首次启动打印，用哈希存库
CREATE TABLE enrollment_code (
    id         BIGINT      NOT NULL,
    code_hash  CHAR(64)    NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    used_at    DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_enrollment_code_hash (code_hash)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 同步对象的当前状态（每用户每对象一行）
CREATE TABLE sync_object (
    user_id    BIGINT       NOT NULL,
    kind       VARCHAR(32)  NOT NULL,
    object_id  VARCHAR(128) NOT NULL,
    revision   BIGINT       NOT NULL,
    deleted    TINYINT(1)   NOT NULL DEFAULT 0,
    payload    JSON         NULL,
    updated_at DATETIME(3)  NOT NULL,
    PRIMARY KEY (user_id, kind, object_id),
    KEY idx_sync_object_revision (user_id, revision)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 变更日志：自增 id 即全局 revision，客户端拿它当 since 游标
CREATE TABLE sync_change (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    user_id    BIGINT      NOT NULL,
    kind       VARCHAR(32) NOT NULL,
    object_id  VARCHAR(128) NOT NULL,
    deleted    TINYINT(1)  NOT NULL DEFAULT 0,
    payload    JSON        NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_sync_change_user (user_id, id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
