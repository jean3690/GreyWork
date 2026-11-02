package com.jean.grey.account.web;

import com.jean.grey.account.AccountAdminService;
import com.jean.grey.auth.AuthPrincipal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 运维面 · 用户管理（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin/users")
public class AdminUserController {

	private final AccountAdminService accountAdminService;

	public AdminUserController(AccountAdminService accountAdminService) {
		this.accountAdminService = accountAdminService;
	}

	public record UpdateStatusRequest(@NotBlank String status) {
	}

	@GetMapping
	public List<AccountAdminService.UserItem> list(@RequestParam(required = false) String query,
			@RequestParam(required = false) Integer limit) {
		return accountAdminService.list(query, limit);
	}

	@PatchMapping("/{id}")
	public AccountAdminService.UserItem updateStatus(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable Long id, @Valid @RequestBody UpdateStatusRequest request) {
		return accountAdminService.updateStatus(principal.userId(), id, request.status());
	}

	/** 踢下线：只清会话，账号保持可用。返回被清的设备数。 */
	@DeleteMapping("/{id}/sessions")
	public Map<String, Object> revokeSessions(@PathVariable Long id) {
		return Map.of("devices", accountAdminService.revokeSessions(id));
	}

}
