-- 插件市场：包 → 版本 → 下载事件，registry.json 由这里生成
CREATE TABLE market_package (
    id            BIGINT       NOT NULL,
    owner_user_id BIGINT       NOT NULL,
    slug          VARCHAR(96)  NOT NULL,
    name          VARCHAR(128) NOT NULL,
    author        VARCHAR(64)  NULL,
    summary       VARCHAR(255) NULL,
    description   TEXT         NULL,
    category      VARCHAR(32)  NULL,
    tags          JSON         NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'draft',
    created_at    DATETIME(3)  NOT NULL,
    updated_at    DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_market_package_slug (slug),
    KEY idx_market_package_list (status, category, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE market_version (
    id              BIGINT       NOT NULL,
    package_id      BIGINT       NOT NULL,
    version         VARCHAR(32)  NOT NULL,
    download_url    VARCHAR(512) NOT NULL,
    sha256          CHAR(64)     NOT NULL,
    changelog       TEXT         NULL,
    channel         VARCHAR(16)  NOT NULL DEFAULT 'stable',
    rollout_percent INT          NOT NULL DEFAULT 100,
    downloads       BIGINT       NOT NULL DEFAULT 0,
    created_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_market_version (package_id, version),
    KEY idx_market_version_pick (package_id, channel, rollout_percent)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE market_download (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    package_id BIGINT      NOT NULL,
    version_id BIGINT      NOT NULL,
    slug       VARCHAR(96) NOT NULL,
    version    VARCHAR(32) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_market_download_pkg (package_id, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
