package com.jean.grey.auth.web;

import com.jean.grey.auth.AdminCredentialService;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.auth.AuthRateLimiter;
import com.jean.grey.auth.AuthService;
import com.jean.grey.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * 运维台登录（账号密码）。
 *
 * 与 /api/auth/enroll 的区别：入场码是**一次性**的，适合发给人；密码是长期凭据，
 * 只给 admin 账号，适合部署者自己反复登录运维台。两者最终都走 AuthService.issueSession，
 * 拿到的是同一种 token，门禁（ROLE_ADMIN）没有第二条路径。
 *
 * /api/admin/auth/login 在 SecurityConfig 里单独 permitAll（必须排在 /api/admin/** 之前），
 * 其余 /api/admin/auth/** 仍要 admin。
 */
@RestController
@RequestMapping("/api/admin/auth")
public class AdminAuthController {

	private final AdminCredentialService credentialService;
	private final AuthRateLimiter rateLimiter;

	public AdminAuthController(AdminCredentialService credentialService, AuthRateLimiter rateLimiter) {
		this.credentialService = credentialService;
		this.rateLimiter = rateLimiter;
	}

	public record LoginRequest(@NotBlank @Email String email, @NotBlank String password) {
	}

	public record ChangePasswordRequest(String currentPassword,
			@NotBlank @Size(min = 8, max = 72) String newPassword) {
	}

	public record UserView(Long id, String email, String displayName, String role) {
	}

	public record DeviceView(Long id, String name, String platform) {
	}

	public record SessionView(String token, UserView user, DeviceView device) {
	}

	@PostMapping("/login")
	@ResponseStatus(HttpStatus.CREATED)
	public SessionView login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
		String client = http.getRemoteAddr();
		rateLimiter.assertAllowed(AuthRateLimiter.SCOPE_ADMIN, client);
		try {
			AuthService.Enrolled enrolled = credentialService.login(request.email(), request.password());
			rateLimiter.clear(AuthRateLimiter.SCOPE_ADMIN, client);
			return new SessionView(enrolled.token(),
					new UserView(enrolled.user().getId(), enrolled.user().getEmail(),
							enrolled.user().getDisplayName(), enrolled.user().getRole()),
					new DeviceView(enrolled.device().getId(), enrolled.device().getName(),
							enrolled.device().getPlatform()));
		}
		catch (ApiException ex) {
			// 只对「凭据不对」计数：账号被禁用是明确拒绝，不该把来源地址越锁越死。
			if (ex.getStatus() == HttpStatus.UNAUTHORIZED) {
				rateLimiter.recordFailure(AuthRateLimiter.SCOPE_ADMIN, client);
			}
			throw ex;
		}
	}

	@PostMapping("/password")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void changePassword(@AuthenticationPrincipal AuthPrincipal principal,
			@Valid @RequestBody ChangePasswordRequest request) {
		credentialService.changePassword(principal.userId(), request.currentPassword(),
				request.newPassword());
	}

}
