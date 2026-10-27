package com.jean.grey.channel.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.channel.entity.ChannelMessage;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface ChannelMessageMapper extends BaseMapper<ChannelMessage> {

	/** 按 binding 当前归属宿主取消息：绑定迁移后历史未读自动归新宿主。 */
	@Select("""
			SELECT m.id, m.user_id, m.binding_id, m.platform, m.external_id, m.payload, m.received_at
			FROM channel_message m
			JOIN channel_binding b ON b.id = m.binding_id
			WHERE b.user_id = #{userId}
			  AND b.host_device_id = #{hostDeviceId}
			  AND m.id > #{since}
			ORDER BY m.id
			LIMIT #{limit}
			""")
	List<ChannelMessage> pullForHost(@Param("userId") Long userId,
			@Param("hostDeviceId") Long hostDeviceId, @Param("since") long since,
			@Param("limit") int limit);

}
