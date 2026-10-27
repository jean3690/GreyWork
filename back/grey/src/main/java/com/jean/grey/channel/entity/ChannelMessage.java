package com.jean.grey.channel.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("channel_message")
public class ChannelMessage {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long userId;

	private Long bindingId;

	private String platform;

	private String externalId;

	private String payload;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime receivedAt;

}
