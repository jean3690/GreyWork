-- 控制面基线：账号 / 第三方身份 / 设备
CREATE TABLE app_user (
    id           BIGINT       NOT NULL,
    email        VARCHAR(255) NOT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    status       VARCHAR(32)  NOT NULL DEFAULT 'active',
    created_at   DATETIME(3)  NOT NULL,
    updated_at   DATETIME(3)  NOT NULL,
    deleted_at   DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_user_email (email)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 一个用户可绑定多个登录方式：github / google / wechat / wecom / feishu ...
CREATE TABLE user_identity (
    id         BIGINT       NOT NULL,
    user_id    BIGINT       NOT NULL,
    provider   VARCHAR(32)  NOT NULL,
    subject    VARCHAR(191) NOT NULL,
    created_at DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_identity_provider_subject (provider, subject),
    KEY idx_user_identity_user (user_id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 设备：同步游标与推送令牌后续挂到这里
CREATE TABLE user_device (
    id           BIGINT       NOT NULL,
    user_id      BIGINT       NOT NULL,
    name         VARCHAR(128) NOT NULL DEFAULT '',
    platform     VARCHAR(32)  NOT NULL DEFAULT '',
    public_key   VARCHAR(512) NULL,
    last_seen_at DATETIME(3)  NULL,
    created_at   DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_user_device_user (user_id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
