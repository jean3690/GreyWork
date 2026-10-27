package com.jean.grey.llm;

import com.jean.grey.common.ApiException;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class QuotaService {

	private final StringRedisTemplate redis;
	private final LlmUsageService usageService;
	private final int rpmLimit;
	private final long dailyTokenLimit;

	public QuotaService(StringRedisTemplate redis, LlmUsageService usageService,
			@Value("${grey.llm.rpm-limit:60}") int rpmLimit,
			@Value("${grey.llm.daily-token-limit:0}") long dailyTokenLimit) {
		this.redis = redis;
		this.usageService = usageService;
		this.rpmLimit = rpmLimit;
		this.dailyTokenLimit = dailyTokenLimit;
	}

	public void acquire(Long userId) {
		if (rpmLimit > 0) {
			String key = "grey:llm:rpm:" + userId;
			Long count = redis.opsForValue().increment(key);
			if (count != null && count == 1L) {
				redis.expire(key, Duration.ofSeconds(70));
			}
			if (count != null && count > rpmLimit) {
				throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "rate_limited",
						"每分钟请求数超出限制（" + rpmLimit + "）");
			}
		}
		if (dailyTokenLimit > 0 && usageService.tokensToday(userId) >= dailyTokenLimit) {
			throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "quota_exceeded",
					"当日 token 配额已用完（" + dailyTokenLimit + "）");
		}
	}

}
