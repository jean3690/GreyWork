package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.common.ApiException;
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

		AppUser user = appUserMapper.selectOne(Wrappers.<AppUser>lambdaQuery()
				.eq(AppUser::getEmail, email));
		if (user == null) {
			user = new AppUser();
			user.setEmail(email);
			user.setDisplayName(displayName == null || displayName.isBlank() ? email : displayName);
			user.setStatus("active");
			appUserMapper.insert(user);
		}

		return issueSession(user.getId(), deviceName, platform);
	}

	/** 所有登录方式（入场码 / OIDC）最终都走这里：建设备 + 发 token。 */
	public Enrolled issueSession(Long userId, String deviceName, String platform) {
		AppUser user = appUserMapper.selectById(userId);
		if (user == null) {
			throw ApiException.unauthorized("user_missing", "用户不存在");
		}
		UserDevice device = new UserDevice();
		device.setUserId(userId);
		device.setName(deviceName);
		device.setPlatform(platform);
		userDeviceMapper.insert(device);
		return new Enrolled(tokenService.issue(userId, device.getId()), user, device);
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
