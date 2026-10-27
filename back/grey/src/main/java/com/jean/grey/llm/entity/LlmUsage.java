package com.jean.grey.llm.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("llm_usage")
public class LlmUsage {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long userId;

	private Long keyId;

	private String provider;

	private String model;

	private Integer promptTokens;

	private Integer completionTokens;

	private Integer totalTokens;

	private String status;

	private Integer httpStatus;

	private Long latencyMs;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
