package com.jean.grey.auth;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 建号 + 种密码排在 AdminBootstrap（按名单提权）之后：先提权再种密码，
 * 每一步看到的都是对方改完的状态，避免两个 runner 的先后顺序影响结果。
 */
@Component
@Order(2)
public class AdminCredentialBootstrap implements ApplicationRunner {

	private final AdminCredentialService credentialService;

	public AdminCredentialBootstrap(AdminCredentialService credentialService) {
		this.credentialService = credentialService;
	}

	@Override
	public void run(ApplicationArguments args) {
		credentialService.bootstrap();
	}

}
