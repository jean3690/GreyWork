-- 自动化任务：控制面成为任务真源，宿主离线时也能排队，下次心跳后补跑。
-- id 由客户端生成（at-xxx）或服务端生成；同一用户内唯一，故用 (user_id, id) 复合主键。
CREATE TABLE automation_task (
    id              VARCHAR(64)  NOT NULL,
    user_id         BIGINT       NOT NULL,
    name            VARCHAR(128) NOT NULL DEFAULT '',
    schedule        VARCHAR(128) NOT NULL DEFAULT '',
    cron_expr       VARCHAR(96)  NULL,
    once_at         DATETIME(3)  NULL,
    acp_provider_id VARCHAR(64)  NULL,
    target          VARCHAR(255) NOT NULL DEFAULT '',
    intent          TEXT         NOT NULL,
    execution       VARCHAR(16)  NOT NULL DEFAULT 'host',
    host_device_id  BIGINT       NULL,
    model           VARCHAR(128) NULL,
    enabled         TINYINT(1)   NOT NULL DEFAULT 0,
    last_run_at     DATETIME(3)  NULL,
    next_run_at     DATETIME(3)  NULL,
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    deleted_at      DATETIME(3)  NULL,
    PRIMARY KEY (user_id, id),
    KEY idx_automation_task_due (enabled, next_run_at),
    KEY idx_automation_task_user (user_id, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 到期队列：调度器入队，宿主或云端执行器认领，完成后回写。
CREATE TABLE automation_due (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    user_id         BIGINT       NOT NULL,
    task_id         VARCHAR(64)  NOT NULL,
    name            VARCHAR(128) NOT NULL DEFAULT '',
    target          VARCHAR(255) NOT NULL DEFAULT '',
    intent          TEXT         NOT NULL,
    acp_provider_id VARCHAR(64)  NULL,
    execution       VARCHAR(16)  NOT NULL DEFAULT 'host',
    host_device_id  BIGINT       NULL,
    model           VARCHAR(128) NULL,
    due_at          DATETIME(3)  NOT NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
    claimed_by      BIGINT       NULL,
    claimed_at      DATETIME(3)  NULL,
    finished_at     DATETIME(3)  NULL,
    run_id          BIGINT       NULL,
    created_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_automation_due (user_id, task_id, due_at),
    KEY idx_automation_due_pull (user_id, execution, status, due_at),
    KEY idx_automation_due_host (user_id, host_device_id, status, due_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- 运行记录：宿主执行与云端执行共用一张表。
CREATE TABLE automation_run (
    id                 BIGINT      NOT NULL AUTO_INCREMENT,
    user_id            BIGINT      NOT NULL,
    task_id            VARCHAR(64) NOT NULL,
    name               VARCHAR(128) NOT NULL DEFAULT '',
    status             VARCHAR(16) NOT NULL DEFAULT 'running',
    detail             TEXT        NULL,
    session_id         VARCHAR(128) NULL,
    mode               VARCHAR(16) NOT NULL DEFAULT 'host',
    output             MEDIUMTEXT  NULL,
    artifact_object_id BIGINT      NULL,
    started_at         DATETIME(3) NULL,
    finished_at        DATETIME(3) NULL,
    created_at         DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_automation_run_user (user_id, created_at),
    KEY idx_automation_run_task (user_id, task_id, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
