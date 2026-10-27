-- 供应商密钥池：密文存库，明文只在内存里出现
CREATE TABLE llm_key (
    id             BIGINT        NOT NULL,
    user_id        BIGINT        NOT NULL,
    provider       VARCHAR(32)   NOT NULL,
    label          VARCHAR(64)   NOT NULL,
    base_url       VARCHAR(255)  NOT NULL,
    secret_cipher  VARCHAR(1024) NOT NULL,
    status         VARCHAR(16)   NOT NULL DEFAULT 'active',
    last_used_at   DATETIME(3)   NULL,
    created_at     DATETIME(3)   NOT NULL,
    updated_at     DATETIME(3)   NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_llm_key_label (user_id, provider, label),
    KEY idx_llm_key_pool (user_id, provider, status, last_used_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 用量记账：每次代理调用一行，流式也记
CREATE TABLE llm_usage (
    id                BIGINT       NOT NULL AUTO_INCREMENT,
    user_id           BIGINT       NOT NULL,
    key_id            BIGINT       NULL,
    provider          VARCHAR(32)  NOT NULL DEFAULT '',
    model             VARCHAR(128) NOT NULL DEFAULT '',
    prompt_tokens     INT          NOT NULL DEFAULT 0,
    completion_tokens INT          NOT NULL DEFAULT 0,
    total_tokens      INT          NOT NULL DEFAULT 0,
    status            VARCHAR(16)  NOT NULL DEFAULT 'ok',
    http_status       INT          NOT NULL DEFAULT 0,
    latency_ms        BIGINT       NOT NULL DEFAULT 0,
    created_at        DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_llm_usage_user (user_id, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
