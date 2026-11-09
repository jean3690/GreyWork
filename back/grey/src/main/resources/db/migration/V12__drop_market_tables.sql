-- 插件市场已下线：清掉 V6 建的三张表（包 → 版本 → 下载事件）。
-- V6 本身不能改（Flyway 已应用的迁移按 checksum 校验，改了就启动失败），
-- 所以这里用一条新迁移做一次性清理；新装环境会先建后删，同样收在这一步。
-- 顺序：先删引用方的两张子表，再删主表（V6 未建外键，顺序只是习惯上更稳妥）。
DROP TABLE IF EXISTS market_download;
DROP TABLE IF EXISTS market_version;
DROP TABLE IF EXISTS market_package;
