package com.jean.grey.automation;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.automation.entity.AutomationDue;
import com.jean.grey.automation.entity.AutomationRun;
import com.jean.grey.automation.entity.AutomationTask;
import com.jean.grey.automation.mapper.AutomationDueMapper;
import com.jean.grey.automation.mapper.AutomationRunMapper;
import com.jean.grey.automation.mapper.AutomationTaskMapper;
import com.jean.grey.common.ApiException;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 自动化任务真源：定义 CRUD、调度字段校验与 next_run_at 推进。
 * 控制面持有任务定义，宿主离线时任务照常入队，宿主回来后认领补跑。
 */
@Service
public class AutomationService {

	public static final String EXECUTION_HOST = "host";
	public static final String EXECUTION_CLOUD = "cloud";
	public static final Set<String> EXECUTIONS = Set.of(EXECUTION_HOST, EXECUTION_CLOUD);

	private static final SecureRandom RANDOM = new SecureRandom();

	private final AutomationTaskMapper taskMapper;
	private final AutomationDueMapper dueMapper;
	private final AutomationRunMapper runMapper;
	private final ZoneId zone;

	public AutomationService(AutomationTaskMapper taskMapper, AutomationDueMapper dueMapper,
			AutomationRunMapper runMapper, com.jean.grey.config.AutomationProperties properties) {
		this.taskMapper = taskMapper;
		this.dueMapper = dueMapper;
		this.runMapper = runMapper;
		this.zone = properties.scheduleZone();
	}

	public record TaskInput(String name, String schedule, String cronExpr, LocalDateTime onceAt,
			String acpProviderId, String target, String intent, String execution,
			Long hostDeviceId, String model, boolean enabled) {
	}

	public record TaskView(String id, String name, String schedule, String cronExpr,
			LocalDateTime onceAt, String acpProviderId, String target, String intent,
			String execution, Long hostDeviceId, String model, boolean enabled,
			LocalDateTime lastRunAt, LocalDateTime nextRunAt, LocalDateTime createdAt,
			LocalDateTime updatedAt) {

		static TaskView of(AutomationTask task) {
			return new TaskView(task.getId(), task.getName(), task.getSchedule(),
					task.getCronExpr(), task.getOnceAt(), task.getAcpProviderId(),
					task.getTarget(), task.getIntent(), task.getExecution(),
					task.getHostDeviceId(), task.getModel(), task.isEnabled(),
					task.getLastRunAt(), task.getNextRunAt(), task.getCreatedAt(),
					task.getUpdatedAt());
		}
	}

	public record DueView(Long id, String taskId, String name, String target, String intent,
			String acpProviderId, String model, LocalDateTime dueAt) {

		public static DueView of(AutomationDue due) {
			return new DueView(due.getId(), due.getTaskId(), due.getName(), due.getTarget(),
					due.getIntent(), due.getAcpProviderId(), due.getModel(), due.getDueAt());
		}
	}

	public record RunView(Long id, String taskId, String name, String status, String detail,
			String sessionId, String mode, String output, Long artifactObjectId,
			LocalDateTime startedAt, LocalDateTime finishedAt, LocalDateTime createdAt) {

		static RunView of(AutomationRun run) {
			return new RunView(run.getId(), run.getTaskId(), run.getName(), run.getStatus(),
					run.getDetail(), run.getSessionId(), run.getMode(), run.getOutput(),
					run.getArtifactObjectId(), run.getStartedAt(), run.getFinishedAt(),
					run.getCreatedAt());
		}
	}

	/** 未来 5 次触发预览，供编辑器实时反馈 cron 写没写对。 */
	public record PreviewItem(LocalDateTime fireAt) {
	}

	@Transactional
	public TaskView create(Long userId, TaskInput input) {
		AutomationTask task = new AutomationTask();
		task.setId(generateId());
		applyInput(task, input);
		task.setUserId(userId);
		if (taskMapper.selectCount(Wrappers.<AutomationTask>lambdaQuery()
				.eq(AutomationTask::getUserId, userId)
				.eq(AutomationTask::getId, task.getId())) > 0) {
			throw ApiException.badRequest("task_id_taken", "任务 id 已存在: " + task.getId());
		}
		task.setNextRunAt(computeNextRun(task, LocalDateTime.now(zone).minusSeconds(1)));
		taskMapper.insert(task);
		return TaskView.of(task);
	}

	@Transactional
	public TaskView update(Long userId, String taskId, TaskInput input) {
		AutomationTask task = requireOwned(userId, taskId);
		applyInput(task, input);
		task.setNextRunAt(computeNextRun(task, LocalDateTime.now(zone).minusSeconds(1)));
		taskMapper.updateById(task);
		return TaskView.of(task);
	}

	@Transactional
	public TaskView setEnabled(Long userId, String taskId, boolean enabled) {
		AutomationTask task = requireOwned(userId, taskId);
		task.setEnabled(enabled);
		task.setNextRunAt(enabled
				? computeNextRun(task, LocalDateTime.now(zone).minusSeconds(1))
				: null);
		taskMapper.updateById(task);
		return TaskView.of(task);
	}

	@Transactional
	public void delete(Long userId, String taskId) {
		requireOwned(userId, taskId);
		AutomationTask stub = new AutomationTask();
		stub.setId(taskId);
		taskMapper.deleteById(stub);
	}

	public List<TaskView> list(Long userId) {
		return taskMapper.selectList(Wrappers.<AutomationTask>lambdaQuery()
				.eq(AutomationTask::getUserId, userId)
				.orderByDesc(AutomationTask::getCreatedAt))
				.stream().map(TaskView::of).toList();
	}

