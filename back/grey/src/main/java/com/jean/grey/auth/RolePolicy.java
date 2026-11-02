package com.jean.grey.auth;

import com.jean.grey.common.Emails;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 角色判定：唯一的 admin 来源是配置里的邮箱名单（{@code grey.auth.admin-emails}）。
 *
 * 为什么不做「第一个用户是 admin」：入场码一旦外泄，先到的人就成了管理员；而邮箱名单是
 * 部署者写在环境变量里的，攻击者拿不到。为什么不做角色表 / 邀请流：自托管单用户场景下
 * 管理员就是部署者本人，名单足够，且改名单不需要动数据库。
 *
 * 名单在**登录时**生效（新用户建号定角色、老用户回访时补齐），并由 {@link AdminBootstrap}
 * 在启动时对已有行做一次对齐 —— 改完环境变量重启即可，不必让管理员重新登录。
 */
@Component
public class RolePolicy {

	public static final String ADMIN = "admin";
	public static final String USER = "user";

	private final Set<String> adminEmails;

	public RolePolicy(@Value("${grey.auth.admin-emails:}") String raw) {
		this.adminEmails = Arrays.stream(raw.split(","))
				.map(Emails::normalize)
				.filter(email -> email != null)
				.collect(Collectors.toUnmodifiableSet());
	}

	/** 该邮箱应得的角色；不在名单里一律普通用户。 */
	public String roleFor(String email) {
		String normalized = Emails.normalize(email);
		return normalized != null && adminEmails.contains(normalized) ? ADMIN : USER;
	}

	public boolean isAdmin(String email) {
		return ADMIN.equals(roleFor(email));
	}

	public Set<String> adminEmails() {
		return adminEmails;
	}

	public static boolean isAdminRole(String role) {
		return role != null && ADMIN.equals(role.toLowerCase(Locale.ROOT));
	}

}
