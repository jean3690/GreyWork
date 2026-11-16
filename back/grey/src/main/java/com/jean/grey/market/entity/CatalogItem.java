package com.jean.grey.market.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/** 能力目录条目：技能（kind=skill）或 MCP 预设（kind=mcp）。正文在 payload(JSON)。 */
@Data
@TableName("catalog_item")
public class CatalogItem {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private String kind;

	/** item_ref：技能 = owner/repo/skill，MCP = 服务器名（唯一键是 kind + item_ref）。 */
	@TableField("item_ref")
	private String itemRef;

	/** 技能 = skill_id（落盘目录名），MCP = 同 item_ref。 */
	private String slug;

	private String name;

	private String title;

	private String description;

	private Integer installs;

	private String payload;

	private Boolean enabled;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

}
