package com.jean.grey.automation;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.automation.entity.AutomationDue;
import com.jean.grey.automation.entity.AutomationRun;
import com.jean.grey.automation.entity.AutomationTask;
import com.jean.grey.automation.mapper.AutomationDueMapper;
import com.jean.grey.automation.mapper.AutomationRunMapper;
import com.jean.grey.config.AutomationProperties;
import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 调度循环：扫描到期任务入队、回收超时租约、派发云端执行、清理过期数据。
 * 单节点定时器批量推进，避免每个任务各挂一个定时器。
 */
@Component
public class AutomationScheduler {

	private static final Logger log = LoggerFactory.getLogger(AutomationScheduler.class);

	private final AutomationService automationService;
	private final AutomationDueMapper dueMapper;
	private final AutomationRunMapper runMapper;
	private final CloudAutomationRunner cloudRunner;
	private final AutomationProperties properties;
	private final ExecutorService cloudExecutor;

	public AutomationScheduler(AutomationService automationService,
			AutomationDueMapper dueMapper, AutomationRunMapper runMapper,
			CloudAutomationRunner cloudRunner, AutomationProperties properties) {
		this.automationService = automationService;
		this.dueMapper = dueMapper;
		this.runMapper = runMapper;
		this.cloudRunner = cloudRunner;
		this.properties = properties;
		this.cloudExecutor = Executors.newVirtualThreadPerTaskExecutor();
	}

	@Scheduled(fixedDelayString = "${grey.automation.tick-ms:30000}")
	public void tick() {
		LocalDateTime now = LocalDateTime.now(properties.scheduleZone());
		requeueStale(now);
		enqueueDueTasks(now);
		dispatchCloud(now);
		cleanRetention(now);
	}

	/** 宿主崩溃/云端进程重启留下的未完成投递，重置回 pending 等下一次认领。 */
	private void requeueStale(LocalDateTime now) {
		LocalDateTime leaseDeadline = now.minus(properties.claimLease());
		dueMapper.requeueExpiredLeases(leaseDeadline);
		dueMapper.requeueStaleRunning(leaseDeadline);
	}

	private void enqueueDueTasks(LocalDateTime now) {
		List<AutomationTask> tasks = automationService.dueTasks(now);
		for (AutomationTask task : tasks) {
			if (task.getNextRunAt() == null || task.getNextRunAt().isAfter(now)) {
				continue;
			}
			AutomationDue due = new AutomationDue();
			due.setUserId(task.getUserId());
			due.setTaskId(task.getId());
			due.setName(task.getName());
			due.setTarget(task.getTarget());
			due.setIntent(task.getIntent());
			due.setAcpProviderId(task.getAcpProviderId());
			due.setExecution(task.getExecution());
			due.setHostDeviceId(task.getHostDeviceId());
			due.setModel(task.getModel());
			due.setDueAt(task.getNextRunAt());
			due.setStatus("pending");
			try {
				dueMapper.insert(due);
			}
			catch (DuplicateKeyException ex) {
				// (user_id, task_id, due_at) 幂等：同一触发点只入队一次
				log.debug("due already enqueued: task={} at={}", task.getId(),
						task.getNextRunAt());
			}
			automationService.afterFire(task, now);
		}
	}

	/** 云端执行：占用并发额度后扔进虚拟线程，结果异步回写。 */
	private void dispatchCloud(LocalDateTime now) {
		long running = dueMapper.selectCount(Wrappers.<AutomationDue>lambdaQuery()
				.eq(AutomationDue::getExecution, "cloud")
				.eq(AutomationDue::getStatus, "running"));
		int slots = properties.cloudConcurrency() - (int) running;
		if (slots <= 0) {
			return;
		}
		List<AutomationDue> dues = dueMapper.selectList(Wrappers.<AutomationDue>lambdaQuery()
				.eq(AutomationDue::getExecution, "cloud")
				.eq(AutomationDue::getStatus, "pending")
				.le(AutomationDue::getDueAt, now)
				.orderByAsc(AutomationDue::getDueAt)
				.last("LIMIT " + slots));
		for (AutomationDue due : dues) {
			AutomationDue claim = new AutomationDue();
			claim.setId(due.getId());
			claim.setStatus("running");
			claim.setClaimedAt(now);
			if (dueMapper.update(claim, Wrappers.<AutomationDue>lambdaUpdate()
					.eq(AutomationDue::getId, due.getId())
					.eq(AutomationDue::getStatus, "pending")) == 0) {
				continue;
			}
			AutomationRun run = new AutomationRun();
			run.setUserId(due.getUserId());
			run.setTaskId(due.getTaskId());
			run.setName(due.getName());
			run.setMode("cloud");
			run.setStartedAt(now);
			runMapper.insert(run);
			AutomationDue link = new AutomationDue();
			link.setId(due.getId());
			link.setRunId(run.getId());
			dueMapper.updateById(link);
			cloudExecutor.submit(() -> executeCloud(due, run));
		}
	}

	private void executeCloud(AutomationDue due, AutomationRun run) {
		try {
			String output = cloudRunner.run(due.getUserId(), due.getTaskId(), due.getTarget(),
					due.getIntent(), due.getAcpProviderId(), due.getModel());
			finish(due, run, "ok", "云端执行完成", null, output);
		}
		catch (Exception ex) {
			log.warn("cloud automation failed: task={}", due.getTaskId(), ex);
			finish(due, run, "failed", ex.getMessage(), null, null);
		}
	}

	/**
	 * 宿主回执与云端收尾共用：投递关单 + 运行记录落库。
	 * 云端执行在派发时已预建 run 行（传带 id 的 run 走更新）；宿主执行在回执时才补建。
	 */
	public void finish(AutomationDue due, AutomationRun run, String status, String detail,
			String sessionId, String output) {
		LocalDateTime now = LocalDateTime.now(properties.scheduleZone());
			if (run.getId() == null) {
				run.setUserId(due.getUserId());
				run.setTaskId(due.getTaskId());
				run.setName(due.getName());
				run.setStatus(status);
				run.setMode("host");
				run.setStartedAt(due.getClaimedAt());
				run.setDetail(detail);
				run.setSessionId(sessionId);
				run.setOutput(output);
				run.setFinishedAt(now);
				runMapper.insert(run);
			AutomationDue link = new AutomationDue();
			link.setId(due.getId());
			link.setRunId(run.getId());
			dueMapper.updateById(link);
		}
		else {
			AutomationRun patch = new AutomationRun();
			patch.setId(run.getId());
			patch.setStatus(status);
			patch.setDetail(detail);
			patch.setSessionId(sessionId);
			patch.setOutput(output);
			patch.setFinishedAt(now);
			runMapper.updateById(patch);
		}

		AutomationDue close = new AutomationDue();
		close.setId(due.getId());
		close.setStatus(status);
		close.setFinishedAt(now);
		dueMapper.updateById(close);
	}

	private void cleanRetention(LocalDateTime now) {
		LocalDateTime cutoff = now.minusDays(properties.retentionDays());
		dueMapper.delete(Wrappers.<AutomationDue>lambdaQuery()
				.in(AutomationDue::getStatus, "done", "failed")
				.lt(AutomationDue::getFinishedAt, cutoff));
		runMapper.delete(Wrappers.<AutomationRun>lambdaQuery()
				.lt(AutomationRun::getFinishedAt, cutoff));
	}

}
