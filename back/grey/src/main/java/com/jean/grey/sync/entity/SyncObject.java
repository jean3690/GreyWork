package com.jean.grey.sync.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 同步对象的当前状态，主键是 (user_id, kind, object_id)，不适合用 BaseMapper。 */
@Data
public class SyncObject {

	private Long userId;

	private String kind;

	private String objectId;

	private Long revision;

	private Boolean deleted;

	private String payload;

	private LocalDateTime updatedAt;

}
