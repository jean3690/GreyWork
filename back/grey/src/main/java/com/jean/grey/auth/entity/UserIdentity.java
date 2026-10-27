package com.jean.grey.auth.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("user_identity")
public class UserIdentity {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long userId;

	private String provider;

	private String subject;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
