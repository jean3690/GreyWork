package com.jean.grey.sync.mapper;

import com.jean.grey.sync.entity.SyncObject;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface SyncObjectMapper {

	@Select("""
			SELECT user_id, kind, object_id, revision, deleted, payload, updated_at
			FROM sync_object
			WHERE user_id = #{userId} AND kind = #{kind} AND object_id = #{objectId}
			""")
	SyncObject find(@Param("userId") Long userId, @Param("kind") String kind,
			@Param("objectId") String objectId);

	@Insert("""
			INSERT INTO sync_object (user_id, kind, object_id, revision, deleted, payload, updated_at)
			VALUES (#{userId}, #{kind}, #{objectId}, #{revision}, #{deleted}, #{payload}, #{updatedAt})
			""")
	int insert(SyncObject object);

	@Update("""
			UPDATE sync_object
			SET revision = #{revision}, deleted = #{deleted}, payload = #{payload}, updated_at = #{updatedAt}
			WHERE user_id = #{userId} AND kind = #{kind} AND object_id = #{objectId}
			""")
	int update(SyncObject object);

}
