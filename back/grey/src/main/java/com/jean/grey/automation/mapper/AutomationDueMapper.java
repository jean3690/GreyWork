package com.jean.grey.automation.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.automation.entity.AutomationDue;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface AutomationDueMapper extends BaseMapper<AutomationDue> {

	/**
	 * 认领一条到期任务：pending → claimed。子查询 + 条件更新，天然防两个宿主抢同一条。
	 * host_device_id 为空的任务任何宿主都能认领，非空则只归指定宿主。
	 */
	@Update("""
			UPDATE automation_due
			SET status = 'claimed', claimed_by = #{hostDeviceId}, claimed_at = #{now}
			WHERE id = (
			    SELECT id FROM (
			        SELECT id FROM automation_due
			        WHERE user_id = #{userId}
			          AND execution = 'host'
			          AND status = 'pending'
			          AND due_at <= #{now}
			          AND (host_device_id IS NULL OR host_device_id = #{hostDeviceId})
			        ORDER BY due_at, id
			        LIMIT 1
			    ) t
			)
			""")
	int claimOne(@Param("userId") Long userId, @Param("hostDeviceId") Long hostDeviceId,
			@Param("now") LocalDateTime now);

	/** 租约超时未回执的认领，重置回 pending（防宿主崩溃把任务钉死）。 */
	@Update("""
			UPDATE automation_due
			SET status = 'pending', claimed_by = NULL, claimed_at = NULL
			WHERE status = 'claimed'
			  AND claimed_at < #{leaseDeadline}
			""")
	int requeueExpiredLeases(@Param("leaseDeadline") LocalDateTime leaseDeadline);

	/** 卡在 running 的云端执行（进程重启残留），同样重置回 pending。 */
	@Update("""
			UPDATE automation_due
			SET status = 'pending'
			WHERE status = 'running'
			  AND due_at < #{staleDeadline}
			""")
	int requeueStaleRunning(@Param("staleDeadline") LocalDateTime staleDeadline);

	@Select("""
			SELECT * FROM automation_due
			WHERE id = #{id} AND user_id = #{userId}
			""")
	AutomationDue findByUser(@Param("id") Long id, @Param("userId") Long userId);

	@Select("""
			SELECT * FROM automation_due
			WHERE user_id = #{userId} AND task_id = #{taskId}
			ORDER BY id DESC
			LIMIT #{limit}
			""")
	List<AutomationDue> recentForTask(@Param("userId") Long userId,
			@Param("taskId") String taskId, @Param("limit") int limit);

}
