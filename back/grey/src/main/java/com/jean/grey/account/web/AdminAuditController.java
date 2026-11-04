package com.jean.grey.account.web;

import com.jean.grey.auth.AuditService;
import com.jean.grey.auth.entity.AuditLog;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 运维面 · 审计日志（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin/audit")
public class AdminAuditController {

	private final AuditService auditService;

	public AdminAuditController(AuditService auditService) {
		this.auditService = auditService;
	}

	/**
	 * 审计按时间倒序返回；可按 (targetType, targetId) 收敛到某个用户/设备的全部操作。
	 * 运维面只是「翻最近的操作」，全量导出另行处理，所以不做深分页。
	 */
	@GetMapping
	public List<AuditLog> list(@RequestParam(required = false) String targetType,
			@RequestParam(required = false) Long targetId,
			@RequestParam(required = false, defaultValue = "50") Integer limit,
			@RequestParam(required = false, defaultValue = "0") Long offset) {
		return auditService.list(targetType, targetId, limit, offset);
	}

}
