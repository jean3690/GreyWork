package com.jean.grey.llm;

import com.jean.grey.llm.entity.LlmUsage;
import com.jean.grey.llm.mapper.LlmUsageMapper;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class LlmUsageService {

	private final LlmUsageMapper usageMapper;

	public LlmUsageService(LlmUsageMapper usageMapper) {
		this.usageMapper = usageMapper;
	}

	public record UsageSummary(long requests, long promptTokens, long completionTokens,
			long totalTokens) {
	}

	public void record(Long userId, Long keyId, String provider, String model, int promptTokens,
			int completionTokens, int totalTokens, String status, int httpStatus, long latencyMs) {
		LlmUsage usage = new LlmUsage();
		usage.setUserId(userId);
		usage.setKeyId(keyId);
		usage.setProvider(provider == null ? "" : provider);
		usage.setModel(model == null ? "" : model);
		usage.setPromptTokens(promptTokens);
		usage.setCompletionTokens(completionTokens);
		usage.setTotalTokens(totalTokens);
		usage.setStatus(status);
		usage.setHttpStatus(httpStatus);
		usage.setLatencyMs(latencyMs);
		usageMapper.insert(usage);
	}

	public UsageSummary summary(Long userId, int days) {
		int span = Math.clamp(days, 1, 90);
		Map<String, Object> row = usageMapper.summary(userId,
				LocalDate.now().minusDays(span - 1L).atStartOfDay());
		return new UsageSummary(asLong(row.get("requests")), asLong(row.get("prompt_tokens")),
				asLong(row.get("completion_tokens")), asLong(row.get("total_tokens")));
	}

	public long tokensToday(Long userId) {
		Map<String, Object> row = usageMapper.summary(userId, LocalDate.now().atStartOfDay());
		return asLong(row.get("total_tokens"));
	}

	private static long asLong(Object value) {
		return value instanceof Number number ? number.longValue() : 0L;
	}

}
