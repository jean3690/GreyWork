-- 对象存储元数据：正文在 S3（RustFS）里，这里只记账、鉴权与配额。
CREATE TABLE storage_object (
    id           BIGINT       NOT NULL,
    user_id      BIGINT       NOT NULL,
    bucket       VARCHAR(96)  NOT NULL,
    object_key   VARCHAR(512) NOT NULL,
    name         VARCHAR(255) NOT NULL DEFAULT '',
    content_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
    size_bytes   BIGINT       NOT NULL DEFAULT 0,
    sha256       CHAR(64)     NULL,
    kind         VARCHAR(32)  NOT NULL DEFAULT 'file',
    visibility   VARCHAR(16)  NOT NULL DEFAULT 'private',
    status       VARCHAR(16)  NOT NULL DEFAULT 'pending',
    source       VARCHAR(32)  NOT NULL DEFAULT 'upload',
    created_at   DATETIME(3)  NOT NULL,
    updated_at   DATETIME(3)  NOT NULL,
    deleted_at   DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_storage_object_key (bucket, object_key),
    KEY idx_storage_object_user (user_id, created_at),
    KEY idx_storage_object_pending (status, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
