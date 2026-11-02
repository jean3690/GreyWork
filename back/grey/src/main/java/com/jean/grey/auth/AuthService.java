package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Emails;
import com.jean.grey.common.Hashes;
import java.time.LocalDateTime;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

	private final EnrollmentCodeMapper enrollmentCodeMapper;
	private final AppUserMapper appUserMapper;
	private final UserDeviceMapper userDeviceMapper;
	private final TokenService tokenService;

	public AuthService(EnrollmentCodeMapper enrollmentCodeMapper, AppUserMapper appUserMapper,
			UserDeviceMapper userDeviceMapper, TokenService tokenService) {
		this.enrollmentCodeMapper = enrollmentCodeMapper;
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.tokenService = tokenService;
	}

	public record Enrolled(String token, AppUser user, UserDevice device) {
	}

	@Transactional
	public Enrolled enroll(String rawCode, String email, String displayName, String deviceName,
			String platform) {
		String normalizedEmail = Emails.normalize(email);
		if (normalizedEmail == null) {
			throw ApiException.badRequest("email_invalid", "邮箱不能为空");
		}
		EnrollmentCode code = enrollmentCodeMapper.selectOne(Wrappers.<EnrollmentCode>lambdaQuery()
				.eq(EnrollmentCode::getCodeHash, Hashes.sha256Hex(rawCode)));
		if (code == null || code.getUsedAt() != null || code.getExpiresAt().isBefore(LocalDateTime.now())) {
			throw ApiException.unauthorized("enroll_code_invalid", "入场码无效或已过期");
		}
		int claimed = enrollmentCodeMapper.update(null, Wrappers.<EnrollmentCode>lambdaUpdate()
				.set(EnrollmentCode::getUsedAt, LocalDateTime.now())
				.eq(EnrollmentCode::getId, code.getId())
				.isNull(EnrollmentCode::getUsedAt));
		if (claimed != 1) {
			throw ApiException.unauthorized("enroll_code_used", "入场码已被使用");
		}

		AppUser user = findByEmail(normalizedEmail);
		if (user == null) {
			user = new AppUser();
			user.setEmail(normalizedEmail);
			user.setDisplayName(displayName == null || displayName.isBlank() ? normalizedEmail : displayName);
			user.setStatus("active");
			appUserMapper.insert(user);
		}
		else if (!normalizedEmail.equals(user.getEmail())) {
			// 历史行可能是大小写混杂的写法：顺手归一化，避免下次再建出第二个账号。
			user.setEmail(normalizedEmail);
			appUserMapper.updateById(user);
		}

		return issueSession(user.getId(), deviceName, platform);
	}

	/** 所有登录方式（入场码 / OIDC）最终都走这里：建设备 + 发 token。 */
	public Enrolled issueSession(Long userId, String deviceName, String platform) {
		AppUser user = appUserMapper.selectById(userId);
		requireActive(user);
		UserDevice device = new UserDevice();
		device.setUserId(userId);
		device.setName(deviceName);
		device.setPlatform(platform);
		userDeviceMapper.insert(device);
		return new Enrolled(tokenService.issue(userId, device.getId()), user, device);
	}

	/**
	 * 账号可用性：**所有登录方式与每个带 token 的请求**都以这里为准。
	 *
	 * 以前 status / deleted_at 只有字段没有读者，禁用账号等于没禁用 —— 这里补上，
	 * 并且把「已删除」与「非 active」统一成 403（对已登录用户是明确拒绝，对未登录者
	 * 也拿不到「这个邮箱存不存在」之外的信息，因为入场码已经证明了来源可信）。
	 */
	public void requireActive(AppUser user) {
		if (user == null) {
			throw ApiException.unauthorized("user_missing", "用户不存在");
		}
		if (user.getDeletedAt() != null || !"active".equalsIgnoreCase(user.getStatus())) {
			throw ApiException.forbidden("user_disabled", "账号已被禁用");
		}
	}

	/** 带 token 的请求用：true 表示账号仍可用（过滤链据此决定要不要认这枚 token）。 */
	public boolean isActive(Long userId) {
		AppUser user = appUserMapper.selectById(userId);
		return user != null && user.getDeletedAt() == null && "active".equalsIgnoreCase(user.getStatus());
	}

	/**
	 * 按邮箱找用户：用 LOWER(email) 比较而不是 eq(email)。
	 *
	 * 历史库里可能已有大小写混杂的行（归一化之前的写入），等值查询会让同一个人开出第二个
	 * 账号；这里用下界比较命中老行，再在 enroll 里把该行改写成归一化形式。
	 */
	private AppUser findByEmail(String normalizedEmail) {
		return appUserMapper.selectOne(Wrappers.<AppUser>query()
				.apply("LOWER(email) = {0}", normalizedEmail));
	}

	public void touch(Long deviceId) {
		if (!tokenService.claimLastSeenSlot(deviceId)) {
			return;
		}
		userDeviceMapper.update(null, Wrappers.<UserDevice>lambdaUpdate()
				.set(UserDevice::getLastSeenAt, LocalDateTime.now())
				.eq(UserDevice::getId, deviceId));
	}

}
