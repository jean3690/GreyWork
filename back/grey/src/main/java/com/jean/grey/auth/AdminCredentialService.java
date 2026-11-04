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
 * 运维台账号密码：管理员除入场码 / OIDC 外的第三种登录方式。
 *
 * 只对 role=admin 的账号开放 —— 密码是长期凭据，普通用户仍走一次性入场码，
 * 不给整个控制面再开一个「长期口令可猜」的入口。
 *
 * 密码只存 bcrypt：库被读走时拿不到明文；bcrypt 自带盐，不用另存 salt 列。
 */
@Service
public class AdminCredentialService {

	private static final Logger log = LoggerFactory.getLogger(AdminCredentialService.class);

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

	public AdminCredentialService(AppUserMapper appUserMapper, RolePolicy rolePolicy,
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
	 * 校验密码并签发会话。
	 *
	 * 所有失败都回同一个 401 文案：不区分「邮箱不存在 / 不是管理员 / 没设密码 / 密码错」，
	 * 否则登录接口就成了账号枚举器。
	 */
	public AuthService.Enrolled login(String email, String password) {
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
