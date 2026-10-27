package com.jean.grey.auth.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("user_device")
public class UserDevice {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long userId;

	private String name;

	private String platform;

	private String publicKey;

	private LocalDateTime lastSeenAt;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
