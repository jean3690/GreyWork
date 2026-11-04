package com.jean.grey.admin.web;

import com.jean.grey.admin.AdminPlatformService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 运维面 · 平台侧只读视图：对象存储与自动化任务（/api/admin/** 由 SecurityConfig 限 ROLE_ADMIN）。 */
@RestController
@RequestMapping("/api/admin")
public class AdminPlatformController {

	private final AdminPlatformService platformService;

	public AdminPlatformController(AdminPlatformService platformService) {
		this.platformService = platformService;
	}

	@GetMapping("/storage")
	public AdminPlatformService.StorageOverview storage() {
		return platformService.storage();
	}

	@GetMapping("/automation")
	public AdminPlatformService.AutomationOverview automation() {
		return platformService.automation();
	}

}
