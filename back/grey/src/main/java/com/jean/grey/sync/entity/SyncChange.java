package com.jean.grey.sync.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("sync_change")
public class SyncChange {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long userId;

	private String kind;

	private String objectId;

	private Boolean deleted;

	private String payload;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
