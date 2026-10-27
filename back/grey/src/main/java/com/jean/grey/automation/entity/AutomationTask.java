package com.jean.grey.automation.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 任务定义（真源）。id 可由客户端生成（at-xxx），同一用户内唯一。
 */
@Data
@TableName("automation_task")
public class AutomationTask {

	@TableId(type = IdType.INPUT)
	private String id;

	private Long userId;

	private String name;

	/** 展示用调度描述；真正触发看 cronExpr / onceAt。 */
	private String schedule;

	private String cronExpr;

	private LocalDateTime onceAt;

	private String acpProviderId;

	private String target;

	private String intent;

	/** host = 交给宿主执行；cloud = 服务端 AI 直跑。 */
	private String execution;

	private Long hostDeviceId;

	private String model;

	private boolean enabled;

	private LocalDateTime lastRunAt;

	/** 调度器按这个字段扫到期任务。 */
	private LocalDateTime nextRunAt;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

	private LocalDateTime deletedAt;

}
