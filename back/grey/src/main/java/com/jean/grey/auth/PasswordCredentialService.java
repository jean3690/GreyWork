package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Emails;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 邮箱密码凭据：运维台管理员与普通用户共用的密码登录 + 开放注册。
 *
 * 密码是长期凭据，与一次性入场码、OIDC 并列的第三种登录方式；注册即登录，
 * 邮箱不存在就直接建号（开放注册，角色仍按 RolePolicy 名单定）。
 *
 * 密码只存 bcrypt：库被读走时拿不到明文；bcrypt 自带盐，不用另存 salt 列。
 */
@Service
public class PasswordCredentialService {

	private static final Logger log = LoggerFactory.getLogger(PasswordCredentialService.class);

	/** 与前端表单约束一致；bcrypt 只取前 72 字节，超长不再有意义。 */
	private static final int MIN_PASSWORD_LENGTH = 8;
	private static final int MAX_PASSWORD_LENGTH = 72;

	private final AppUserMapper appUserMapper;
	private final RolePolicy rolePolicy;
	private final AuthService authService;
	private final AuditService auditService;
	private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();
	private final SecureRandom random = new SecureRandom();
	private final String configuredPassword;

	public PasswordCredentialService(AppUserMapper appUserMapper, RolePolicy rolePolicy,
			AuthService authService, AuditService auditService,
			@Value("${grey.auth.admin-password:}") String configuredPassword) {
		this.appUserMapper = appUserMapper;
		this.rolePolicy = rolePolicy;
		this.authService = authService;
		this.auditService = auditService;
		this.configuredPassword = configuredPassword == null ? "" : configuredPassword.trim();
	}

	public record LoginResult(AuthService.Enrolled session) {
	}

	/**
	 * 运维台登录：只对 role=admin 的账号放行。
	 *
	 * 所有失败都回同一个 401 文案：不区分「邮箱不存在 / 不是管理员 / 没设密码 / 密码错」，
	 * 否则登录接口就成了账号枚举器。
	 */
	public AuthService.Enrolled loginAdmin(String email, String password) {
		AppUser user = findByEmail(Emails.normalize(email));
		if (user == null || !RolePolicy.isAdminRole(user.getRole())
				|| user.getPasswordHash() == null || user.getPasswordHash().isBlank()
				|| !encoder.matches(password == null ? "" : password, user.getPasswordHash())) {
			throw ApiException.unauthorized("admin_login_invalid", "邮箱或密码不正确");
		}
		authService.requireActive(user);
		// 设备名固定为「运维台」：会话列表里一眼能认出是管理端，不是用户自己的电脑。
		AuthService.Enrolled session = authService.issueSession(user.getId(), "运维台", "web");
		// 登录也记一笔：运维台是「谁在什么时候进来过」的第一手证据。
		auditService.record(user.getId(), AuditService.ACTION_ADMIN_LOGIN, AuditService.TARGET_USER,
				user.getId(), "device=" + session.device().getId());
		return session;
	}

	/**
	 * 普通用户密码登录：不区分角色，只要有密码且账号可用。
	 *
	 * 与 loginAdmin 同一个 401 文案口径；设备与平台来自请求（桌面端总是带默认值）。
	 */
	public AuthService.Enrolled loginUser(String email, String password, String deviceName, String platform) {
		AppUser user = findByEmail(Emails.normalize(email));
		if (user == null || user.getPasswordHash() == null || user.getPasswordHash().isBlank()
				|| !encoder.matches(password == null ? "" : password, user.getPasswordHash())) {
			throw ApiException.unauthorized("login_invalid", "邮箱或密码不正确");
		}
		authService.requireActive(user);
		return authService.issueSession(user.getId(), deviceName, platform);
	}

