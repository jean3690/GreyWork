package com.jean.grey.automation.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 到期队列的一次投递：调度器入队，宿主或云端执行器认领，完成后回写。
 */
@Data
@TableName("automation_due")
public class AutomationDue {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long userId;

	private String taskId;

	private String name;

	private String target;

	private String intent;

	private String acpProviderId;

	private String execution;

	private Long hostDeviceId;

	private String model;

	private LocalDateTime dueAt;

	/** pending / claimed / running / done / failed */
	private String status;

	private Long claimedBy;

	private LocalDateTime claimedAt;

	private LocalDateTime finishedAt;

	private Long runId;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
