package com.jean.grey.account;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.AuditService;
import com.jean.grey.auth.RolePolicy;
import com.jean.grey.auth.TokenService;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.entity.UserIdentity;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.auth.mapper.UserIdentityMapper;
import com.jean.grey.common.ApiException;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 运维面的用户管理（仅 /api/admin/** 可达，门禁在 SecurityConfig）。
 *
 * 为什么禁用与踢下线分开：禁用是「这个人不能再用」，踢下线是「换台设备 / 丢了手机」；
 * 前者会连坐吊销全部会话，后者只是清掉会话、账号仍 active（用户下次登录即可）。
 */
@Service
public class AccountAdminService {

	/** 列表上限：运维面是「找人」不是「导出全库」。 */
	private static final int MAX_LIST_LIMIT = 200;

	private final AppUserMapper appUserMapper;
	private final UserDeviceMapper userDeviceMapper;
	private final UserIdentityMapper userIdentityMapper;
	private final TokenService tokenService;
	private final RolePolicy rolePolicy;
	private final AuditService auditService;

	public AccountAdminService(AppUserMapper appUserMapper, UserDeviceMapper userDeviceMapper,
			UserIdentityMapper userIdentityMapper, TokenService tokenService, RolePolicy rolePolicy,
			AuditService auditService) {
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.userIdentityMapper = userIdentityMapper;
		this.tokenService = tokenService;
		this.rolePolicy = rolePolicy;
		this.auditService = auditService;
	}

	public record UserItem(Long id, String email, String displayName, String role, String status,
			LocalDateTime createdAt) {
	}

	/** 用户详情：基础信息 + 设备数 + 最近活跃 + 注册来源（身份提供方）。 */
	public record UserDetail(Long id, String email, String displayName, String role, String status,
			LocalDateTime createdAt, int deviceCount, LocalDateTime lastActiveAt, List<String> providers) {
	}

	public record DeviceItem(Long id, String name, String platform, LocalDateTime lastSeenAt,
			LocalDateTime createdAt) {
	}

	public List<UserItem> list(String query, Integer limit) {
		int size = limit == null ? 50 : Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
		var wrapper = Wrappers.<AppUser>lambdaQuery();
		if (query != null && !query.isBlank()) {
			// LOWER 是为了连大小写混杂的历史行一起搜到（与登录路径同一口径）。
			String needle = "%" + query.trim().toLowerCase(Locale.ROOT) + "%";
			wrapper.apply("(LOWER(email) LIKE {0} OR LOWER(display_name) LIKE {0})", needle);
		}
		wrapper.orderByDesc(AppUser::getCreatedAt).last("LIMIT " + size);
		return appUserMapper.selectList(wrapper).stream()
				.map(user -> new UserItem(user.getId(), user.getEmail(), user.getDisplayName(),
						user.getRole(), user.getStatus(), user.getCreatedAt()))
				.toList();
	}

