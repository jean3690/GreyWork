package com.jean.grey.account.web;

import com.jean.grey.account.AccountAdminService;
import com.jean.grey.account.AccountAdminService.DeviceItem;
import com.jean.grey.account.AccountAdminService.UserDetail;
import com.jean.grey.account.AccountAdminService.UserItem;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.common.ApiException;
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

	/** 一次最多改一个字段：status 或 role，二者都给时优先 role；都为空由方法体报错。 */
	public record UpdateUserRequest(String status, String role) {
	}

	@GetMapping
	public List<UserItem> list(@RequestParam(required = false) String query,
			@RequestParam(required = false) Integer limit) {
		return accountAdminService.list(query, limit);
	}

	@GetMapping("/{id}/devices")
	public List<DeviceItem> devices(@PathVariable Long id) {
		return accountAdminService.listDevices(id);
	}

	@GetMapping("/{id}/detail")
	public UserDetail detail(@PathVariable Long id) {
		return accountAdminService.detail(id);
	}

	@PatchMapping("/{id}")
	public UserItem update(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id,
			@RequestBody UpdateUserRequest request) {
		if (request.role() != null && !request.role().isBlank()) {
			return accountAdminService.changeRole(principal.userId(), id, request.role());
		}
		if (request.status() != null && !request.status().isBlank()) {
			return accountAdminService.updateStatus(principal.userId(), id, request.status());
		}
		throw ApiException.badRequest("nothing_to_update", "status 与 role 至少给一个");
	}

	/** 踢下线：只清会话，账号保持可用。返回被清的设备数。 */
	@DeleteMapping("/{id}/sessions")
	public Map<String, Object> revokeSessions(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable Long id) {
		return Map.of("devices", accountAdminService.revokeSessions(principal.userId(), id));
	}

	/** 吊销单台设备：归属校验在 service 层，这里只转发。 */
	@DeleteMapping("/{id}/devices/{deviceId}")
	public void revokeDevice(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id,
			@PathVariable Long deviceId) {
		accountAdminService.revokeDevice(principal.userId(), id, deviceId);
	}

}
