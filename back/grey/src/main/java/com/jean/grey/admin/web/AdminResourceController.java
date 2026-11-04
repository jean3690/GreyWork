package com.jean.grey.admin.web;

import com.jean.grey.admin.AdminResourceService;
import com.jean.grey.auth.AuthPrincipal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 运维面 · 跨用户资源视图（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin")
public class AdminResourceController {

	private final AdminResourceService resourceService;

	public AdminResourceController(AdminResourceService resourceService) {
		this.resourceService = resourceService;
	}

	public record ChannelStatusRequest(@NotBlank String status) {
	}

	@GetMapping("/hosts")
	public List<AdminResourceService.HostItem> hosts() {
		return resourceService.hosts();
	}

	@GetMapping("/channels")
	public List<AdminResourceService.ChannelItem> channels() {
		return resourceService.channels();
	}

	@PostMapping("/channels/{id}/status")
	public AdminResourceService.ChannelItem setChannelStatus(
			@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id,
			@Valid @RequestBody ChannelStatusRequest request) {
		return resourceService.setChannelStatus(principal.userId(), id, request.status());
	}

	@GetMapping("/llm/keys")
	public List<AdminResourceService.LlmKeyItem> llmKeys() {
		return resourceService.llmKeys();
	}

	@GetMapping("/llm/usage")
	public AdminResourceService.LlmUsageOverview llmUsage() {
		return resourceService.llmUsage();
	}

}
