package com.jean.grey.auth;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import com.jean.grey.common.ApiException;

/**
 * 入场码尝试限流：**只对失败计数**，成功一次即清零。
 *
 * 为什么按「连续失败」而不是「总请求」：正常用户可能连着登录几台设备（每台一枚码），
 * 按总量限流会误伤；而暴力猜码的表现恰恰是「同一来源连续失败」。计数放 Redis，
 * 多实例部署共享同一份窗口。
 *
 * 键按「作用域 + 来源地址」分。两个作用域互不影响：运维台密码被猜不应该把普通用户的
 * 入场码登录一起锁死（反之亦然）。
 *
 * 键按来源地址（remoteAddr）分。**刻意不读 X-Forwarded-For**：那是请求方可伪造的头，
 * 直接采信等于把限流开关交给攻击者。部署在反向代理后时应让容器层把真实地址写进
 * remoteAddr（Spring 的 forward-headers-strategy 会处理），而不是在这里猜。
 */
@Service
public class AuthRateLimiter {

	public static final String SCOPE_ENROLL = "enroll";
	public static final String SCOPE_ADMIN = "admin-login";

	private static final String KEY_PREFIX = "grey:auth:";

	private final StringRedisTemplate redis;
	private final int maxFailures;
	private final Duration window;

	public AuthRateLimiter(StringRedisTemplate redis,
			@Value("${grey.auth.enroll-max-failures:10}") int maxFailures,
			@Value("${grey.auth.enroll-fail-window:PT10M}") Duration window) {
		this.redis = redis;
		this.maxFailures = maxFailures;
		this.window = window;
	}

	public void assertAllowed(String client) {
		assertAllowed(SCOPE_ENROLL, client);
	}

	/** 超限直接 429；不消费配额（配额只由 {@link #recordFailure} 累加）。 */
	public void assertAllowed(String scope, String client) {
		String value = redis.opsForValue().get(key(scope, client));
		if (value != null && parseInt(value) >= maxFailures) {
			String code = SCOPE_ENROLL.equals(scope) ? "enroll_rate_limited" : "admin_login_rate_limited";
			throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, code, "尝试次数过多，请稍后再试");
		}
	}

	public void recordFailure(String client) {
		recordFailure(SCOPE_ENROLL, client);
	}

	/** 记一次失败：首次失败时开窗，窗口随每次失败向后滑。 */
	public void recordFailure(String scope, String client) {
		String key = key(scope, client);
		redis.opsForValue().increment(key);
		redis.expire(key, window);
	}

	/** 登录成功即清零：用户已经证明自己拿着凭据，没必要继续压着他的来源地址。 */
	public void clear(String client) {
		clear(SCOPE_ENROLL, client);
	}

	public void clear(String scope, String client) {
		redis.delete(key(scope, client));
	}

	private static String key(String scope, String client) {
		// 保持 enroll 的旧键名 grey:auth:enroll-fail:<ip>：限流是瞬时状态，但键名一变
		// 已在窗口里的失败计数就凭空清零了（等于给暴力猜码一次免费重试）。
		return KEY_PREFIX + scope + "-fail:" + client;
	}

	private static int parseInt(String value) {
		try {
			return Integer.parseInt(value);
		}
		catch (NumberFormatException ex) {
			return 0;
		}
	}

}
