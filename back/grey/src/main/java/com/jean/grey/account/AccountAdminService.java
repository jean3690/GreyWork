package com.jean.grey.account;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.TokenService;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.common.ApiException;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Locale;
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
	private final TokenService tokenService;

	public AccountAdminService(AppUserMapper appUserMapper, UserDeviceMapper userDeviceMapper,
			TokenService tokenService) {
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.tokenService = tokenService;
	}

	public record UserItem(Long id, String email, String displayName, String role, String status,
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
		return new UserItem(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole(),
				user.getStatus(), user.getCreatedAt());
	}

	/** 踢下线：保留账号，只清会话；返回被清的设备数。 */
	public int revokeSessions(Long targetId) {
		requireUser(targetId);
		List<Long> devices = deviceIds(targetId);
		tokenService.revokeDevices(devices);
		return devices.size();
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

}
