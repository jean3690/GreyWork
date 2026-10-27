package com.jean.grey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.common.Hashes;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.mysql.MySQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Testcontainers
@SpringBootTest(properties = {
		"grey.llm.master-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
		"grey.llm.rpm-limit=3"
})
@AutoConfigureMockMvc
class ControlPlaneApiTest {

	@Container
	@ServiceConnection
	static final MySQLContainer MYSQL = new MySQLContainer("mysql:8.4");

	@Container
	static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
			.withExposedPorts(6379);


	static final java.security.KeyPair MARKET_KEYS = generateMarketKeys();

	private static java.security.KeyPair generateMarketKeys() {
		try {
			return java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
		}
		catch (Exception ex) {
			throw new IllegalStateException(ex);
		}
	}

	static final com.sun.net.httpserver.HttpServer IDP = startIdp();

	private static com.sun.net.httpserver.HttpServer startIdp() {
		try {
			var server = com.sun.net.httpserver.HttpServer
					.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
			server.createContext("/authorize", exchange -> {
				exchange.sendResponseHeaders(200, -1);
				exchange.close();
			});
			server.createContext("/token", exchange -> {
				String form = new String(exchange.getRequestBody().readAllBytes(),
						java.nio.charset.StandardCharsets.UTF_8);
				if (form.contains("code=good-code")) {
					byte[] out = "{\"access_token\":\"at-1\",\"token_type\":\"bearer\"}"
							.getBytes(java.nio.charset.StandardCharsets.UTF_8);
					exchange.getResponseHeaders().add("Content-Type", "application/json");
					exchange.sendResponseHeaders(200, out.length);
					exchange.getResponseBody().write(out);
				}
				else {
					exchange.sendResponseHeaders(400, -1);
				}
				exchange.close();
			});
			server.createContext("/userinfo", exchange -> {
				if ("Bearer at-1".equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
					byte[] out = ("{\"sub\":\"oidc-42\",\"email\":\"oidc@grey.local\","
							+ "\"name\":\"Oidc User\"}")
							.getBytes(java.nio.charset.StandardCharsets.UTF_8);
					exchange.getResponseHeaders().add("Content-Type", "application/json");
					exchange.sendResponseHeaders(200, out.length);
					exchange.getResponseBody().write(out);
				}
				else {
					exchange.sendResponseHeaders(401, -1);
				}
				exchange.close();
			});
			server.start();
			return server;
		}
		catch (Exception ex) {
			throw new IllegalStateException(ex);
		}
	}

	@org.junit.jupiter.api.AfterAll
	static void stopIdp() {
		IDP.stop(0);
	}

	static String idpBase() {
		return "http://127.0.0.1:" + IDP.getAddress().getPort();
	}

	@DynamicPropertySource
	static void oidcProperties(DynamicPropertyRegistry registry) {
		registry.add("grey.oidc.allowed-redirects[0]", () -> "http://127.0.0.1:9999");
		registry.add("grey.oidc.providers.stub.client-id", () -> "test-client");
		registry.add("grey.oidc.providers.stub.client-secret", () -> "test-secret");
		registry.add("grey.oidc.providers.stub.authorization-url", () -> idpBase() + "/authorize");
		registry.add("grey.oidc.providers.stub.token-url", () -> idpBase() + "/token");
		registry.add("grey.oidc.providers.stub.userinfo-url", () -> idpBase() + "/userinfo");
		registry.add("grey.oidc.providers.stub.email-field", () -> "email");
		registry.add("grey.oidc.providers.stub.name-field", () -> "name");
	}

	@DynamicPropertySource
	static void marketProperties(DynamicPropertyRegistry registry) {
		registry.add("grey.market.signing-key", () -> java.util.Base64.getEncoder()
				.encodeToString(MARKET_KEYS.getPrivate().getEncoded()));
	}


	@DynamicPropertySource
	static void redisProperties(DynamicPropertyRegistry registry) {
		registry.add("spring.data.redis.host", REDIS::getHost);
		registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
	}

	@Autowired
	MockMvc mockMvc;