	public List<RunView> runs(Long userId, String taskId, int limit) {
		return runMapper.recent(userId, taskId, Math.clamp(limit, 1, 100))
				.stream().map(RunView::of).toList();
	}

	public List<AutomationDue> dues(Long userId, String taskId, int limit) {
		return dueMapper.recentForTask(userId, taskId, Math.clamp(limit, 1, 100));
	}


	/** 解析当前输入的调度并给出未来触发点；enabled=false 时返回空列表。 */
	public List<PreviewItem> preview(TaskInput input) {
		if (!input.enabled()) {
			return List.of();
		}
		Cron5 cron = parseCron(input);
		if (cron == null) {
			LocalDateTime once = input.onceAt();
			return once == null ? List.of() : List.of(new PreviewItem(once));
		}
		LocalDateTime cursor = LocalDateTime.now(zone);
		List<PreviewItem> items = new ArrayList<>();
		for (int i = 0; i < 5; i++) {
			LocalDateTime next = cron.next(cursor, zone);
			if (next == null) {
				break;
			}
			items.add(new PreviewItem(next));
			cursor = next;
		}
		return items;
	}

	/** 供调度器使用：由任务定义算下一次触发；不触发返回 null。 */
	public LocalDateTime computeNextRun(AutomationTask task, LocalDateTime after) {
		if (!task.isEnabled()) {
			return null;
		}
		Cron5 cron = Cron5.parse(task.getCronExpr());
		if (cron != null) {
			return cron.next(after, zone);
		}
		LocalDateTime once = task.getOnceAt();
		return once != null && once.isAfter(after) ? once : null;
	}

	/** 一次性任务触发后停用；cron 任务推进游标。 */
	@Transactional
	public void afterFire(AutomationTask task, LocalDateTime firedAt) {
		LocalDateTime next = null;
		boolean disable = false;
		if (task.getOnceAt() != null && task.getCronExpr() == null) {
			// 一次性任务触发后停用
			disable = true;
		}
		else {
			next = computeNextRun(task, firedAt);
		}
		// nextRunAt 可能要清空：MP 默认策略忽略 null 字段，必须用 set 显式写 NULL
		taskMapper.update(null, Wrappers.<AutomationTask>lambdaUpdate()
				.eq(AutomationTask::getUserId, task.getUserId())
				.eq(AutomationTask::getId, task.getId())
				.set(AutomationTask::getLastRunAt, firedAt)
				.set(AutomationTask::getNextRunAt, next)
				.set(AutomationTask::isEnabled, !disable));
	}

	/** 调度扫描用的到期任务清单。 */
	public List<AutomationTask> dueTasks(LocalDateTime now) {
		return taskMapper.selectList(Wrappers.<AutomationTask>lambdaQuery()
				.eq(AutomationTask::isEnabled, true)
				.isNotNull(AutomationTask::getNextRunAt)
				.le(AutomationTask::getNextRunAt, now));
	}

	public AutomationTask requireOwned(Long userId, String taskId) {
		AutomationTask task = taskMapper.selectOne(Wrappers.<AutomationTask>lambdaQuery()
				.eq(AutomationTask::getUserId, userId)
				.eq(AutomationTask::getId, taskId));
		if (task == null) {
			throw new ApiException(HttpStatus.NOT_FOUND, "task_not_found", "任务不存在: " + taskId);
		}
		return task;
	}

	private void applyInput(AutomationTask task, TaskInput input) {
		if (input.intent() == null || input.intent().isBlank()) {
			throw ApiException.badRequest("intent_required", "intent 不能为空");
		}
		if (!EXECUTIONS.contains(input.execution())) {
			throw ApiException.badRequest("execution_invalid",
					"execution 只支持 host / cloud: " + input.execution());
		}
		if (EXECUTION_CLOUD.equals(input.execution())
				&& (input.model() == null || input.model().isBlank())) {
			throw ApiException.badRequest("model_required",
					"云端执行必须指定模型（走模型网关的供应商池）");
		}
		Cron5 cron = parseCron(input);
		LocalDateTime once = input.onceAt();
		if (cron == null && once == null) {
			throw ApiException.badRequest("schedule_required",
					"需要有效的 cronExpr 或 onceAt 之一");
		}
		task.setName(input.name() == null ? "" : input.name().trim());
		task.setSchedule(input.schedule() == null ? "" : input.schedule().trim());
		task.setCronExpr(cron == null ? null : cron.normalized());
		task.setOnceAt(once);
		task.setAcpProviderId(trimToNull(input.acpProviderId()));
		task.setTarget(input.target() == null ? "" : input.target().trim());
		task.setIntent(input.intent().trim());
		task.setExecution(input.execution());
		task.setHostDeviceId(input.hostDeviceId());
		task.setModel(trimToNull(input.model()));
		task.setEnabled(input.enabled());
	}

	private Cron5 parseCron(TaskInput input) {
		String expr = input.cronExpr();
		String source = expr == null || expr.isBlank() ? input.schedule() : expr;
		if (source == null || source.isBlank()) {
			return null;
		}
		// schedule 字段直接写 cron（@daily 等）也接受；仅在它长得像 5 段 cron 或宏时接管
		String trimmed = source.trim();
		if (trimmed.startsWith("@") || trimmed.split("\\s+").length == 5) {
			Cron5 cron = Cron5.parse(trimmed);
			if (cron == null) {
				throw ApiException.badRequest("cron_invalid", "无法解析的 cron 表达式: " + trimmed);
			}
			return cron;
		}
		return null;
	}

	private static String trimToNull(String value) {
		return value == null || value.isBlank() ? null : value.trim();
	}

	private static String generateId() {
		byte[] bytes = new byte[9];
		RANDOM.nextBytes(bytes);
		return "at-" + HexFormat.of().formatHex(bytes);
	}

}