	/**
	 * 开放注册：邮箱不存在就建号并当场签发会话（注册即登录）。
	 *
	 * 已注册的邮箱回 409，把「换个密码再注册」挡在门外；密码强度只卡长度（8-72），
	 * 与 changePassword 同一口径。注册不记审计 —— 与入场码建号保持一致。
	 */
	@Transactional
	public AuthService.Enrolled register(String email, String password, String displayName,
			String deviceName, String platform) {
		String normalizedEmail = Emails.normalize(email);
		if (normalizedEmail == null) {
			throw ApiException.badRequest("email_invalid", "邮箱不能为空");
		}
		String next = password == null ? "" : password;
		if (next.length() < MIN_PASSWORD_LENGTH || next.length() > MAX_PASSWORD_LENGTH) {
			throw ApiException.badRequest("password_invalid",
					"密码长度需在 " + MIN_PASSWORD_LENGTH + "-" + MAX_PASSWORD_LENGTH + " 位之间");
		}
		if (findByEmail(normalizedEmail) != null) {
			throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "email_exists", "该邮箱已注册，请直接登录");
		}
		AppUser user = new AppUser();
		user.setEmail(normalizedEmail);
		user.setDisplayName(displayName == null || displayName.isBlank() ? normalizedEmail : displayName);
		user.setStatus("active");
		user.setRole(rolePolicy.roleFor(normalizedEmail));
		user.setPasswordHash(encoder.encode(next));
		appUserMapper.insert(user);
		return authService.issueSession(user.getId(), deviceName, platform);
	}

	/** 改密码：已设过密码的要先验旧密码；没设过（例如只走过入场码）允许直接设。 */
	@Transactional
	public void changePassword(Long userId, String currentPassword, String newPassword) {
		String next = newPassword == null ? "" : newPassword;
		if (next.length() < MIN_PASSWORD_LENGTH || next.length() > MAX_PASSWORD_LENGTH) {
			throw ApiException.badRequest("password_invalid",
					"新密码长度需在 " + MIN_PASSWORD_LENGTH + "-" + MAX_PASSWORD_LENGTH + " 位之间");
		}
		AppUser user = appUserMapper.selectById(userId);
		if (user == null) {
			throw ApiException.unauthorized("user_missing", "用户不存在");
		}
		if (user.getPasswordHash() != null && !user.getPasswordHash().isBlank()
				&& !encoder.matches(currentPassword == null ? "" : currentPassword, user.getPasswordHash())) {
			throw ApiException.badRequest("password_mismatch", "当前密码不正确");
		}
		user.setPasswordHash(encoder.encode(next));
		appUserMapper.updateById(user);
		auditService.record(userId, AuditService.ACTION_ADMIN_PASSWORD_CHANGE,
				AuditService.TARGET_USER, userId, "self");
	}

	/**
	 * 启动引导：为配置名单里的每个邮箱确保「有账号 + 是 admin + 有密码」。
	 *
	 * 这样刚部署完就有一个可登录的运维台账号，不必先用入场码换 token 再去设密码。
	 * 已有密码的账号**不覆盖**：改过密码就该在重启后继续生效；忘了密码时用入场码登录
	 * 再走「修改密码」，或清掉库里的 password_hash 让这里重新种一次。
	 */
	public void bootstrap() {
		for (String email : rolePolicy.adminEmails()) {
			AppUser user = findByEmail(email);
			if (user == null) {
				user = new AppUser();
				user.setEmail(email);
				user.setDisplayName(email);
				user.setStatus("active");
				user.setRole(RolePolicy.ADMIN);
				appUserMapper.insert(user);
			}
			if (user.getPasswordHash() != null && !user.getPasswordHash().isBlank()) {
				continue;
			}
			String password = configuredPassword.isBlank() ? randomPassword() : configuredPassword;
			if (password.length() > MAX_PASSWORD_LENGTH) {
				password = password.substring(0, MAX_PASSWORD_LENGTH);
			}
			user.setPasswordHash(encoder.encode(password));
			appUserMapper.updateById(user);
			if (configuredPassword.isBlank()) {
				// 只打印一次（下次启动已有 hash 就跳过）；提示语明确这是随机初始密码。
				log.warn("已为运维台账号 {} 生成初始密码：{}（请登录后立即修改；或设置 GREY_ADMIN_PASSWORD 固定）",
						email, password);
			}
			else {
				log.info("已用 GREY_ADMIN_PASSWORD 初始化运维台账号 {}", email);
			}
		}
	}

	/** 按邮箱找用户：与登录同口径，LOWER(email) 兼容历史大小写混杂行。 */
	private AppUser findByEmail(String normalizedEmail) {
		if (normalizedEmail == null) {
			return null;
		}
		return appUserMapper.selectOne(Wrappers.<AppUser>query()
				.apply("LOWER(email) = {0}", normalizedEmail.toLowerCase(Locale.ROOT)));
	}

	private String randomPassword() {
		byte[] raw = new byte[12];
		random.nextBytes(raw);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
	}

}
