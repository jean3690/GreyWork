package com.jean.grey.market.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("market_version")
public class MarketVersion {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long packageId;

	private String version;

	private String downloadUrl;

	private String sha256;

	private String changelog;

	private String channel;

	private Integer rolloutPercent;

	private Long downloads;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
