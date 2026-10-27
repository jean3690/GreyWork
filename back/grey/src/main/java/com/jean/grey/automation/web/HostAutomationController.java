package com.jean.grey.automation.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.automation.AutomationService;
import com.jean.grey.automation.AutomationScheduler;
import com.jean.grey.automation.entity.AutomationDue;
import com.jean.grey.automation.entity.AutomationRun;
import com.jean.grey.automation.mapper.AutomationDueMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.host.HostService;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 宿主侧自动化接口：认领到期任务（带租约）、回执执行结果。
 * 与 /api/hosts/me/messages 同一套游标拉取哲学——控制面只落库排队，出站由宿主拉。
 */
@RestController
@RequestMapping("/api/hosts/me/automation")
public class HostAutomationController {

	private final AutomationService automationService;
	private final AutomationScheduler scheduler;
	private final AutomationDueMapper dueMapper;
	private final HostService hostService;

	public HostAutomationController(AutomationService automationService,
			AutomationScheduler scheduler, AutomationDueMapper dueMapper,
			HostService hostService) {
		this.automationService = automationService;
		this.scheduler = scheduler;
		this.dueMapper = dueMapper;
		this.hostService = hostService;
	}

	public record ClaimRequest(int limit) {
	}

	public record FinishRequest(String status, String detail, String sessionId, String output) {
	}

	/** 认领到期任务：每条都是条件更新，天然防两个宿主抢同一条。 */
	@PostMapping("/claim")
	public List<AutomationService.DueView> claim(
			@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody ClaimRequest request) {
		hostService.heartbeat(principal.userId(), principal.deviceId());
		int limit = Math.clamp(request.limit() <= 0 ? 10 : request.limit(), 1, 50);
		List<AutomationDue> claimed = new ArrayList<>();
		for (int i = 0; i < limit; i++) {
			if (dueMapper.claimOne(principal.userId(), principal.deviceId(),
					LocalDateTime.now()) == 0) {
				break;
			}
			// claimOne 只回影响行数，重新按 (userId, 最新认领) 取回详情
			AutomationDue due = lastClaimed(principal.userId(), principal.deviceId());
			if (due != null) {
				claimed.add(due);
			}
		}
		return claimed.stream().map(AutomationService.DueView::of).toList();
	}

	/** 回执：校验认领归属后写运行记录并关单。 */
	@PostMapping("/due/{dueId}/finish")
	public void finish(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long dueId, @RequestBody FinishRequest request) {
		AutomationDue due = dueMapper.findByUser(dueId, principal.userId());
		if (due == null) {
			throw new ApiException(HttpStatus.NOT_FOUND, "due_not_found", "投递不存在: " + dueId);
		}
		if (!"claimed".equals(due.getStatus())
				|| !principal.deviceId().equals(due.getClaimedBy())) {
			throw new ApiException(HttpStatus.CONFLICT, "due_not_claimed",
					"任务未被当前宿主认领（可能已超时被回收）");
		}
		boolean ok = "ok".equalsIgnoreCase(request.status());
		AutomationRun run = new AutomationRun();
		run.setId(due.getRunId());
		run.setUserId(principal.userId());
		run.setTaskId(due.getTaskId());
		run.setName(due.getName());
		run.setMode("host");
		scheduler.finish(due, run, ok ? "ok" : "failed",
				request.detail() == null ? "" : request.detail(),
				request.sessionId(), request.output());
	}

	private AutomationDue lastClaimed(Long userId, Long hostDeviceId) {
		List<AutomationDue> rows = dueMapper.selectList(
				new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<AutomationDue>()
						.eq(AutomationDue::getUserId, userId)
						.eq(AutomationDue::getClaimedBy, hostDeviceId)
						.eq(AutomationDue::getStatus, "claimed")
						.orderByDesc(AutomationDue::getClaimedAt)
						.last("LIMIT 1"));
		return rows.isEmpty() ? null : rows.getFirst();
	}

}
