package com.jean.grey.auth.web;

import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.auth.AuthService;
import com.jean.grey.auth.AuthRateLimiter;
import com.jean.grey.auth.BearerTokenFilter;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.auth.TokenService;
import com.jean.grey.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

	private final AuthService authService;
	private final TokenService tokenService;
	private final UserDeviceMapper userDeviceMapper;
	private final AppUserMapper appUserMapper;
	private final AuthRateLimiter rateLimiter;

	public AuthController(AuthService authService, TokenService tokenService,
			UserDeviceMapper userDeviceMapper, AppUserMapper appUserMapper,
			AuthRateLimiter rateLimiter) {
		this.authService = authService;
		this.tokenService = tokenService;
		this.userDeviceMapper = userDeviceMapper;
		this.appUserMapper = appUserMapper;
		this.rateLimiter = rateLimiter;
	}

	public record EnrollRequest(
			@NotBlank String code,
			@NotBlank @Email String email,
			@Size(max = 128) String displayName,
			@NotBlank @Size(max = 128) String deviceName,
			@NotBlank @Size(max = 32) String platform) {
	}

	public record UserView(Long id, String email, String displayName) {
	}

	public record DeviceView(Long id, String name, String platform) {
	}

	public record SessionView(String token, UserView user, DeviceView device) {
	}

	public record MeView(UserView user, DeviceView device) {
	}

	@PostMapping("/enroll")
	@ResponseStatus(HttpStatus.CREATED)
	public SessionView enroll(@Valid @RequestBody EnrollRequest request, HttpServletRequest http) {
		// 入场码是唯一能在未登录态被猜的凭据：连续失败到阈值就先拦住这个来源，
		// 免得接口变成「猜码 + 顺带建号」的入口。成功一次即清零。
		String client = http.getRemoteAddr();
		rateLimiter.assertAllowed(client);
		try {
			AuthService.Enrolled enrolled = authService.enroll(request.code(), request.email(),
					request.displayName(), request.deviceName(), request.platform());
			rateLimiter.clear(client);
			return new SessionView(enrolled.token(), userView(enrolled.user()), deviceView(enrolled.device()));
		}
		catch (ApiException ex) {
			if (ex.getStatus() == HttpStatus.UNAUTHORIZED) {
				rateLimiter.recordFailure(client);
			}
			throw ex;
		}
	}

	@PostMapping("/logout")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void logout(HttpServletRequest request) {
		Object token = request.getAttribute(BearerTokenFilter.ATTR_TOKEN);
		if (token instanceof String value) {
			tokenService.revoke(value);
		}
	}

	@GetMapping("/me")
	public MeView me(@AuthenticationPrincipal AuthPrincipal principal) {
		AppUser user = appUserMapper.selectById(principal.userId());
		UserDevice device = userDeviceMapper.selectById(principal.deviceId());
		if (user == null || device == null || !principal.userId().equals(device.getUserId())) {
			throw ApiException.unauthorized("session_stale", "登录态已失效");
		}
		return new MeView(userView(user), deviceView(device));
	}

	private static UserView userView(AppUser user) {
		return new UserView(user.getId(), user.getEmail(), user.getDisplayName());
	}

	private static DeviceView deviceView(UserDevice device) {
		return new DeviceView(device.getId(), device.getName(), device.getPlatform());
	}

}
