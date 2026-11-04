package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 启动时把配置名单里的已有账号提成 admin。
 *
 * 登录路径本来就会同步角色，但「改了环境变量又不想让管理员重新登录」是常态（尤其是刚把
 * 某人加进名单时），所以启动对齐一次。**只提权不降权**：从名单里移除不会自动降级，避免
 * 手滑改错环境变量就把自己锁在运维面之外 —— 降权需要显式改库或后续的管理端点。
 */
@Component
@Order(1)
public class AdminBootstrap implements ApplicationRunner {

	private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

	private final AppUserMapper appUserMapper;
	private final RolePolicy rolePolicy;

	public AdminBootstrap(AppUserMapper appUserMapper, RolePolicy rolePolicy) {
		this.appUserMapper = appUserMapper;
		this.rolePolicy = rolePolicy;
	}

	@Override
	public void run(ApplicationArguments args) {
		if (rolePolicy.adminEmails().isEmpty()) {
			return;
		}
		var candidates = appUserMapper.selectList(Wrappers.<AppUser>lambdaQuery()
				.ne(AppUser::getRole, RolePolicy.ADMIN));
		int promoted = 0;
		for (AppUser user : candidates) {
			if (rolePolicy.isAdmin(user.getEmail())) {
				user.setRole(RolePolicy.ADMIN);
				appUserMapper.updateById(user);
				promoted++;
			}
		}
		if (promoted > 0) {
			log.info("已按 grey.auth.admin-emails 提升 {} 个账号为 admin", promoted);
		}
	}

}
