package com.jean.grey.account.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("app_user")
public class AppUser {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private String email;

	private String displayName;

	private String status;

	/** user / admin：admin 才能进 /api/admin/**（见 SecurityConfig）。 */
	private String role;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

	@TableLogic
	private LocalDateTime deletedAt;

}
