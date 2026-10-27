package com.jean.grey.automation;

import com.jean.grey.config.AiProperties;
import com.jean.grey.llm.LlmKeyService;
import com.jean.grey.llm.LlmUsageService;
import com.jean.grey.llm.QuotaService;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * 云端执行器：不复刻宿主的 agent 运行时，直接用模型网关的供应商池跑一轮对话。
 * 适合通知、摘要、生成类任务；没有工具调用，也没有 shell，安全面收敛在 LLM 出口。
 */
@Service
public class CloudAutomationRunner {

	private static final Logger log = LoggerFactory.getLogger(CloudAutomationRunner.class);

	private final HttpClient http;
	private final LlmKeyService keyService;
	private final LlmUsageService usageService;
	private final QuotaService quotaService;
	private final AiProperties aiProperties;
	private final ObjectMapper objectMapper;

	public CloudAutomationRunner(LlmKeyService keyService, LlmUsageService usageService,
			QuotaService quotaService, AiProperties aiProperties, ObjectMapper objectMapper) {
		this.keyService = keyService;
		this.usageService = usageService;
		this.quotaService = quotaService;
		this.aiProperties = aiProperties;
		this.objectMapper = objectMapper;
		this.http = HttpClient.newBuilder()
				.connectTimeout(Duration.ofSeconds(10))
				.followRedirects(HttpClient.Redirect.NORMAL)
				.build();
	}

	/** @return 模型输出文本；失败抛异常，由调度器落 failed 运行记录。 */
	public String run(Long userId, String taskId, String target, String intent,
			String acpProviderId, String model) {
		quotaService.acquire(userId);
		LlmKeyService.ResolvedKey key = keyService.pick(userId, acpProviderId);

		ObjectNode body = objectMapper.createObjectNode();
		String useModel = model == null || model.isBlank()
				? aiProperties.normalizedDefaultModel()
				: model;
		body.put("model", useModel);
		var messages = body.putArray("messages");
		if (target != null && !target.isBlank()) {
			ObjectNode context = messages.addObject();
			context.put("role", "user");
			context.put("content", "任务目标上下文（仅供参考，不要直接回复这条）: " + target);
		}
		ObjectNode prompt = messages.addObject();
		prompt.put("role", "user");
		prompt.put("content", intent);
		body.put("stream", false);

		long started = System.nanoTime();
		byte[] payload;
		int status;
		try {
			HttpRequest request = HttpRequest.newBuilder(
					URI.create(key.baseUrl() + "/chat/completions"))
					.timeout(Duration.ofMinutes(10))
					.header("Content-Type", "application/json")
					.header("Authorization", "Bearer " + key.secret())
					.POST(HttpRequest.BodyPublishers.ofByteArray(
							objectMapper.writeValueAsBytes(body)))
					.build();
			HttpResponse<byte[]> response = http.send(request,
					HttpResponse.BodyHandlers.ofByteArray());
			payload = response.body();
			status = response.statusCode();
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			usageService.record(userId, key.id(), key.provider(), useModel, 0, 0, 0, "error", 0,
					elapsed(started));
			throw new IllegalStateException("云端执行被中断");
		}
		catch (Exception ex) {
			log.warn("cloud automation upstream unreachable: {}", key.baseUrl(), ex);
			usageService.record(userId, key.id(), key.provider(), useModel, 0, 0, 0, "error", 0,
					elapsed(started));
			throw new IllegalStateException("连不上供应商接口: " + key.baseUrl(), ex);
		}

		JsonNode parsed = parse(payload);
		int[] tokens = readTokens(parsed);
		if (status >= 400) {
			usageService.record(userId, key.id(), key.provider(), useModel, tokens[0], tokens[1],
					tokens[2], "upstream_error", status, elapsed(started));
			String detail = parsed != null && parsed.hasNonNull("error")
					? parsed.get("error").toString()
					: "HTTP " + status;
			throw new IllegalStateException("供应商返回错误: " + detail);
		}
		usageService.record(userId, key.id(), key.provider(), useModel, tokens[0], tokens[1],
				tokens[2], "ok", status, elapsed(started));

		JsonNode content = parsed == null ? null
				: parsed.path("choices").path(0).path("message").path("content");
		if (content.isMissingNode() || content.isNull()) {
			throw new IllegalStateException("供应商响应缺少 choices[0].message.content");
		}
		return content.asString();
	}

	private int[] readTokens(JsonNode payload) {
		int[] tokens = new int[3];
		if (payload == null || !payload.hasNonNull("usage")) {
			return tokens;
		}
		JsonNode usage = payload.get("usage");
		tokens[0] = usage.path("prompt_tokens").asInt(0);
		tokens[1] = usage.path("completion_tokens").asInt(0);
		tokens[2] = usage.path("total_tokens").asInt(tokens[0] + tokens[1]);
		return tokens;
	}

	private JsonNode parse(byte[] payload) {
		try {
			return objectMapper.readTree(payload);
		}
		catch (Exception ex) {
			return null;
		}
	}

	private static long elapsed(long startedNanos) {
		return (System.nanoTime() - startedNanos) / 1_000_000;
	}

}
