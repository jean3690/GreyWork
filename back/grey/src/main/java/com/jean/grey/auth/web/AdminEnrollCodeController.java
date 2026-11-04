package com.jean.grey.auth.web;

import com.jean.grey.auth.AuditService;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.auth.EnrollmentCodeAdminService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** 运维面 · 入场码管理（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin/enroll-codes")
public class AdminEnrollCodeController {

	private final EnrollmentCodeAdminService service;
	private final AuditService auditService;

	public AdminEnrollCodeController(EnrollmentCodeAdminService service, AuditService auditService) {
		this.service = service;
		this.auditService = auditService;
	}

	public record IssueRequest(@Min(1) @Max(720) Integer expiresInHours) {
	}

	@GetMapping
	public List<EnrollmentCodeAdminService.CodeItem> list() {
		return service.list();
	}

	/** 明文只在这份响应里出现一次，库里存的是 sha256。 */
	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	public EnrollmentCodeAdminService.IssuedCode issue(@AuthenticationPrincipal AuthPrincipal principal,
			@Valid @RequestBody(required = false) IssueRequest request) {
		EnrollmentCodeAdminService.IssuedCode issued = service
				.issue(request == null ? null : request.expiresInHours());
		auditService.record(principal.userId(), AuditService.ACTION_ENROLL_CODE_ISSUE,
				AuditService.TARGET_ENROLL_CODE, issued.item().id(),
				"expiresAt=" + issued.item().expiresAt());
		return issued;
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void revoke(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		service.revoke(id);
		auditService.record(principal.userId(), AuditService.ACTION_ENROLL_CODE_REVOKE,
				AuditService.TARGET_ENROLL_CODE, id, null);
	}

}
