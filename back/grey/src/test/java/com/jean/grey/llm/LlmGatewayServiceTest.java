package com.jean.grey.llm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.jean.grey.common.ApiException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.json.JsonMapper;

class LlmGatewayServiceTest {

	private final LlmKeyService keys = mock(LlmKeyService.class);
	private final LlmUsageService usage = mock(LlmUsageService.class);
	private final QuotaService quota = mock(QuotaService.class);
	private final JsonMapper mapper = JsonMapper.builder().build();
	private final AtomicReference<String> authorization = new AtomicReference<>();
	private final AtomicReference<String> body = new AtomicReference<>();
	private HttpServer upstream;
	private LlmGatewayService gateway;
	private int modelsStatus = 200;

	@BeforeEach
	void setUp() throws Exception {
		upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		upstream.createContext("/v1/models", exchange -> {
			authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
			byte[] payload = "{\"data\":[{\"id\":\"b\",\"secret\":\"do-not-forward\"},{\"id\":\"a\"},{\"id\":\"a\"}]}".getBytes(StandardCharsets.UTF_8);
			exchange.getResponseHeaders().set("Content-Type", "application/json");
			exchange.sendResponseHeaders(modelsStatus, payload.length);
			try (var output = exchange.getResponseBody()) { output.write(payload); }
		});
		upstream.createContext("/v1/chat/completions", exchange -> {
			authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
			body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
			byte[] payload = ("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"
					+ "data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n"
					+ "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
			exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
			exchange.sendResponseHeaders(200, payload.length);
			try (var output = exchange.getResponseBody()) { output.write(payload); }
		});
		upstream.start();
		when(keys.pick(1L, "openai")).thenReturn(new LlmKeyService.ResolvedKey(2L, "openai",
				"http://127.0.0.1:" + upstream.getAddress().getPort() + "/v1", "upstream-key"));
		gateway = new LlmGatewayService(keys, usage, quota, mapper);
	}

	@AfterEach
	void close() { upstream.stop(0); }

	@Test
	void modelDiscoveryUsesJavaCredentialsAndOnlyReturnsModelIds() {
		var response = gateway.models(1L, "openai");
		assertThat(mapper.writeValueAsString(response)).contains("\"id\":\"a\"", "\"id\":\"b\"")
				.doesNotContain("secret", "upstream-key", "do-not-forward");
		assertThat(authorization.get()).isEqualTo("Bearer upstream-key");
		assertThat((List<?>) response.get("data")).hasSize(2);
	}

	@Test
	void unsupportedModelDiscoveryAllowsManualModelIds() {
		modelsStatus = 404;
		assertThatThrownBy(() -> gateway.models(1L, "openai"))
				.isInstanceOf(ApiException.class).hasMessageContaining("手动填写");
	}

	@Test
	void streamsAndToolRequestsAreRelayedWithoutProtocolRewrite() throws Exception {
		var response = new MockHttpServletResponse();
		String input = "{\"model\":\"a\",\"stream\":true,\"messages\":[],\"tools\":[{\"type\":\"function\"}]}";
		gateway.forward(1L, "openai", input.getBytes(StandardCharsets.UTF_8), response);
		assertThat(body.get()).isEqualTo(input);
		assertThat(authorization.get()).isEqualTo("Bearer upstream-key");
		assertThat(response.getContentAsString()).contains("hello", "[DONE]").doesNotContain("upstream-key");
		verify(quota).acquire(1L);
	}
}
