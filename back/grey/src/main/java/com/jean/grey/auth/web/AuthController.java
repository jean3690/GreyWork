package com.jean.grey.auth.web;

import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.auth.AuthService;
import com.jean.grey.auth.AuthRateLimiter;
import com.jean.grey.auth.BearerTokenFilter;
import com.jean.grey.auth.PasswordCredentialService;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.auth.TokenService;
import com.jean.grey.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;import tools.jackson.databind.annotation.JsonSerialize;
import tools.jackson.databind.ser.std.ToStringSerializer;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

	private final AuthService authService;
	private final TokenService tokenService;
	private final UserDeviceMapper userDeviceMapper;
	private final AppUserMapper appUserMapper;
	private final PasswordCredentialService credentialService;
	private final AuthRateLimiter rateLimiter;

	public AuthController(AuthService authService, TokenService tokenService,
			UserDeviceMapper userDeviceMapper, AppUserMapper appUserMapper,
			PasswordCredentialService credentialService, AuthRateLimiter rateLimiter) {
		this.authService = authService;
		this.tokenService = tokenService;
		this.userDeviceMapper = userDeviceMapper;
		this.appUserMapper = appUserMapper;
		this.credentialService = credentialService;
		this.rateLimiter = rateLimiter;
	}

	public record EnrollRequest(
			@NotBlank String code,
			@NotBlank @Email String email,
			@Size(max = 128) String displayName,
			@NotBlank @Size(max = 128) String deviceName,
			@NotBlank @Size(max = 32) String platform) {
	}

	/** 登录密码不在 DTO 上卡长度：错误密码要回 401 的统一文案，而不是 400 的长度提示。 */
	public record LoginRequest(
			@NotBlank @Email String email,
			@NotBlank String password,
			@NotBlank @Size(max = 128) String deviceName,
			@NotBlank @Size(max = 32) String platform) {
	}

	public record RegisterRequest(
			@NotBlank @Email String email,
			@NotBlank String password,
			@Size(max = 128) String displayName,
			@NotBlank @Size(max = 128) String deviceName,
			@NotBlank @Size(max = 32) String platform) {
	}

	public record UserView(@JsonSerialize(using = ToStringSerializer.class) Long id, String email,
			String displayName, String role) {
	}

	public record DeviceView(@JsonSerialize(using = ToStringSerializer.class) Long id, String name, String platform) {
	}

	public record ProfileRequest(@NotBlank @Size(max = 128) String displayName) {
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

	/**
	 * 邮箱密码登录：普通用户的常规入口（管理员走 /api/admin/auth/login，口径相同）。
	 * 失败按独立作用域限流，不与入场码互相牵连。
	 */
	@PostMapping("/login")
	public SessionView login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
		String client = http.getRemoteAddr();
		rateLimiter.assertAllowed(AuthRateLimiter.SCOPE_LOGIN, client);
		try {
			AuthService.Enrolled enrolled = credentialService.loginUser(request.email(), request.password(),
					request.deviceName(), request.platform());
			rateLimiter.clear(AuthRateLimiter.SCOPE_LOGIN, client);
			return new SessionView(enrolled.token(), userView(enrolled.user()), deviceView(enrolled.device()));
		}
		catch (ApiException ex) {
			if (ex.getStatus() == HttpStatus.UNAUTHORIZED) {
				rateLimiter.recordFailure(AuthRateLimiter.SCOPE_LOGIN, client);
			}
			throw ex;
		}
	}

	/**
	 * 开放注册：邮箱 + 密码直接建号并当场登录（注册即登录，与入场码同一种会话）。
	 * 注册不设限流 —— 它没有可猜的凭据，失败只有参数错误与邮箱冲突两种。
	 */
	@PostMapping("/register")
	@ResponseStatus(HttpStatus.CREATED)
	public SessionView register(@Valid @RequestBody RegisterRequest request) {
		AuthService.Enrolled enrolled = credentialService.register(request.email(), request.password(),
				request.displayName(), request.deviceName(), request.platform());
		return new SessionView(enrolled.token(), userView(enrolled.user()), deviceView(enrolled.device()));
	}

	@PostMapping("/logout")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void logout(HttpServletRequest request) {
		Object token = request.getAttribute(BearerTokenFilter.ATTR_TOKEN);
		if (token instanceof String value) {
			tokenService.revoke(value);
		}
	}

	/**
	 * 退出其他设备（默认保留当前设备）。给用户的「我换了手机 / 丢了平板」一个自助入口，
	 * 不用去找管理员踢下线；includeCurrent=true 就是全撤，当前设备随后会拿到 401。
	 */
	@DeleteMapping("/sessions")
	public Map<String, Object> revokeSessions(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(defaultValue = "false") boolean includeCurrent) {
		int devices = authService.revokeSessions(principal.userId(),
				includeCurrent ? null : principal.deviceId());
		return Map.of("devices", devices, "currentRevoked", includeCurrent);
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

	/** 只允许修改自己的昵称，邮箱和角色不由客户端写入。 */
	@PatchMapping("/me")
	public MeView updateProfile(@AuthenticationPrincipal AuthPrincipal principal,
			@Valid @RequestBody ProfileRequest request) {
		authService.updateDisplayName(principal.userId(), request.displayName());
		return me(principal);
	}

	private static UserView userView(AppUser user) {
		return new UserView(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole());
	}

	private static DeviceView deviceView(UserDevice device) {
		return new DeviceView(device.getId(), device.getName(), device.getPlatform());
	}

}
