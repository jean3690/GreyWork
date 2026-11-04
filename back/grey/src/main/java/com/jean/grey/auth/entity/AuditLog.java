package com.jean.grey.auth.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/** 运维操作审计：只追加、不更新、不软删（参见 V10 迁移说明）。createdAt 由 AuditFieldFillHandler 在插入时填。 */
@Data
@TableName("audit_log")
public class AuditLog {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long actorId;

	private String actorEmail;

	private String action;

	private String targetType;

	private Long targetId;

	private String detail;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
