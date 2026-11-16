package com.jean.grey.market.web;

import com.jean.grey.auth.AuditService;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.market.CatalogAdminService;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * 运维面 · 能力目录维护（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。
 *
 * 公开读取面在 {@link MarketController}：这里写进去的条目，桌面端下一秒就能搜到。
 */
@RestController
@RequestMapping("/api/admin/catalog")
public class AdminCatalogController {

	private final CatalogAdminService service;

	private final AuditService auditService;

	public AdminCatalogController(CatalogAdminService service, AuditService auditService) {
		this.service = service;
		this.auditService = auditService;
	}

	public record EnabledRequest(boolean enabled) {
	}

	@GetMapping
	public List<CatalogAdminService.ItemView> list(@RequestParam(name = "kind", defaultValue = "all") String kind) {
		return service.list(kind);
	}

	@GetMapping("/{id}")
	public CatalogAdminService.ItemDetail detail(@PathVariable long id) {
		return service.detail(id);
	}

	@PostMapping("/skill")
	@ResponseStatus(HttpStatus.CREATED)
	public CatalogAdminService.ItemView createSkill(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody CatalogAdminService.SkillInput input) {
		CatalogAdminService.ItemView created = service.createSkill(input);
		audit(principal, AuditService.ACTION_CATALOG_UPSERT, created, "create");
		return created;
	}

	@PutMapping("/skill/{id}")
	public CatalogAdminService.ItemView updateSkill(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long id, @RequestBody CatalogAdminService.SkillInput input) {
		CatalogAdminService.ItemView updated = service.updateSkill(id, input);
		audit(principal, AuditService.ACTION_CATALOG_UPSERT, updated, "update");
		return updated;
	}

	@PostMapping("/mcp")
	@ResponseStatus(HttpStatus.CREATED)
	public CatalogAdminService.ItemView createMcp(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody CatalogAdminService.McpInput input) {
		CatalogAdminService.ItemView created = service.createMcp(input);
		audit(principal, AuditService.ACTION_CATALOG_UPSERT, created, "create");
		return created;
	}

	@PutMapping("/mcp/{id}")
	public CatalogAdminService.ItemView updateMcp(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long id, @RequestBody CatalogAdminService.McpInput input) {
		CatalogAdminService.ItemView updated = service.updateMcp(id, input);
		audit(principal, AuditService.ACTION_CATALOG_UPSERT, updated, "update");
		return updated;
	}

	@PostMapping("/{id}/enabled")
	public CatalogAdminService.ItemView setEnabled(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long id, @RequestBody EnabledRequest request) {
		CatalogAdminService.ItemView updated = service.setEnabled(id, request.enabled());
		audit(principal, AuditService.ACTION_CATALOG_STATUS, updated, request.enabled() ? "enable" : "disable");
		return updated;
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void delete(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable long id) {
		service.delete(id);
		auditService.record(principal.userId(), AuditService.ACTION_CATALOG_DELETE,
				AuditService.TARGET_CATALOG, id, null);
	}

	private void audit(AuthPrincipal principal, String action, CatalogAdminService.ItemView item, String detail) {
		auditService.record(principal.userId(), action, AuditService.TARGET_CATALOG, Long.valueOf(item.id()),
				item.kind() + " " + item.ref() + " " + detail);
	}

}
