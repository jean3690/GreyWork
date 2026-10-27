package com.jean.grey.automation.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 运行记录：宿主执行与云端执行共用一张表。
 */
@Data
@TableName("automation_run")
public class AutomationRun {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long userId;

	private String taskId;

	private String name;

	/** ok / failed */
	private String status;

	private String detail;

	private String sessionId;

	/** host / cloud */
	private String mode;

	/** output 在部分 JSqlParser 版本是保留字，生成 SQL 需要反引号包列名。 */
	@TableField(value = "`output`")
	private String output;

	private Long artifactObjectId;

	private LocalDateTime startedAt;

	private LocalDateTime finishedAt;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
