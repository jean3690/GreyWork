package com.jean.grey.llm;

import com.jean.grey.common.ApiException;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * OpenAI 兼容代理：鉴权、限流、选 key、转发、记账。正文原样透传，不做协议改写。
 */
@Service
public class LlmGatewayService {

	private static final Logger log = LoggerFactory.getLogger(LlmGatewayService.class);

	private final HttpClient http;
	private final LlmKeyService keyService;
	private final LlmUsageService usageService;
	private final QuotaService quotaService;
	private final ObjectMapper objectMapper;

	public LlmGatewayService(LlmKeyService keyService, LlmUsageService usageService,
			QuotaService quotaService, ObjectMapper objectMapper) {
		this.keyService = keyService;
		this.usageService = usageService;
		this.quotaService = quotaService;
		this.objectMapper = objectMapper;
		this.http = HttpClient.newBuilder()
				.connectTimeout(Duration.ofSeconds(10))
				.followRedirects(HttpClient.Redirect.NEVER)
				.build();
	}

	/** 只暴露模型 ID；上游鉴权与供应商选择在 Java 内完成。 */
	public Map<String, Object> models(Long userId, String provider) {
		if (provider == null || !LlmKeyService.PROVIDERS.contains(provider)) {
			throw ApiException.badRequest("provider_unknown", "请选择有效的供应商");
		}
		LlmKeyService.ResolvedKey key = keyService.pick(userId, provider);
		try {
			HttpRequest request = HttpRequest.newBuilder(URI.create(key.baseUrl() + "/models"))
					.timeout(Duration.ofSeconds(20)).header("Accept", "application/json")
					.header("Authorization", "Bearer " + key.secret()).GET().build();
			HttpResponse<InputStream> result = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
			try (var input = result.body()) {
				if (result.statusCode() != 200) {
					throw new ApiException(HttpStatus.BAD_GATEWAY, "models_unavailable",
							"上游模型列表返回 " + result.statusCode() + "，可手动填写模型 ID 后聊天");
				}
				byte[] bytes = input.readNBytes(1024 * 1024 + 1);
				if (bytes.length > 1024 * 1024) throw new ApiException(HttpStatus.BAD_GATEWAY, "models_invalid", "模型列表过大");
				JsonNode payload = parse(bytes);
				if (payload == null || !payload.has("data") || !payload.get("data").isArray()) {
					throw new ApiException(HttpStatus.BAD_GATEWAY, "models_invalid", "上游模型列表格式不兼容，可手动填写模型 ID");
				}
				List<String> ids = new ArrayList<>();
				for (JsonNode item : payload.get("data")) {
					if (item.hasNonNull("id") && item.get("id").isString()) ids.add(item.get("id").asString());
				}
				return Map.of("object", "list", "data", ids.stream().filter(id -> !id.isBlank()).distinct().sorted()
						.map(id -> Map.of("id", id, "object", "model")).toList());
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new ApiException(HttpStatus.BAD_GATEWAY, "upstream_interrupted", "模型列表请求被中断");
		}
		catch (IOException ex) {
			throw new ApiException(HttpStatus.BAD_GATEWAY, "upstream_unreachable", "无法获取模型列表，可手动填写模型 ID");
		}
	}

	public void forward(Long userId, String providerHint, byte[] body, HttpServletResponse response) {
		quotaService.acquire(userId);
		LlmKeyService.ResolvedKey key = keyService.pick(userId, providerHint);

		JsonNode request = parse(body);
		String model = request != null && request.hasNonNull("model")
				? request.get("model").asString()
				: "";

		long started = System.nanoTime();
		HttpResponse<InputStream> upstream;
		try {
			HttpRequest httpRequest = HttpRequest.newBuilder(URI.create(key.baseUrl() + "/chat/completions"))
					.timeout(Duration.ofMinutes(10))
					.header("Content-Type", "application/json")
					.header("Accept", "text/event-stream, application/json")
					.header("Authorization", "Bearer " + key.secret())
					.POST(HttpRequest.BodyPublishers.ofByteArray(body))
					.build();
			upstream = http.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			usageService.record(userId, key.id(), key.provider(), model, 0, 0, 0, "error", 0,
					elapsed(started));
			throw new ApiException(HttpStatus.BAD_GATEWAY, "upstream_interrupted", "上游请求被中断");
		}
		catch (IOException ex) {
			log.warn("upstream unreachable: {}", key.baseUrl(), ex);
			usageService.record(userId, key.id(), key.provider(), model, 0, 0, 0, "error", 0,
					elapsed(started));
			throw new ApiException(HttpStatus.BAD_GATEWAY, "upstream_unreachable",
					"连不上供应商接口: " + key.baseUrl());
		}

		String contentType = upstream.headers().firstValue("Content-Type").orElse("application/json");
		boolean streaming = contentType.contains("text/event-stream");
		int status = upstream.statusCode();
		int[] tokens = new int[3];
		String recordStatus = status >= 400 ? "upstream_error" : (streaming ? "stream" : "ok");

		response.setStatus(status);
		response.setContentType(contentType);
		response.setCharacterEncoding("UTF-8");
		response.setHeader("X-Grey-Key-Id", String.valueOf(key.id()));
		if (streaming) {
			response.setHeader("Cache-Control", "no-cache");
			response.setHeader("X-Accel-Buffering", "no");
		}

		try (InputStream in = upstream.body()) {
			if (streaming) {
				tokens = relayStream(in, response);
			}
			else {
				byte[] payload = in.readAllBytes();
				response.getOutputStream().write(payload);
				response.flushBuffer();
				readUsage(parse(payload), tokens);
			}
		}
		catch (IOException ex) {
			recordStatus = "aborted";
			log.debug("client or upstream aborted mid-response", ex);
		}
		finally {
			usageService.record(userId, key.id(), key.provider(), model, tokens[0], tokens[1],
					tokens[2], recordStatus, status, elapsed(started));
		}
	}

	private int[] relayStream(InputStream in, HttpServletResponse response) throws IOException {
		int[] tokens = new int[3];
		BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
		JsonNode usage = null;
		String line;
		while ((line = reader.readLine()) != null) {
			if (line.startsWith("data:")) {
				String data = line.substring(5).trim();
				if (!data.isEmpty() && !"[DONE]".equals(data)) {
					JsonNode chunk = parse(data.getBytes(StandardCharsets.UTF_8));
					if (chunk != null && chunk.hasNonNull("usage")) {
						usage = chunk.get("usage");
					}
				}
			}
			response.getOutputStream().write(line.getBytes(StandardCharsets.UTF_8));
			response.getOutputStream().write(10);
			response.getOutputStream().flush();
		}
		if (usage != null) {
			readUsage(usage, tokens);
		}
		return tokens;
	}

	/** 入参既可能是完整响应，也可能已经是 usage 对象本身。 */
	private void readUsage(JsonNode payload, int[] tokens) {
		if (payload == null) {
			return;
		}
		JsonNode usage = payload.hasNonNull("usage") ? payload.get("usage") : payload;
		if (!usage.hasNonNull("prompt_tokens") && !usage.hasNonNull("total_tokens")) {
			return;
		}
		tokens[0] = intOf(usage, "prompt_tokens");
		tokens[1] = intOf(usage, "completion_tokens");
		tokens[2] = intOf(usage, "total_tokens");
	}

	private static int intOf(JsonNode node, String field) {
		return node.hasNonNull(field) ? node.get(field).asInt() : 0;
	}

	private JsonNode parse(byte[] body) {
		try {
			return objectMapper.readTree(body);
		}
		catch (RuntimeException ex) {
			return null;
		}
	}

	private static long elapsed(long startedNanos) {
		return (System.nanoTime() - startedNanos) / 1_000_000;
	}

}
