-- 消息不再固化宿主张量：归属由 binding 决定，绑定迁移后历史消息自动跟着走
ALTER TABLE channel_message
    DROP INDEX idx_channel_message_host,
    DROP COLUMN host_device_id;
