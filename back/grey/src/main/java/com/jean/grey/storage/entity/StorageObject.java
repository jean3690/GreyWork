package com.jean.grey.storage.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 对象存储元数据：正文在 S3（RustFS）里，这里只记账、鉴权与配额。
 */
@Data
@TableName("storage_object")
public class StorageObject {

	@TableId(type = IdType.ASSIGN_ID)
	private Long id;

	private Long userId;

	private String bucket;

	private String objectKey;

	private String name;

	private String contentType;

	private Long sizeBytes;

	private String sha256;

	/** file / image / audio ... 目前只有 file，留给前端分类展示。 */
	private String kind;

	/** private / public；public 走 publicBaseUrl 直链。 */
	private String visibility;

	/** pending（上传未确认）→ ready → deleted（逻辑删除）。 */
	private String status;

	/** upload / automation_artifact ... 记录来源。 */
	private String source;

	@TableField(fill = FieldFill.INSERT)
	private LocalDateTime createdAt;

	@TableField(fill = FieldFill.INSERT_UPDATE)
	private LocalDateTime updatedAt;

	private LocalDateTime deletedAt;

}
