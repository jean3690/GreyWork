package com.jean.grey.automation.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.automation.entity.AutomationTask;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AutomationTaskMapper extends BaseMapper<AutomationTask> {

	/** 运维台口径：软删（deleted_at）的任务不算，否则「任务数」会只增不减。 */
	@Select("""
			SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled
			FROM automation_task
			WHERE deleted_at IS NULL
			""")
	Map<String, Object> summary();

	/** 最近变动的任务（跨用户），用于看「谁在跑什么」。 */
	@Select("""
			SELECT t.id AS id, t.user_id AS userId, u.email AS ownerEmail, t.name AS name,
			       t.execution AS execution, t.enabled AS enabled,
			       t.next_run_at AS nextRunAt, t.last_run_at AS lastRunAt
			FROM automation_task t
			LEFT JOIN app_user u ON u.id = t.user_id
			WHERE t.deleted_at IS NULL
			ORDER BY t.updated_at DESC
			LIMIT #{limit}
			""")
	List<Map<String, Object>> recent(@Param("limit") int limit);

}
