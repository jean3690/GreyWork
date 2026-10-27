package com.jean.grey.channel.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("channel_binding")
public class ChannelBinding {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long userId;

	private String platform;

	private String accountRef;

	private Long hostDeviceId;

	private String status;

	private String secretHash;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

}
