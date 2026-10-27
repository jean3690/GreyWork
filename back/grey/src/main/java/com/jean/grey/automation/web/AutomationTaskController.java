package com.jean.grey.automation.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.automation.AutomationService;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 任务定义 CRUD，面向渲染端/客户端。任务 id 允许客户端自带（at-xxx），缺省服务端生成。
 */
@RestController
@RequestMapping("/api/automation/tasks")
public class AutomationTaskController {

	private final AutomationService automationService;

	public AutomationTaskController(AutomationService automationService) {
		this.automationService = automationService;
	}

	public record PreviewRequest(AutomationService.TaskInput task) {
	}

	@GetMapping
	public List<AutomationService.TaskView> list(
			@AuthenticationPrincipal AuthPrincipal principal) {
		return automationService.list(principal.userId());
	}

	@PostMapping
	public AutomationService.TaskView create(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody AutomationService.TaskInput input) {
		return automationService.create(principal.userId(), input);
	}

	@PutMapping("/{taskId}")
	public AutomationService.TaskView update(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String taskId,
			@RequestBody AutomationService.TaskInput input) {
		return automationService.update(principal.userId(), taskId, input);
	}

	@PostMapping("/{taskId}/enable")
	public AutomationService.TaskView enable(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String taskId) {
		return automationService.setEnabled(principal.userId(), taskId, true);
	}

	@PostMapping("/{taskId}/disable")
	public AutomationService.TaskView disable(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String taskId) {
		return automationService.setEnabled(principal.userId(), taskId, false);
	}

	@DeleteMapping("/{taskId}")
	public void delete(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String taskId) {
		automationService.delete(principal.userId(), taskId);
	}

	/** 运行记录（可按任务过滤）。 */
	@GetMapping("/runs")
	public List<AutomationService.RunView> runs(
			@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(required = false) String taskId,
			@RequestParam(defaultValue = "20") int limit) {
		return automationService.runs(principal.userId(), taskId, limit);
	}

	/** 调度预览：给定任务输入，返回未来触发点，不落库。 */
	@PostMapping("/preview")
	public List<AutomationService.PreviewItem> preview(
			@RequestBody PreviewRequest request) {
		return automationService.preview(request.task());
	}

}
