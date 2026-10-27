package com.jean.grey.llm.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("llm_key")
public class LlmKey {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long userId;

	private String provider;

	private String label;

	private String baseUrl;

	private String secretCipher;

	private String status;

	private LocalDateTime lastUsedAt;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

}
