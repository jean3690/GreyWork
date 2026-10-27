package com.jean.grey.market.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("market_package")
public class MarketPackage {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long ownerUserId;

	private String slug;

	private String name;

	private String author;

	private String summary;

	private String description;

	private String category;

	private String tags;

	private String status;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

}
