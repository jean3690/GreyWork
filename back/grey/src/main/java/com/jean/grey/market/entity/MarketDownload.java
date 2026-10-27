package com.jean.grey.market.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("market_download")
public class MarketDownload {

	@TableId(type = IdType.AUTO)
	private Long id;

	private Long packageId;

	private Long versionId;

	private String slug;

	private String version;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

}
