package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.common.ApiException;
import java.time.LocalDateTime;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

	private final AppUserMapper appUserMapper;
	private final UserDeviceMapper userDeviceMapper;
	private final TokenService tokenService;
	private final RolePolicy rolePolicy;
	private final int maxDevices;

	public AuthService(AppUserMapper appUserMapper,
			UserDeviceMapper userDeviceMapper, TokenService tokenService, RolePolicy rolePolicy,
			@Value("${grey.auth.max-devices:20}") int maxDevices) {
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.tokenService = tokenService;
		this.rolePolicy = rolePolicy;
		this.maxDevices = Math.max(1, maxDevices);
	}

	public record Enrolled(String token, AppUser user, UserDevice device) {
	}

	@Transactional
	public void updateDisplayName(Long userId, String displayName) {
		String name = displayName == null ? "" : displayName.strip();
		if (name.isBlank() || name.length() > 128) {
			throw ApiException.badRequest("display_name_invalid", "显示名称须为 1 至 128 个字符");
		}
		requireActive(appUserMapper.selectById(userId));
		// 只更新昵称，避免把并发的禁用或角色变更覆盖回去。
		appUserMapper.update(null, Wrappers.<AppUser>lambdaUpdate()
				.eq(AppUser::getId, userId).set(AppUser::getDisplayName, name));
	}

	/** 所有登录方式（密码 / OIDC）最终都走这里：建设备 + 发 token。 */
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
	 * 并且把「已删除」与「非 active」统一成 403（对已登录用户是明确拒绝）。
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
	 * 设备数上限：超出时淘汰**最久没出现**的设备（按注册时间，新的在后），并吊销其会话。
	 *
	 * 为什么要有：每次密码 / OIDC 登录都会插一行设备，没有上限时一台机器反复重装会攒出
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
