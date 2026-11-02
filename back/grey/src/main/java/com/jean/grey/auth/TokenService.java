package com.jean.grey.auth;

import com.jean.grey.common.Hashes;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Collection;
import java.util.Optional;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * 不透明 bearer token，Redis 里只存 token 的 sha256，避免泄漏即等于凭据。
 */
@Service
public class TokenService {

	private static final String SESSION_PREFIX = "grey:sess:";
	private static final String DEVICE_PREFIX = "grey:dev:";
	private static final SecureRandom RANDOM = new SecureRandom();

	private final StringRedisTemplate redis;
	private final Duration ttl;

	public TokenService(StringRedisTemplate redis,
			@Value("${grey.auth.session-ttl:PT720H}") Duration ttl) {
		this.redis = redis;
		this.ttl = ttl;
	}

	public String issue(Long userId, Long deviceId) {
		byte[] raw = new byte[32];
		RANDOM.nextBytes(raw);
		String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
		String hash = hash(token);
		redis.opsForValue().set(SESSION_PREFIX + hash, userId + ":" + deviceId, ttl);
		redis.opsForSet().add(DEVICE_PREFIX + deviceId, hash);
		redis.expire(DEVICE_PREFIX + deviceId, ttl);
		return token;
	}

	public Optional<AuthPrincipal> resolve(String token) {
		String value = redis.opsForValue().get(SESSION_PREFIX + hash(token));
		if (value == null) {
			return Optional.empty();
		}
		String[] parts = value.split(":");
		return Optional.of(new AuthPrincipal(Long.valueOf(parts[0]), Long.valueOf(parts[1])));
	}

	public void revoke(String token) {
		String hash = hash(token);
		String value = redis.opsForValue().get(SESSION_PREFIX + hash);
		redis.delete(SESSION_PREFIX + hash);
		if (value != null) {
			String deviceId = value.split(":")[1];
			redis.opsForSet().remove(DEVICE_PREFIX + deviceId, hash);
		}
	}

	public void revokeDevice(Long deviceId) {
		String key = DEVICE_PREFIX + deviceId;
		Set<String> hashes = redis.opsForSet().members(key);
		if (hashes != null) {
			hashes.forEach(hash -> redis.delete(SESSION_PREFIX + hash));
		}
		redis.delete(key);
	}

	/**
	 * 滑动续期：把会话与设备集合的 TTL 重新拉满（由过滤链在「设备心跳节流」命中时调用，
	 * 也就是最多每 5 分钟一次，不会每个请求都写 Redis）。
	 *
	 * 语义是**空闲超时**而不是「登录后固定 30 天」：一直有活动的设备不会突然被登出，
	 * 而放着不用的会话仍会按 session-ttl 过期。要立刻失效仍走 logout / 踢下线 / 禁用。
	 */
	public void extend(String token) {
		String hash = hash(token);
		String key = SESSION_PREFIX + hash;
		String value = redis.opsForValue().get(key);
		if (value == null) {
			return;
		}
		redis.expire(key, ttl);
		String[] parts = value.split(":");
		if (parts.length == 2) {
			redis.expire(DEVICE_PREFIX + parts[1], ttl);
		}
	}

	/** 一次踢掉多台设备（禁用账号 / 运维「退出所有设备」）。 */
	public void revokeDevices(Collection<Long> deviceIds) {
		deviceIds.forEach(this::revokeDevice);
	}

	/** 设备心跳节流：5 分钟内只落库一次。 */
	public boolean claimLastSeenSlot(Long deviceId) {
		Boolean first = redis.opsForValue()
				.setIfAbsent("grey:seen:" + deviceId, "1", Duration.ofMinutes(5));
		return Boolean.TRUE.equals(first);
	}

	private static String hash(String token) {
		return Hashes.sha256Hex(token);
	}

}
