package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.AuditLog;
import com.jean.grey.auth.mapper.AuditLogMapper;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * 运维操作审计：任何会改变用户/设备/入场码状态的 admin 动作都记一笔。
 *
 * 写入失败不阻断主流程——审计是「旁路证据」，不能因为写日志失败就把禁用账号、踢人
 * 这类关键操作一起搞砸；所以 record 吞掉异常、只打日志。读取用 list，按时间倒序，
 * 可选按 (target_type, target_id) 收敛到某个用户/设备。
 */
@Service
public class AuditService {

	public static final String ACTION_USER_ENABLE = "user_enable";
	public static final String ACTION_USER_DISABLE = "user_disable";
	public static final String ACTION_USER_ROLE_CHANGE = "user_role_change";
	public static final String ACTION_USER_SESSIONS_REVOKE = "user_sessions_revoke";
	public static final String ACTION_DEVICE_REVOKE = "device_revoke";
	public static final String ACTION_ENROLL_CODE_ISSUE = "enroll_code_issue";
	public static final String ACTION_ENROLL_CODE_REVOKE = "enroll_code_revoke";
	public static final String ACTION_CHANNEL_STATUS = "channel_status";
	public static final String ACTION_ADMIN_PASSWORD_CHANGE = "admin_password_change";
	public static final String ACTION_ADMIN_LOGIN = "admin_login";

	public static final String TARGET_USER = "user";
	public static final String TARGET_DEVICE = "device";
	public static final String TARGET_ENROLL_CODE = "enroll_code";
	public static final String TARGET_CHANNEL = "channel";

	private static final int MAX_LIST_LIMIT = 200;

	private final AuditLogMapper auditLogMapper;
	private final AppUserMapper appUserMapper;

	public AuditService(AuditLogMapper auditLogMapper, AppUserMapper appUserMapper) {
		this.auditLogMapper = auditLogMapper;
		this.appUserMapper = appUserMapper;
	}

	public void record(Long actorId, String action, String targetType, Long targetId, String detail) {
		try {
			String email = "system";
			if (actorId != null) {
				AppUser actor = appUserMapper.selectById(actorId);
				if (actor != null && actor.getEmail() != null) {
					email = actor.getEmail();
				}
			}
			AuditLog log = new AuditLog();
			log.setActorId(actorId);
			log.setActorEmail(email);
			log.setAction(action);
			log.setTargetType(targetType);
			log.setTargetId(targetId);
			log.setDetail(detail);
			auditLogMapper.insert(log);
		}
		catch (RuntimeException failure) {
			// 审计是旁路：宁可漏记也不能阻断主操作。
			org.slf4j.LoggerFactory.getLogger(AuditService.class)
				.warn("审计写入失败（已跳过）：action={}, target={}/{}", action, targetType, targetId, failure);
		}
	}

	public List<AuditLog> list(String targetType, Long targetId, Integer limit, Long offset) {
		int size = limit == null ? 50 : Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
		long skip = offset == null || offset < 0 ? 0 : offset;
		var wrapper = Wrappers.<AuditLog>lambdaQuery()
			.orderByDesc(AuditLog::getCreatedAt);
		if (targetType != null && !targetType.isBlank()) {
			wrapper.eq(AuditLog::getTargetType, targetType);
		}
		if (targetId != null) {
			wrapper.eq(AuditLog::getTargetId, targetId);
		}
		wrapper.last("LIMIT " + size + " OFFSET " + skip);
		return auditLogMapper.selectList(wrapper);
	}

}