	@Autowired
	ObjectMapper objectMapper;

	@Autowired
	EnrollmentCodeMapper enrollmentCodeMapper;

	@Autowired
	org.springframework.data.redis.core.StringRedisTemplate redis;

	@Test
	void enrollSyncAndRevoke() throws Exception {
		JsonNode session = enroll("me@grey.local", "desktop");
		String token = session.get("token").asString();
		String bearer = "Bearer " + token;
		assertThat(token).isNotBlank();

		mockMvc.perform(get("/api/auth/me").header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.device.platform").value("desktop"));

		MvcResult created = mockMvc.perform(put("/api/sync/objects/settings/theme")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"baseRevision":null,"payload":{"dark":true}}
								"""))
				.andExpect(status().isOk())
				.andReturn();
		long firstRevision = json(created).get("revision").asLong();
		assertThat(firstRevision).isPositive();

		mockMvc.perform(put("/api/sync/objects/settings/theme")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"baseRevision":null,"payload":{"dark":false}}
								"""))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("sync_conflict"))
				.andExpect(jsonPath("$.current.revision").value(firstRevision));

		MvcResult updated = mockMvc.perform(put("/api/sync/objects/settings/theme")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"baseRevision":%d,"payload":{"dark":false}}
								""".formatted(firstRevision)))
				.andExpect(status().isOk())
				.andReturn();
		long secondRevision = json(updated).get("revision").asLong();
		assertThat(secondRevision).isGreaterThan(firstRevision);

		MvcResult pulled = mockMvc.perform(get("/api/sync/changes")
						.header("Authorization", bearer)
						.param("since", "0"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.changes.length()").value(2))
				.andExpect(jsonPath("$.changes[1].payload.dark").value(false))
				.andReturn();
		assertThat(json(pulled).get("revision").asLong()).isEqualTo(secondRevision);

		mockMvc.perform(get("/api/sync/changes")
						.header("Authorization", bearer)
						.param("since", String.valueOf(secondRevision)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.changes.length()").value(0));

		mockMvc.perform(get("/api/sync/changes")).andExpect(status().isUnauthorized());
		mockMvc.perform(put("/api/sync/objects/secrets/a")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("{}"))
				.andExpect(status().isBadRequest());

		MvcResult devices = mockMvc.perform(get("/api/devices").header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1))
				.andExpect(jsonPath("$[0].current").value(true))
				.andReturn();
		long deviceId = json(devices).get(0).get("id").asLong();

		mockMvc.perform(delete("/api/devices/" + deviceId).header("Authorization", bearer))
				.andExpect(status().isNoContent());
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearer))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void hostsShardChannelsAndRouteWebhooks() throws Exception {
		String owner = "hosts@grey.local";
		JsonNode primary = enroll(owner, "server");
		String primaryBearer = "Bearer " + primary.get("token").asString();
		long primaryDevice = primary.get("device").get("id").asLong();

		// 没有任何在线宿主时不允许绑通道
		JsonNode bystander = enroll("bystander@grey.local", "desktop");
		mockMvc.perform(post("/api/channels/bindings")
						.header("Authorization", "Bearer " + bystander.get("token").asString())
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"platform":"telegram","accountRef":"@ghost"}
								"""))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("no_available_host"));

		mockMvc.perform(put("/api/hosts/me")
						.header("Authorization", primaryBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"name":"ctrl-01","version":"0.2.0","capabilities":["telegram"]}
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.alive").value(true));

		mockMvc.perform(get("/api/hosts").header("Authorization", primaryBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1))
				.andExpect(jsonPath("$[0].name").value("ctrl-01"))
				.andExpect(jsonPath("$[0].alive").value(true))
				.andExpect(jsonPath("$[0].bindings").value(0));

		// 绑定通道：控制面把它分给调用方宿主，并给一条 webhook 地址
		MvcResult bound = mockMvc.perform(post("/api/channels/bindings")
						.header("Authorization", primaryBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"platform":"telegram","accountRef":"@grey_bot"}
								"""))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.binding.hostDeviceId").value(primaryDevice))
				.andReturn();
		JsonNode binding = json(bound).get("binding");
		long bindingId = binding.get("id").asLong();
		URI webhook = URI.create(json(bound).get("webhookUrl").asString());
		String webhookPath = webhook.getPath();
		String webhookQuery = webhook.getQuery();

		// 重复绑定同一账号 → 409
		mockMvc.perform(post("/api/channels/bindings")
						.header("Authorization", primaryBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"platform":"telegram","accountRef":"@grey_bot"}
								"""))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("binding_exists"));

		// 宿主能拉到该连的通道清单
		mockMvc.perform(get("/api/hosts/me/bindings").header("Authorization", primaryBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1))
				.andExpect(jsonPath("$[0].accountRef").value("@grey_bot"));

		// webhook 鉴权：错 secret 401
		mockMvc.perform(post(webhookPath).queryParam("k", "wrong")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"tg-1","payload":{"text":"hi"}}
								"""))
				.andExpect(status().isUnauthorized());

		// 正确 secret → 202，重复投递幂等
		mockMvc.perform(post(webhookPath).queryParam("k", queryParam(webhookQuery, "k"))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"tg-1","payload":{"text":"hi"}}
								"""))
				.andExpect(status().isAccepted())
				.andExpect(jsonPath("$.duplicate").value(false));
		mockMvc.perform(post(webhookPath).queryParam("k", queryParam(webhookQuery, "k"))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"tg-1","payload":{"text":"hi again"}}
								"""))
				.andExpect(status().isAccepted())
				.andExpect(jsonPath("$.duplicate").value(true));

		// 宿主按游标拉取，只看到一条
		MvcResult firstPull = mockMvc.perform(get("/api/hosts/me/messages")
						.header("Authorization", primaryBearer)
						.param("since", "0"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.messages.length()").value(1))
				.andExpect(jsonPath("$.messages[0].payload.text").value("hi"))
				.andExpect(jsonPath("$.messages[0].bindingId").value(bindingId))
				.andReturn();
		long firstMessage = json(firstPull).get("revision").asLong();
		mockMvc.perform(get("/api/hosts/me/messages")
						.header("Authorization", primaryBearer)
						.param("since", String.valueOf(firstMessage)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.messages.length()").value(0));

		// 换宿主：只影响之后的消息
		JsonNode backup = enroll(owner, "server");
		long backupDevice = backup.get("device").get("id").asLong();
		String backupBearer = "Bearer " + backup.get("token").asString();
		mockMvc.perform(put("/api/hosts/me")
						.header("Authorization", backupBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"name":"ctrl-02","version":"0.2.0"}
								"""))
				.andExpect(status().isOk());

		mockMvc.perform(post("/api/channels/bindings/" + bindingId + "/reassign")
						.header("Authorization", primaryBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"hostDeviceId":%d}
								""".formatted(backupDevice)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.hostDeviceId").value(backupDevice));

		mockMvc.perform(post(webhookPath).queryParam("k", queryParam(webhookQuery, "k"))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"tg-2","payload":{"text":"after move"}}
								"""))
				.andExpect(status().isAccepted());

		// 迁移之后历史未读跟着走：新宿主看到两条，旧宿主看不到
		mockMvc.perform(get("/api/hosts/me/messages")
						.header("Authorization", backupBearer)
						.param("since", "0"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.messages.length()").value(2))
				.andExpect(jsonPath("$.messages[1].externalId").value("tg-2"));

		mockMvc.perform(get("/api/hosts/me/messages")
						.header("Authorization", primaryBearer)
						.param("since", "0"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.messages.length()").value(0));

		// 解绑后 webhook 直接 404
		mockMvc.perform(delete("/api/channels/bindings/" + bindingId)
						.header("Authorization", primaryBearer))
				.andExpect(status().isNoContent());
		mockMvc.perform(post(webhookPath).queryParam("k", queryParam(webhookQuery, "k"))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"tg-3","payload":{}}
								"""))
				.andExpect(status().isNotFound());
	}

	@Test
	void bindingStateMachineAndHostFailover() throws Exception {
		String owner = "failover@grey.local";
		JsonNode a = enroll(owner, "server");
		JsonNode b = enroll(owner, "server");
		String bearerA = "Bearer " + a.get("token").asString();
		long deviceA = a.get("device").get("id").asLong();
		long deviceB = b.get("device").get("id").asLong();

		for (String bearer : new String[] { bearerA, "Bearer " + b.get("token").asString() }) {
			mockMvc.perform(put("/api/hosts/me")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"name":"host","version":"0.3.0"}
									"""))
					.andExpect(status().isOk());
		}

		MvcResult bound = mockMvc.perform(post("/api/channels/bindings")
						.header("Authorization", bearerA)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"platform":"discord","accountRef":"grey#1234"}
								"""))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.binding.hostDeviceId").value(deviceA))
				.andExpect(jsonPath("$.binding.status").value("active"))
				.andReturn();
		long bindingId = json(bound).get("binding").get("id").asLong();
		URI webhook = URI.create(json(bound).get("webhookUrl").asString());
		String path = webhook.getPath();
		String key = queryParam(webhook.getQuery(), "k");

		// 手动停用：webhook 拒收，宿主清单里也不再有它
		mockMvc.perform(post("/api/channels/bindings/" + bindingId + "/disable")
						.header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("disabled"));
		mockMvc.perform(post(path).queryParam("k", key)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"x-1","payload":{}}
								"""))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("binding_disabled"));
		mockMvc.perform(get("/api/hosts/me/bindings").header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(0));

		// 重新启用
		mockMvc.perform(post("/api/channels/bindings/" + bindingId + "/enable")
						.header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("active"))
				.andExpect(jsonPath("$.hostAlive").value(true));
		mockMvc.perform(get("/api/hosts/me/bindings").header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1));

		// 宿主 A 掉线（Redis 心跳过期）→ 状态降级
		redis.delete("grey:host:" + deviceA);
		mockMvc.perform(get("/api/channels/bindings").header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].status").value("degraded"))
				.andExpect(jsonPath("$[0].hostAlive").value(false));

		// 新消息自动接管到还活着的 B
		mockMvc.perform(post(path).queryParam("k", key)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"dc-1","payload":{"text":"who is there"}}
								"""))
				.andExpect(status().isAccepted())
				.andExpect(jsonPath("$.hostDeviceId").value(deviceB));
		mockMvc.perform(get("/api/channels/bindings").header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].hostDeviceId").value(deviceB))
				.andExpect(jsonPath("$[0].status").value("active"));

		mockMvc.perform(get("/api/hosts/me/messages")
						.header("Authorization", "Bearer " + b.get("token").asString())
						.param("since", "0"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.messages.length()").value(1))
				.andExpect(jsonPath("$.messages[0].payload.text").value("who is there"));

		// 全部宿主都不在线：消息照样收下（落库排队），状态保持 degraded
		redis.delete("grey:host:" + deviceB);
		mockMvc.perform(post(path).queryParam("k", key)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"externalId":"dc-2","payload":{"text":"anyone"}}
								"""))
				.andExpect(status().isAccepted())
				.andExpect(jsonPath("$.hostDeviceId").value(deviceB));
		mockMvc.perform(get("/api/channels/bindings").header("Authorization", bearerA))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].status").value("degraded"));
	}

	@Test
	void llmGatewayProxiesAndMetersUsage() throws Exception {
		com.sun.net.httpserver.HttpServer upstream = com.sun.net.httpserver.HttpServer
				.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
		upstream.createContext("/v1/chat/completions", exchange -> {
			try {
				String body = new String(exchange.getRequestBody().readAllBytes(),
						java.nio.charset.StandardCharsets.UTF_8);
				if (!"Bearer sk-stub".equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
					exchange.sendResponseHeaders(401, -1);
					exchange.close();
					return;
				}
				byte[] payload;
				if (body.contains("\"stream\":true")) {
					exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
					payload = ("""
							data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}
							
							data: {"id":"1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}
							
							data: [DONE]
							
							""").getBytes(java.nio.charset.StandardCharsets.UTF_8);
				}
				else {
					exchange.getResponseHeaders().add("Content-Type", "application/json");
					payload = ("""
							{"id":"1","model":"stub-model","choices":[{"index":0,"message":{"role":"assistant",
							 "content":"stub ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,
							 "total_tokens":15}}
							""").getBytes(java.nio.charset.StandardCharsets.UTF_8);
				}
				exchange.sendResponseHeaders(200, payload.length);
				exchange.getResponseBody().write(payload);
				exchange.close();
			}
			catch (Exception ex) {
				throw new RuntimeException(ex);
			}
		});
		upstream.start();
		int port = upstream.getAddress().getPort();

		try {
			String bearer = "Bearer " + enroll("llm@grey.local", "desktop").get("token").asString();

			mockMvc.perform(post("/api/llm/keys")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"provider":"custom","label":"stub","baseUrl":"http://127.0.0.1:%d/v1",
									 "apiKey":"sk-stub"}
									""".formatted(port)))
					.andExpect(status().isCreated())
					.andExpect(jsonPath("$.baseUrl").value("http://127.0.0.1:" + port + "/v1"))
					.andExpect(jsonPath("$.apiKey").doesNotExist());

			mockMvc.perform(get("/api/llm/keys").header("Authorization", bearer))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.length()").value(1))
					.andExpect(jsonPath("$[0].label").value("stub"));

			// 非流式：正文透传
			mockMvc.perform(post("/v1/chat/completions")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"model":"stub-model","messages":[{"role":"user","content":"hi"}]}
									"""))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.choices[0].message.content").value("stub ok"))
					.andExpect(result -> org.assertj.core.api.Assertions
							.assertThat(result.getResponse().getHeader("X-Grey-Key-Id")).isNotBlank());

			// 流式：SSE 透传
			MvcResult streamed = mockMvc.perform(post("/v1/chat/completions")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"model":"stub-model","stream":true,"messages":[{"role":"user","content":"hi"}]}
									"""))
					.andExpect(status().isOk())
					.andExpect(result -> org.assertj.core.api.Assertions
							.assertThat(result.getResponse().getContentType())
							.contains("text/event-stream"))
					.andReturn();
			assertThat(streamed.getResponse().getContentAsString())
					.contains("data: [DONE]")
					.contains("\"content\":\"hi\"");

			// 用量记账：15 + 10
			mockMvc.perform(get("/api/llm/usage").header("Authorization", bearer))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.requests").value(2))
					.andExpect(jsonPath("$.totalTokens").value(25))
					.andExpect(jsonPath("$.completionTokens").value(8));

			// 指定了没配密钥的供应商 → 409
			mockMvc.perform(post("/v1/chat/completions")
							.header("Authorization", bearer)
							.header("X-Grey-Provider", "openai")
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"model":"x","messages":[]}
									"""))
					.andExpect(status().isConflict())
					.andExpect(jsonPath("$.code").value("no_llm_key"));

			// 第 4 次触顶（rpm-limit=3）
			mockMvc.perform(post("/v1/chat/completions")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"model":"x","messages":[]}
									"""))
					.andExpect(status().isTooManyRequests())
					.andExpect(jsonPath("$.code").value("rate_limited"));
		}
		finally {
			upstream.stop(0);
		}
	}

	@Test
	void marketPublishesSignedRegistryWithRollout() throws Exception {
		String bearer = "Bearer " + enroll("market@grey.local", "desktop").get("token").asString();
		String sha = "a".repeat(64);
		String downloadUrl = "https://github.com/jean3690/greywork-plugin-market/releases/download/v1/demo.zip";

		mockMvc.perform(post("/api/market/packages")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"slug":"demo.market","name":"Demo Market","author":"jean",
								 "summary":"演示插件","category":"demo","tags":["a","b"]}
								"""))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.status").value("draft"))
				.andExpect(jsonPath("$.tags.length()").value(2));

		// 宿主侧会拒绝的版本 / 地址：这里也必须拒绝
		mockMvc.perform(post("/api/market/packages/demo.market/versions")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"version":"1.0","downloadUrl":"%s","sha256":"%s"}
								""".formatted(downloadUrl, sha)))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("market_version_invalid"));
		mockMvc.perform(post("/api/market/packages/demo.market/versions")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"version":"1.0.0","downloadUrl":"https://example.com/p.zip","sha256":"%s"}
								""".formatted(sha)))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("market_url_host_rejected"));

		mockMvc.perform(post("/api/market/packages/demo.market/versions")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"version":"1.0.0","downloadUrl":"%s","sha256":"%s","rolloutPercent":100}
								""".formatted(downloadUrl, sha)))
				.andExpect(status().isCreated());
		mockMvc.perform(post("/api/market/packages/demo.market/versions")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"version":"1.1.0","downloadUrl":"%s","sha256":"%s","rolloutPercent":50}
								""".formatted(downloadUrl, sha)))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.channel").value("stable"));

		// 非发布者不能动别人的包
		mockMvc.perform(post("/api/market/packages/demo.market/versions")
						.header("Authorization", "Bearer "
								+ enroll("intruder@grey.local", "desktop").get("token").asString())
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"version":"2.0.0","downloadUrl":"%s","sha256":"%s"}
								""".formatted(downloadUrl, sha)))
				.andExpect(status().isForbidden());

		// draft 不上架，搜索不到
		mockMvc.perform(get("/api/market/packages").param("q", "Demo"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.total").value(0));

		mockMvc.perform(post("/api/market/packages/demo.market/status")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"status":"published"}
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("published"));

		mockMvc.perform(get("/api/market/packages").param("q", "Demo"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.total").value(1))
				.andExpect(jsonPath("$.items[0].slug").value("demo.market"));

		// 灰度：bucket 0 拿到 1.1.0，bucket 90 退回 1.0.0
		MvcResult full = mockMvc.perform(get("/api/market/registry.json").param("bucket", "0"))
				.andExpect(status().isOk())
				.andExpect(result -> org.assertj.core.api.Assertions
						.assertThat(result.getResponse().getContentType())
						.contains("application/json"))
				.andReturn();
		String body = full.getResponse().getContentAsString();
		// signature 是最后一个字段，被签的消息还要带上根对象的右花括号
		String unsigned = body.substring(0, body.indexOf(",\"signature\":\"")) + "}";
		assertThat(unsigned).isEqualTo("{\"schemaVersion\":1,\"plugins\":[{\"id\":\"demo.market\","
				+ "\"name\":\"Demo Market\",\"version\":\"1.1.0\","
				+ "\"description\":\"演示插件\",\"author\":\"jean\","
				+ "\"downloadUrl\":\"" + downloadUrl + "\",\"sha256\":\"" + sha + "\"}]}");

		// 签名必须能用公钥验过（等价于宿主侧 ed25519 校验）
		String signature = body.substring(body.indexOf(",\"signature\":\"")
				+ ",\"signature\":\"".length(), body.length() - 2);
		java.security.Signature verifier = java.security.Signature.getInstance("Ed25519");
		verifier.initVerify(MARKET_KEYS.getPublic());
		verifier.update(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8));
		assertThat(verifier.verify(java.util.Base64.getDecoder().decode(signature))).isTrue();

		mockMvc.perform(get("/api/market/registry.json").param("bucket", "90"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.plugins[0].version").value("1.0.0"));

		// ETag 命中返回 304
		String etag = full.getResponse().getHeader("ETag");
		mockMvc.perform(get("/api/market/registry.json").param("bucket", "0")
						.header("If-None-Match", etag))
				.andExpect(status().isNotModified());
		mockMvc.perform(get("/api/market/registry.json").param("bucket", "90"))
				.andExpect(result -> org.assertj.core.api.Assertions.assertThat(result.getResponse().getHeader("ETag"))
						.isNotEqualTo(etag));

		// 下载走 302 并计数
		mockMvc.perform(get("/api/market/download/demo.market/1.0.0"))
				.andExpect(status().isFound())
				.andExpect(result -> org.assertj.core.api.Assertions.assertThat(
						result.getResponse().getHeader("Location")).isEqualTo(downloadUrl));
		mockMvc.perform(get("/api/market/packages/demo.market"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.versions[?(@.version=='1.0.0')].downloads").value(
						org.hamcrest.Matchers.contains(1)));
	}

	@Test
	void oidcLoginIssuesTokenThroughOneTimeTicket() throws Exception {
		mockMvc.perform(get("/api/auth/oidc/providers"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.stub").value(true));

		// 未知身份源 / 未在白名单的跳转地址
		mockMvc.perform(get("/api/auth/oidc/nope/authorize").param("redirect", "http://127.0.0.1:9999/cb"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.code").value("oidc_provider_unavailable"));
		mockMvc.perform(get("/api/auth/oidc/stub/authorize").param("redirect", "https://evil.example/cb"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("oidc_redirect_denied"));

		String first = login("Mac", "desktop");
		String second = login("Pixel", "mobile");
		assertThat(first).isEqualTo(second);
	}

	/** 走完 authorize → callback → exchange，返回用户 id。 */
	private String login(String deviceName, String platform) throws Exception {
		MvcResult started = mockMvc.perform(get("/api/auth/oidc/stub/authorize")
						.param("redirect", "http://127.0.0.1:9999/cb")
						.param("deviceName", deviceName)
						.param("platform", platform))
				.andExpect(status().isFound())
				.andReturn();
		String authorizeLocation = started.getResponse().getHeader("Location");
		assertThat(authorizeLocation).startsWith(idpBase() + "/authorize");
		String state = queryParam(URI.create(authorizeLocation).getQuery(), "state");

		MvcResult callback = mockMvc.perform(get("/api/auth/oidc/stub/callback")
						.param("code", "good-code")
						.param("state", state))
				.andExpect(status().isFound())
				.andReturn();
		String redirect = callback.getResponse().getHeader("Location");
		assertThat(redirect).startsWith("http://127.0.0.1:9999/cb?ticket=");
		String ticket = queryParam(URI.create(redirect).getQuery(), "ticket");

		MvcResult exchanged = mockMvc.perform(post("/api/auth/oidc/exchange")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"ticket":"%s"}
								""".formatted(ticket)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.user.email").value("oidc@grey.local"))
				.andExpect(jsonPath("$.user.displayName").value("Oidc User"))
				.andExpect(jsonPath("$.device.name").value(deviceName))
				.andExpect(jsonPath("$.device.platform").value(platform))
				.andReturn();
		JsonNode session = json(exchanged);
		String token = session.get("token").asString();

		mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.user.email").value("oidc@grey.local"));

		// 票是一次性的
		mockMvc.perform(post("/api/auth/oidc/exchange")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"ticket":"%s"}
								""".formatted(ticket)))
				.andExpect(status().isUnauthorized());

		// state 伪造
		mockMvc.perform(get("/api/auth/oidc/stub/callback")
						.param("code", "good-code")
						.param("state", "forged"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("oidc_state_invalid"));

		return session.get("user").get("id").asString();
	}

	private JsonNode enroll(String email, String platform) throws Exception {
		MvcResult result = mockMvc.perform(post("/api/auth/enroll")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"code":"%s","email":"%s","deviceName":"test","platform":"%s"}
								""".formatted(newCode(), email, platform)))
				.andExpect(status().isCreated())
				.andReturn();
		return json(result);
	}

	private String newCode() {
		String raw = "CODE-" + UUID.randomUUID();
		EnrollmentCode code = new EnrollmentCode();
		code.setCodeHash(Hashes.sha256Hex(raw));
		code.setExpiresAt(LocalDateTime.now().plusHours(1));
		enrollmentCodeMapper.insert(code);
		return raw;
	}

	private JsonNode json(MvcResult result) throws Exception {
		return objectMapper.readTree(result.getResponse().getContentAsString());
	}

	private static String queryParam(String query, String name) {
		for (String pair : query.split("&")) {
			String[] parts = pair.split("=", 2);
			if (parts[0].equals(name)) {
				return parts[1];
			}
		}
		throw new IllegalStateException("missing query param: " + name);
	}

}
