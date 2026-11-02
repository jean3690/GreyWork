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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

	private final EnrollmentCodeMapper enrollmentCodeMapper;
	private final AppUserMapper appUserMapper;
	private final UserDeviceMapper userDeviceMapper;
	private final TokenService tokenService;
	private final RolePolicy rolePolicy;
	private final int maxDevices;

	public AuthService(EnrollmentCodeMapper enrollmentCodeMapper, AppUserMapper appUserMapper,
			UserDeviceMapper userDeviceMapper, TokenService tokenService, RolePolicy rolePolicy,
			@Value("${grey.auth.max-devices:20}") int maxDevices) {
		this.enrollmentCodeMapper = enrollmentCodeMapper;
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.tokenService = tokenService;
		this.rolePolicy = rolePolicy;
		this.maxDevices = Math.max(1, maxDevices);
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
			user.setRole(rolePolicy.roleFor(normalizedEmail));
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
		syncRole(user);
		UserDevice device = new UserDevice();
		device.setUserId(userId);
		device.setName(deviceName);
		device.setPlatform(platform);
		userDeviceMapper.insert(device);
		pruneDevices(userId, device.getId());
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

	/**
	 * 带 token 的请求用：可用则返回当前用户（过滤链据此决定认不认这枚 token、给什么角色），
	 * 被禁用 / 已删除返回 null。
	 */
	public AppUser loadActive(Long userId) {
		AppUser user = appUserMapper.selectById(userId);
		if (user == null || user.getDeletedAt() != null
				|| !"active".equalsIgnoreCase(user.getStatus())) {
			return null;
		}
		return user;
	}

	/** 配置名单变了就以名单为准补齐角色（只提不降，理由见 AdminBootstrap）。 */
	private void syncRole(AppUser user) {
		String expected = rolePolicy.roleFor(user.getEmail());
		if (!RolePolicy.ADMIN.equals(expected) || RolePolicy.ADMIN.equals(user.getRole())) {
			return;
		}
		user.setRole(RolePolicy.ADMIN);
		appUserMapper.updateById(user);
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

	/**
	 * 设备数上限：超出时淘汰**最久没出现**的设备（按注册时间，新的在后），并吊销其会话。
	 *
	 * 为什么要有：每次入场码 / OIDC 登录都会插一行设备，没有上限时一台机器反复重装会攒出
	 * 几十行垃圾，运维面的设备列表也就失去意义。淘汰最老的而保留刚登记的，符合「这台还在用」。
	 */
	private void pruneDevices(Long userId, Long keepDeviceId) {
		var devices = userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
				.eq(UserDevice::getUserId, userId)
				.orderByDesc(UserDevice::getCreatedAt));
		if (devices.size() <= maxDevices) {
			return;
		}
		var stale = devices.subList(maxDevices, devices.size()).stream()
				.map(UserDevice::getId)
				.filter(id -> !id.equals(keepDeviceId))
				.toList();
		if (stale.isEmpty()) {
			return;
		}
		stale.forEach(userDeviceMapper::deleteById);
		tokenService.revokeDevices(stale);
	}

	/** 设备心跳：5 分钟节流；返回 true 表示这次真的写了库（调用方据此顺带续期会话）。 */
	public boolean touch(Long deviceId) {
		if (!tokenService.claimLastSeenSlot(deviceId)) {
			return false;
		}
		userDeviceMapper.update(null, Wrappers.<UserDevice>lambdaUpdate()
				.set(UserDevice::getLastSeenAt, LocalDateTime.now())
				.eq(UserDevice::getId, deviceId));
		return true;
	}

	/**
	 * 退出设备：只撤会话、保留设备行（设备本身还在，下次登录复用同一台的身份）。
	 *
	 * @param keepDeviceId 保留哪台设备（通常是当前设备）；null 表示全撤
	 * @return 被撤会话的设备数
	 */
	public int revokeSessions(Long userId, Long keepDeviceId) {
		var devices = userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
				.eq(UserDevice::getUserId, userId))
				.stream()
				.map(UserDevice::getId)
				.filter(id -> !id.equals(keepDeviceId))
				.toList();
		tokenService.revokeDevices(devices);
		return devices.size();
	}

}
