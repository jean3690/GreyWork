package com.jean.grey.auth.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("enrollment_code")
public class EnrollmentCode {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private String codeHash;

	private LocalDateTime expiresAt;

	private LocalDateTime usedAt;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
