-- 能力目录：控制面下发的技能 / MCP 预设（运维台可增删改）。
--
-- 与 V6/V12 删掉的「插件市场」不是一回事：这里不存包、不签名、不做灰度，
-- 只存「可被桌面端安装的目录条目」——技能是纯文本快照（几十 KB），MCP 是一段预设配置。
-- 正文统一放 payload(JSON)：技能 = {files:[{path,contents}]}，MCP = {version,repository,packages,remotes}。
-- 单独建表而不是继续塞 JSON 资源：改一条目录不该要求重新构建后端。
CREATE TABLE catalog_item (
    id          BIGINT       NOT NULL,
    kind        VARCHAR(16)  NOT NULL COMMENT 'skill | mcp',
    item_ref    VARCHAR(200) NOT NULL COMMENT '技能: owner/repo/skill；MCP: 服务器名',
    slug        VARCHAR(96)  NOT NULL COMMENT '技能: skill_id；MCP: 同 item_ref',
    name        VARCHAR(128) NOT NULL,
    title       VARCHAR(128) NULL,
    description VARCHAR(512) NULL,
    installs    INT          NOT NULL DEFAULT 0,
    payload     LONGTEXT     NOT NULL,
    enabled     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  DATETIME(3)  NOT NULL,
    updated_at  DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_catalog_item_ref (kind, item_ref),
    KEY idx_catalog_item_list (kind, enabled, installs)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
