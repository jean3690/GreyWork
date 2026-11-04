package com.jean.grey.storage.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.storage.entity.StorageObject;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface StorageObjectMapper extends BaseMapper<StorageObject> {

	/**
	 * 容量口径：只算 ready。pending 是「已签发票据但没确认上传」的空壳，size 多为 0 或占位值，
	 * 算进去会让容量数字随失败上传跳动。
	 */
	@Select("""
			SELECT COUNT(*) AS objects, COALESCE(SUM(size_bytes), 0) AS bytes
			FROM storage_object
			WHERE status = 'ready'
			""")
	Map<String, Object> readySummary();

	/** 按种类分容量：kind 由调用方给（image / file / artifact…），空值归到空串。 */
	@Select("""
			SELECT COALESCE(kind, '') AS kind, COUNT(*) AS objects,
			       COALESCE(SUM(size_bytes), 0) AS bytes
			FROM storage_object
			WHERE status = 'ready'
			GROUP BY kind
			ORDER BY bytes DESC
			""")
	List<Map<String, Object>> summaryByKind();

	/**
	 * 最近对象（跨用户）。列名刻意别名成 camelCase —— Map 结果的 key 就是列标签，
	 * 不经过下划线转驼峰的自动映射，别名不对就只能拿到 null。
	 */
	@Select("""
			SELECT o.id AS id, o.user_id AS userId, u.email AS ownerEmail, o.name AS name,
			       COALESCE(o.kind, '') AS kind, COALESCE(o.size_bytes, 0) AS sizeBytes,
			       o.visibility AS visibility, o.status AS status, o.created_at AS createdAt
			FROM storage_object o
			LEFT JOIN app_user u ON u.id = o.user_id
			ORDER BY o.id DESC
			LIMIT #{limit}
			""")
	List<Map<String, Object>> recent(@Param("limit") int limit);

}
