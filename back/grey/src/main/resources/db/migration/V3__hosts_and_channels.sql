-- 宿主实例：一台设备登记成宿主后才有这一行，心跳走 Redis，DB 只留档案
CREATE TABLE host_instance (
    device_id    BIGINT       NOT NULL,
    user_id      BIGINT       NOT NULL,
    name         VARCHAR(128) NOT NULL DEFAULT '',
    version      VARCHAR(64)  NOT NULL DEFAULT '',
    capabilities JSON         NULL,
    created_at   DATETIME(3)  NOT NULL,
    updated_at   DATETIME(3)  NOT NULL,
    PRIMARY KEY (device_id),
    KEY idx_host_instance_user (user_id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 通道绑定：一个平台账号只能有一个宿主持有（唯一键兜底）
CREATE TABLE channel_binding (
    id             BIGINT       NOT NULL,
    user_id        BIGINT       NOT NULL,
    platform       VARCHAR(32)  NOT NULL,
    account_ref    VARCHAR(191) NOT NULL,
    host_device_id BIGINT       NULL,
    status         VARCHAR(16)  NOT NULL DEFAULT 'active',
    secret_hash    CHAR(64)     NOT NULL,
    created_at     DATETIME(3)  NOT NULL,
    updated_at     DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_channel_binding_account (user_id, platform, account_ref),
    KEY idx_channel_binding_host (host_device_id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 入站消息：控制面只做可靠收件箱，出站仍由宿主直连平台
CREATE TABLE channel_message (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    user_id        BIGINT       NOT NULL,
    binding_id     BIGINT       NOT NULL,
    host_device_id BIGINT       NULL,
    platform       VARCHAR(32)  NOT NULL,
    external_id    VARCHAR(191) NOT NULL,
    payload        JSON         NULL,
    received_at    DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_channel_message_external (binding_id, external_id),
    KEY idx_channel_message_host (host_device_id, id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
