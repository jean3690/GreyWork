package com.jean.grey.auth;

import com.jean.grey.common.Hashes;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
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
