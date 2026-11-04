package com.jean.grey.automation.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.automation.entity.AutomationRun;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AutomationRunMapper extends BaseMapper<AutomationRun> {

	@Select("""
			SELECT * FROM automation_run
			WHERE user_id = #{userId}
			  AND (#{taskId} IS NULL OR task_id = #{taskId})
			ORDER BY id DESC
			LIMIT #{limit}
			""")
	List<AutomationRun> recent(@Param("userId") Long userId,
			@Param("taskId") String taskId, @Param("limit") int limit);

	/** 运维台：全平台 7 天执行与失败数（失败率是判断「自动化是否健康」的主指标）。 */
	@Select("""
			SELECT COUNT(*) AS total, COALESCE(SUM(status = 'failed'), 0) AS failed
			FROM automation_run
			WHERE created_at >= #{since}
			""")
	java.util.Map<String, Object> statsSince(@Param("since") LocalDateTime since);

}
