package com.jean.grey.admin.web;

import com.jean.grey.admin.AdminOverviewService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 运维台首页聚合（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin")
public class AdminOverviewController {

	private final AdminOverviewService overviewService;

	public AdminOverviewController(AdminOverviewService overviewService) {
		this.overviewService = overviewService;
	}

	@GetMapping("/overview")
	public AdminOverviewService.Overview overview() {
		return overviewService.overview();
	}

}