	/** 某用户的设备清单（运维面用：可逐台吊销，而非一次性踢光）。 */
	public List<DeviceItem> listDevices(Long userId) {
		requireUser(userId);
		return userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
						.eq(UserDevice::getUserId, userId)
						.orderByDesc(UserDevice::getCreatedAt))
				.stream()
				.map(device -> new DeviceItem(device.getId(), device.getName(), device.getPlatform(),
						device.getLastSeenAt(), device.getCreatedAt()))
				.toList();
	}

	/** 吊销某一台设备：验证归属后删设备行 + 撤销其 Redis 会话，并记审计。 */
	@Transactional
	public void revokeDevice(Long actorId, Long userId, Long deviceId) {
		UserDevice device = userDeviceMapper.selectById(deviceId);
		if (device == null || !userId.equals(device.getUserId())) {
			throw ApiException.notFound("device_not_found", "设备不存在或不属于该用户");
		}
		userDeviceMapper.deleteById(deviceId);
		tokenService.revokeDevice(deviceId);
		auditService.record(actorId, AuditService.ACTION_DEVICE_REVOKE, AuditService.TARGET_DEVICE,
				deviceId, "user=" + userId);
	}

	@Transactional
	public UserItem updateStatus(Long actorId, Long targetId, String status) {
		String normalized = status == null ? "" : status.trim().toLowerCase(Locale.ROOT);
		if (!"active".equals(normalized) && !"disabled".equals(normalized)) {
			throw ApiException.badRequest("status_invalid", "status 只能是 active 或 disabled");
		}
		AppUser user = requireUser(targetId);
		if (actorId.equals(targetId) && "disabled".equals(normalized)) {
			// 自己把自己锁在外面没有任何恢复路径（没有第二个入口改库），直接拒绝。
			throw ApiException.badRequest("cannot_disable_self", "不能禁用自己");
		}
		user.setStatus(normalized);
		appUserMapper.updateById(user);
		if ("disabled".equals(normalized)) {
			// 禁用即连坐：手上没过期的 token 一并作废，避免「已经禁用了还能继续用半小时」。
			tokenService.revokeDevices(deviceIds(targetId));
		}
		auditService.record(actorId,
				"disabled".equals(normalized) ? AuditService.ACTION_USER_DISABLE
						: AuditService.ACTION_USER_ENABLE,
				AuditService.TARGET_USER, targetId, "email=" + user.getEmail());
		return new UserItem(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole(),
				user.getStatus(), user.getCreatedAt());
	}

	/**
	 * 角色升降：把普通用户提为 admin / 反之。
	 *
	 * 两条硬守卫：
	 * 1. 不能改自己的角色——避免把自己降权后锁在运维面之外（且无法自愈）。
	 * 2. 邮箱在 grey.auth.admin-emails 名单内的账号是「固定 admin」：名单由部署者掌握，
	 *    不靠数据库；手动降权会在下次登录被 RolePolicy 重新提成，所以这里直接拒绝，
	 *    提示去环境变量移除。手动提成 admin 则会持久（syncRole 只提不降，不会回写）。
	 * 3. 不能移除最后一个管理员（无论名单是否为空），否则运维面无人可管。
	 */
	@Transactional
	public UserItem changeRole(Long actorId, Long targetId, String role) {
		String normalized = role == null ? "" : role.trim().toLowerCase(Locale.ROOT);
		if (!"admin".equals(normalized) && !"user".equals(normalized)) {
			throw ApiException.badRequest("role_invalid", "role 只能是 admin 或 user");
		}
		AppUser user = requireUser(targetId);
		if (actorId.equals(targetId)) {
			throw ApiException.badRequest("cannot_change_own_role", "不能修改自己的角色");
		}
		if (rolePolicy.isAdmin(user.getEmail())) {
			if ("user".equals(normalized)) {
				throw ApiException.badRequest("admin_email_fixed",
						"该邮箱在 admin-emails 名单内，需先在环境变量移除并重启才能降权");
			}
			// 已经是 admin，幂等返回。
			return toItem(user);
		}
		if ("user".equals(normalized)) {
			long adminCount = appUserMapper.selectCount(
					Wrappers.<AppUser>lambdaQuery().eq(AppUser::getRole, RolePolicy.ADMIN));
			if (adminCount <= 1) {
				throw ApiException.badRequest("last_admin", "不能移除最后一个管理员");
			}
		}
		user.setRole(normalized);
		appUserMapper.updateById(user);
		auditService.record(actorId, AuditService.ACTION_USER_ROLE_CHANGE, AuditService.TARGET_USER,
				targetId, "to=" + normalized);
		return toItem(user);
	}

	/** 踢下线：保留账号，只清会话；返回被清的设备数。 */
	public int revokeSessions(Long actorId, Long targetId) {
		requireUser(targetId);
		List<Long> devices = deviceIds(targetId);
		tokenService.revokeDevices(devices);
		auditService.record(actorId, AuditService.ACTION_USER_SESSIONS_REVOKE, AuditService.TARGET_USER,
				targetId, "devices=" + devices.size());
		return devices.size();
	}

	/** 用户详情：聚合基础信息 + 设备数 + 最近活跃 + 注册来源。 */
	public UserDetail detail(Long userId) {
		AppUser user = requireUser(userId);
		List<UserDevice> devices = userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
				.eq(UserDevice::getUserId, userId));
		LocalDateTime lastActive = devices.stream()
				.map(UserDevice::getLastSeenAt)
				.filter(Objects::nonNull)
				.max(LocalDateTime::compareTo)
				.orElse(null);
		List<String> providers = userIdentityMapper.selectList(Wrappers.<UserIdentity>lambdaQuery()
						.eq(UserIdentity::getUserId, userId))
				.stream()
				.map(UserIdentity::getProvider)
				.distinct()
				.collect(Collectors.toList());
		return new UserDetail(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole(),
				user.getStatus(), user.getCreatedAt(), devices.size(), lastActive, providers);
	}

	private AppUser requireUser(Long userId) {
		AppUser user = appUserMapper.selectById(userId);
		if (user == null) {
			throw ApiException.notFound("user_not_found", "用户不存在");
		}
		return user;
	}

	private List<Long> deviceIds(Long userId) {
		return userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
						.eq(UserDevice::getUserId, userId))
				.stream()
				.map(UserDevice::getId)
				.toList();
	}

	private UserItem toItem(AppUser user) {
		return new UserItem(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole(),
				user.getStatus(), user.getCreatedAt());
	}

}
