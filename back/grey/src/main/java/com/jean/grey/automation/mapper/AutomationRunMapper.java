package com.jean.grey.automation.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.automation.entity.AutomationRun;
import java.util.List;
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

}
