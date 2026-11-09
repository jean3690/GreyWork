package com.jean.grey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.common.Hashes;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
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
		"grey.llm.rpm-limit=3",
		// 运维面测试的固定管理员（RolePolicy 在登录时按名单定角色）。
		"grey.auth.admin-emails=Admin@Grey.local,ops@grey.local",
		// 启动时给名单里的账号种密码；ops@grey.local 专门用来验密码登录（不与 enroll 测试抢设备额度）。
		"grey.auth.admin-password=AdminPass123",
		// 设备上限调小，才能在测试里几轮登录就触发淘汰。
		"grey.auth.max-devices=3"
})
@AutoConfigureMockMvc
class ControlPlaneApiTest {

	@Container
	@ServiceConnection
	static final MySQLContainer MYSQL = new MySQLContainer("mysql:8.4");

	@Container
	static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
			.withExposedPorts(6379);

	@Container
	static final GenericContainer<?> RUSTFS = new GenericContainer<>("rustfs/rustfs:latest")
			.withEnv("RUSTFS_ACCESS_KEY", "greytest")
			.withEnv("RUSTFS_SECRET_KEY", "greytest-secret")
			.withExposedPorts(9000);

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
	static void storageProperties(DynamicPropertyRegistry registry) {
		registry.add("grey.storage.enabled", () -> "true");
		registry.add("grey.storage.endpoint",
				() -> "http://" + RUSTFS.getHost() + ":" + RUSTFS.getMappedPort(9000));
		registry.add("grey.storage.access-key", () -> "greytest");
		registry.add("grey.storage.secret-key", () -> "greytest-secret");
		registry.add("grey.storage.bucket", () -> "greywork-test");
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
	org.springframework.jdbc.core.JdbcTemplate jdbc;

	@Autowired
	EnrollmentCodeMapper enrollmentCodeMapper;

	@Autowired
	AppUserMapper appUserMapper;

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
	@Autowired
	com.jean.grey.automation.AutomationScheduler automationScheduler;

	@Autowired
	com.jean.grey.automation.mapper.AutomationTaskMapper automationTaskMapper;

	@Test
	void automationCronTaskFlowsThroughHostClaim() throws Exception {
		JsonNode session = enroll("auto@grey.local", "server");
		String bearer = "Bearer " + session.get("token").asString();

		// cron 非法被拒
		mockMvc.perform(post("/api/automation/tasks")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"name":"bad","cronExpr":"99 * * * *","intent":"hi","execution":"host","enabled":true}
						"""))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("cron_invalid"));

		MvcResult created = mockMvc.perform(post("/api/automation/tasks")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"name":"daily","cronExpr":"@daily","intent":"report weather","execution":"host","enabled":true}
						"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.id").isNotEmpty())
				.andExpect(jsonPath("$.cronExpr").value("0 0 * * *"))
				.andExpect(jsonPath("$.nextRunAt").isNotEmpty())
				.andReturn();
		String taskId = json(created).get("id").asString();

		// 预览：@daily 未来 5 个触发点
		mockMvc.perform(post("/api/automation/tasks/preview")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"task":{"name":"p","cronExpr":"@daily","intent":"x","execution":"host","enabled":true}}
						"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(5));

		// 未注册宿主认领会被心跳挡下（host_not_found）
		mockMvc.perform(post("/api/hosts/me/automation/claim")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"limit":10}
								"""))
				.andExpect(status().isNotFound());

		// 把 next_run_at 拨到当下，触发调度
		com.jean.grey.automation.entity.AutomationTask due = automationTaskMapper
					.selectOne(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<com.jean.grey.automation.entity.AutomationTask>()
								.eq(com.jean.grey.automation.entity.AutomationTask::getId, taskId));
		due.setNextRunAt(LocalDateTime.now().minusSeconds(1));
		automationTaskMapper.updateById(due);
		automationScheduler.tick();

		// 注册宿主后认领
		mockMvc.perform(put("/api/hosts/me")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
							{"name":"host-1","version":"1.0.0","capabilities":[]}
							"""))
				.andExpect(status().isOk());

		MvcResult claimed = mockMvc.perform(post("/api/hosts/me/automation/claim")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
							{"limit":10}
							"""))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.length()").value(1))
				.andReturn();
		long dueId = json(claimed).get(0).get("id").asLong();
		assertThat(json(claimed).get(0).get("intent").asString()).isEqualTo("report weather");

		// 再认领一次应为空（没有新的到期）
		mockMvc.perform(post("/api/hosts/me/automation/claim")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
							{"limit":10}
							"""))
					.andExpect(jsonPath("$.length()").value(0));

		// 回执
		mockMvc.perform(post("/api/hosts/me/automation/due/" + dueId + "/finish")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"status":"ok","detail":"done","output":"all good"}
						"""))
				.andExpect(status().isOk());

		MvcResult runs = mockMvc.perform(get("/api/automation/tasks/runs")
					.header("Authorization", bearer)
					.param("taskId", taskId))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1))
				.andReturn();
		JsonNode run = json(runs).get(0);
		assertThat(run.get("mode").asString()).isEqualTo("host");
		assertThat(run.get("status").asString()).isEqualTo("ok");
		assertThat(run.get("output").asString()).isEqualTo("all good");

		// cron 游标已推进，lastRunAt 有值
		MvcResult tasks = mockMvc.perform(get("/api/automation/tasks")
					.header("Authorization", bearer))
				.andReturn();
		JsonNode task = json(tasks).get(0);
		assertThat(task.get("lastRunAt")).isNotNull();
		assertThat(task.get("enabled").asBoolean()).isTrue();
		assertThat(task.get("nextRunAt")).isNotNull();
	}

	@Test
	void automationOnceTaskDisablesAfterFire() throws Exception {
		JsonNode session = enroll("once@grey.local", "desktop");
		String bearer = "Bearer " + session.get("token").asString();

		MvcResult created = mockMvc.perform(post("/api/automation/tasks")
					.header("Authorization", bearer)
					.contentType(MediaType.APPLICATION_JSON)
					.content(("""
							{"name":"once","intent":"nap","execution":"host","enabled":true,"onceAt":"%s"}
							""").formatted(LocalDateTime.now().plusSeconds(1))))
				.andExpect(status().isOk())
				.andReturn();
		String taskId = json(created).get("id").asString();

		Thread.sleep(1100);
		automationScheduler.tick();

		MvcResult tasks = mockMvc.perform(get("/api/automation/tasks")
					.header("Authorization", bearer))
				.andReturn();
		JsonNode task = json(tasks).get(0);
		assertThat(task.get("enabled").asBoolean()).isFalse();
		assertThat(task.get("nextRunAt").isNull()).isTrue();
	}

	@Test
	void automationCloudExecutionWritesRun() throws Exception {
		JsonNode session = enroll("cloudauto@grey.local", "desktop");
		String bearer = "Bearer " + session.get("token").asString();

		var stub = com.sun.net.httpserver.HttpServer
					.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
		byte[] reply = ("{\"choices\":[{\"message\":{\"content\":\"cloud-ok\"}}],"
					+ "\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}")
				.getBytes(java.nio.charset.StandardCharsets.UTF_8);
		stub.createContext("/chat/completions", exchange -> {
			exchange.getRequestBody().readAllBytes();
			exchange.getResponseHeaders().add("Content-Type", "application/json");
			exchange.sendResponseHeaders(200, reply.length);
			exchange.getResponseBody().write(reply);
			exchange.close();
		});
		stub.start();
		try {
			String stubBase = "http://127.0.0.1:" + stub.getAddress().getPort();
			mockMvc.perform(post("/api/llm/keys")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content(("""
							{"provider":"openai","label":"stub","baseUrl":"%s","apiKey":"sk-test"}
							""").formatted(stubBase)))
					.andExpect(status().isCreated());

			MvcResult created = mockMvc.perform(post("/api/automation/tasks")
							.header("Authorization", bearer)
							.contentType(MediaType.APPLICATION_JSON)
							.content(("""
								{"name":"cloud","intent":"say hi","execution":"cloud","model":"gpt-test","enabled":true,"onceAt":"%s"}
								""").formatted(LocalDateTime.now().plusSeconds(1))))
							.andExpect(status().isOk())
							.andReturn();
			String taskId = json(created).get("id").asString();

			Thread.sleep(1100);
			automationScheduler.tick();

			// 云端执行走虚拟线程，轮询等待结果落库
			JsonNode run = null;
			for (int i = 0; i < 50; i++) {
				MvcResult runs = mockMvc.perform(get("/api/automation/tasks/runs")
								.header("Authorization", bearer)
								.param("taskId", taskId))
								.andReturn();
				if (json(runs).size() > 0 && json(runs).get(0).hasNonNull("finishedAt")) {
					run = json(runs).get(0);
					break;
				}
				Thread.sleep(100);
			}
			assertThat(run).as("云端执行应产出运行记录").isNotNull();
			assertThat(run.get("mode").asString()).isEqualTo("cloud");
			assertThat(run.get("status").asString()).isEqualTo("ok");
			assertThat(run.get("output").asString()).isEqualTo("cloud-ok");
		}
		finally {
			stub.stop(0);
		}
	}

	@Test
	void storagePresignedRoundTrip() throws Exception {
		JsonNode session = enroll("storage@grey.local", "desktop");
		String bearer = "Bearer " + session.get("token").asString();

		mockMvc.perform(get("/api/storage/config").header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.enabled").value(true))
				.andExpect(jsonPath("$.bucket").value("greywork-test"));

		MvcResult created = mockMvc.perform(post("/api/storage/uploads")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"name":"hello world.txt","contentType":"text/plain","sizeBytes":11}
								"""))
				.andExpect(status().isOk())
				.andReturn();
		JsonNode ticket = json(created);
		long objectId = ticket.get("id").asLong();
		assertThat(ticket.get("uploadUrl").asString()).contains("greywork-test");

		byte[] payload = "hello world".getBytes(java.nio.charset.StandardCharsets.UTF_8);
		var client = java.net.http.HttpClient.newHttpClient();
		var put = java.net.http.HttpRequest
				.newBuilder(URI.create(ticket.get("uploadUrl").asString()))
				.header("Content-Type", "text/plain")
				.PUT(java.net.http.HttpRequest.BodyPublishers.ofByteArray(payload))
				.build();
		var putResponse = client.send(put, java.net.http.HttpResponse.BodyHandlers.ofString());
		assertThat(putResponse.statusCode()).as("预签名 PUT 应成功").isEqualTo(200);

		mockMvc.perform(post("/api/storage/objects/" + objectId + "/complete")
						.header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ready"));

		// 大小谎报会被 complete 拦下
		MvcResult lying = mockMvc.perform(post("/api/storage/uploads")
						.header("Authorization", bearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"name":"liar.bin","contentType":"application/octet-stream","sizeBytes":5}
								"""))
				.andReturn();
		long liarId = json(lying).get("id").asLong();
		// 真的上传 11 字节，再按声明的 5 字节去 complete → 大小不一致
		var liarPut = java.net.http.HttpRequest
				.newBuilder(URI.create(json(lying).get("uploadUrl").asString()))
				.header("Content-Type", "application/octet-stream")
				.PUT(java.net.http.HttpRequest.BodyPublishers.ofByteArray(payload))
				.build();
		client.send(liarPut, java.net.http.HttpResponse.BodyHandlers.ofString());
		mockMvc.perform(post("/api/storage/objects/" + liarId + "/complete")
						.header("Authorization", bearer))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("size_mismatch"));

		MvcResult dl = mockMvc.perform(get("/api/storage/objects/" + objectId + "/download")
						.header("Authorization", bearer))
				.andExpect(status().isOk())
				.andReturn();
		String url = json(dl).get("url").asString();
		var get = java.net.http.HttpRequest.newBuilder(URI.create(url)).GET().build();
		var getResponse = client.send(get, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
		assertThat(getResponse.statusCode()).as("预签名 GET 应成功").isEqualTo(200);
		assertThat(getResponse.body()).isEqualTo(payload);

		// 未确认对象不允许下载
		mockMvc.perform(get("/api/storage/objects/" + liarId + "/download")
						.header("Authorization", bearer))
				.andExpect(status().isBadRequest());

		// 越权访问
		JsonNode other = enroll("storage2@grey.local", "desktop");
		mockMvc.perform(get("/api/storage/objects/" + objectId)
						.header("Authorization", "Bearer " + other.get("token").asString()))
				.andExpect(status().isNotFound());

		// 删除后消失
		mockMvc.perform(delete("/api/storage/objects/" + objectId)
						.header("Authorization", bearer))
				.andExpect(status().isOk());
		mockMvc.perform(get("/api/storage/objects/" + objectId)
						.header("Authorization", bearer))
				.andExpect(status().isNotFound());
		client.close();
	}

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


	/**
	 * 禁用账号必须同时挡住两件事：手上没到期的 token 立刻失效，重新登录也进不来。
	 * 以前 status / deleted_at 只有字段没有读者，禁用等于没禁用。
	 */
	@Test
	void disabledUserLosesSessionAndCannotEnrollAgain() throws Exception {
		JsonNode session = enroll("disabled@grey.local", "desktop");
		String token = session.get("token").asString();
		Long userId = session.get("user").get("id").asLong();

		AppUser user = appUserMapper.selectById(userId);
		user.setStatus("disabled");
		appUserMapper.updateById(user);

		mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isUnauthorized());

		mockMvc.perform(post("/api/auth/enroll")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"code":"%s","email":"disabled@grey.local","deviceName":"second","platform":"server"}
								""".formatted(newCode())))
				.andExpect(status().isForbidden())
				.andExpect(jsonPath("$.code").value("user_disabled"));
	}

	/** 同一邮箱的不同大小写写法必须落到同一个账号（否则设备 / 同步 / 配额会按 user 分家）。 */
	@Test
	void emailIsNormalizedAcrossLogins() throws Exception {
		JsonNode first = enroll("Case.User@Grey.Local", "desktop");
		JsonNode second = enroll("case.user@grey.local", "phone");

		assertThat(second.get("user").get("id").asLong())
				.isEqualTo(first.get("user").get("id").asLong());
		assertThat(second.get("user").get("email").asString()).isEqualTo("case.user@grey.local");
		assertThat(appUserMapper.selectById(first.get("user").get("id").asLong()).getEmail())
				.isEqualTo("case.user@grey.local");
	}

	/** 连续失败到阈值后先 429；成功一次会清零，所以正常用户不会被误伤。 */
	@Test
	void enrollFailuresAreRateLimited() throws Exception {
		String client = "127.0.0.1";
		redis.delete("grey:auth:enroll-fail:" + client);

		try {
			for (int attempt = 0; attempt < 10; attempt++) {
				mockMvc.perform(post("/api/auth/enroll")
								.contentType(MediaType.APPLICATION_JSON)
								.content("""
										{"code":"WRONG-CODE","email":"brute@grey.local","deviceName":"x","platform":"server"}
										"""))
						.andExpect(status().isUnauthorized());
			}
			mockMvc.perform(post("/api/auth/enroll")
							.contentType(MediaType.APPLICATION_JSON)
							.content("""
									{"code":"WRONG-CODE","email":"brute@grey.local","deviceName":"x","platform":"server"}
									"""))
					.andExpect(status().isTooManyRequests())
					.andExpect(jsonPath("$.code").value("enroll_rate_limited"));
		}
		finally {
			redis.delete("grey:auth:enroll-fail:" + client);
		}
	}



	/** 运维台页面公开可取（不含数据），数据接口仍然要管理员。 */
	@Test
	void adminConsoleIsPublicButItsDataIsNot() throws Exception {
		MvcResult page = mockMvc.perform(get("/admin")).andExpect(status().isOk()).andReturn();
		// 页面本身可公开取到（数据面仍然要管理员，见下一条断言）。
		assertThat(page.getResponse().getContentType()).startsWith("text/html");
		assertThat(page.getResponse().getContentAsString()).contains("GreyWork 运维台");
		mockMvc.perform(get("/admin/index.html")).andExpect(status().isOk());
		mockMvc.perform(get("/api/admin/users"))
				.andExpect(status().isUnauthorized());
	}

	// ---------- 运维面（/api/admin/**）：角色门禁 + 用户管理 + 入场码签发 ----------

	private static final String ADMIN_EMAIL = "admin@grey.local";

	private String adminToken() throws Exception {
		return enroll(ADMIN_EMAIL, "server").get("token").asString();
	}

	private String bearerOf(JsonNode session) {
		return "Bearer " + session.get("token").asString();
	}

	@Test
	void adminEndpointsRequireAdminRole() throws Exception {
		JsonNode member = enroll("member@grey.local", "desktop");
		mockMvc.perform(get("/api/admin/users").header("Authorization", bearerOf(member)))
				.andExpect(status().isForbidden());
		mockMvc.perform(post("/api/admin/enroll-codes").header("Authorization", bearerOf(member)))
				.andExpect(status().isForbidden());

		JsonNode admin = enroll(ADMIN_EMAIL, "server");
		// 名单命中的账号在登录时就拿到 admin 角色（大小写不敏感）。
		assertThat(admin.get("user").get("role").asString()).isEqualTo("admin");
		mockMvc.perform(get("/api/admin/users").header("Authorization", bearerOf(admin)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[?(@.email=='" + ADMIN_EMAIL + "')]").isNotEmpty());
	}

	@Test
	void adminCanDisableUserButNotThemselves() throws Exception {
		JsonNode victim = enroll("victim@grey.local", "desktop");
		long victimId = victim.get("user").get("id").asLong();
		JsonNode admin = enroll(ADMIN_EMAIL, "server");

		mockMvc.perform(patch("/api/admin/users/" + victimId)
						.header("Authorization", bearerOf(admin))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"status":"disabled"}
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("disabled"));

		// 禁用即连坐：手上没过期的 token 立刻失效。
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(victim)))
				.andExpect(status().isUnauthorized());

		long adminId = admin.get("user").get("id").asLong();
		mockMvc.perform(patch("/api/admin/users/" + adminId)
						.header("Authorization", bearerOf(admin))
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"status":"disabled"}
								"""))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("cannot_disable_self"));
	}

	@Test
	void adminCanIssueAndRevokeEnrollmentCodes() throws Exception {
		String adminBearer = "Bearer " + adminToken();

		MvcResult issued = mockMvc.perform(post("/api/admin/enroll-codes")
						.header("Authorization", adminBearer)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"expiresInHours":2}
								"""))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.item.status").value("active"))
				.andReturn();
		JsonNode payload = json(issued);
		String code = payload.get("code").asString();
		long codeId = payload.get("item").get("id").asLong();
		// 列表只回哈希前缀（8 位），不回明文。
		mockMvc.perform(get("/api/admin/enroll-codes").header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].hashPrefix").isString())
				.andExpect(jsonPath("$[0].code").doesNotExist());

		// 签发的码能直接登录。
		mockMvc.perform(post("/api/auth/enroll")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"code":"%s","email":"issued@grey.local","deviceName":"d","platform":"server"}
								""".formatted(code)))
				.andExpect(status().isCreated());

		// 已用过的码不能撤销（审计线索）；未用过的可以，撤销后即失效。
		mockMvc.perform(delete("/api/admin/enroll-codes/" + codeId).header("Authorization", adminBearer))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("enroll_code_used"));

		MvcResult spare = mockMvc.perform(post("/api/admin/enroll-codes").header("Authorization", adminBearer))
				.andExpect(status().isCreated())
				.andReturn();
		JsonNode sparePayload = json(spare);
		mockMvc.perform(delete("/api/admin/enroll-codes/" + sparePayload.get("item").get("id").asLong())
						.header("Authorization", adminBearer))
				.andExpect(status().isNoContent());
		mockMvc.perform(post("/api/auth/enroll")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"code":"%s","email":"revoked@grey.local","deviceName":"d","platform":"server"}
								""".formatted(sparePayload.get("code").asString())))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void adminCanKickSessionsWithoutDisablingTheAccount() throws Exception {
		JsonNode victim = enroll("kick@grey.local", "desktop");
		long victimId = victim.get("user").get("id").asLong();
		String adminBearer = "Bearer " + adminToken();

		mockMvc.perform(delete("/api/admin/users/" + victimId + "/sessions").header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.devices").value(1));

		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(victim)))
				.andExpect(status().isUnauthorized());
		// 账号本身仍可用：重新入场没有任何障碍。
		mockMvc.perform(post("/api/auth/enroll")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"code":"%s","email":"kick@grey.local","deviceName":"second","platform":"server"}
								""".formatted(newCode())))
				.andExpect(status().isCreated());
	}


	/** 会话是「空闲过期」而不是「登录后固定 30 天」：有活动就把 TTL 拉回满值。 */
	@Test
void activeSessionSlidesItsTtl() throws Exception {
		JsonNode session = enroll("slide@grey.local", "desktop");
		String token = session.get("token").asString();
		String key = "grey:sess:" + Hashes.sha256Hex(token);

		// 先人为压到 60 秒，模拟「离过期不远」；再发一次请求，应该被拉回 session-ttl。
		redis.expire(key, java.time.Duration.ofSeconds(60));
		mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk());
		assertThat(redis.getExpire(key, TimeUnit.SECONDS)).isGreaterThan(120);
	}

	/** 超过设备上限时淘汰最老的设备，并吊销它的会话（否则旧 token 还能继续用）。 */
	@Test
void oldestDevicesArePrunedBeyondTheCap() throws Exception {
		JsonNode oldest = enroll("cap@grey.local", "desktop");
		enroll("cap@grey.local", "phone");
		enroll("cap@grey.local", "tablet");
		JsonNode newest = enroll("cap@grey.local", "server");

		mockMvc.perform(get("/api/devices").header("Authorization", bearerOf(newest)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(3));
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(oldest)))
				.andExpect(status().isUnauthorized());
	}

	/** 用户自助「退出其他设备」：当前设备保留，其它设备的 token 立即失效。 */
	@Test
void userCanRevokeOtherSessionsButStaySignedIn() throws Exception {
		JsonNode current = enroll("self@grey.local", "desktop");
		JsonNode other = enroll("self@grey.local", "phone");

		mockMvc.perform(delete("/api/auth/sessions").header("Authorization", bearerOf(current)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.devices").value(1))
				.andExpect(jsonPath("$.currentRevoked").value(false));

		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(other)))
				.andExpect(status().isUnauthorized());
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(current)))
				.andExpect(status().isOk());
	}


	@Test
	void adminCanListAndRevokeSingleDevice() throws Exception {
		JsonNode victim = enroll("devuser@grey.local", "desktop");
		JsonNode second = enroll("devuser@grey.local", "phone");
		long victimId = victim.get("user").get("id").asLong();
		String adminBearer = "Bearer " + adminToken();

		mockMvc.perform(get("/api/admin/users/" + victimId + "/devices").header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(2));

		// 找出 victim 当前设备（用 victim 自己的 token 查 /api/devices 的 current 标记），只吊销那一台。
		JsonNode devices = json(mockMvc.perform(get("/api/devices")
				.header("Authorization", bearerOf(victim)))
				.andExpect(status().isOk()).andReturn());
		long currentDevice = -1;
		for (JsonNode d : devices) {
			if (d.get("current").asBoolean()) currentDevice = d.get("id").asLong();
		}
		mockMvc.perform(delete("/api/admin/users/" + victimId + "/devices/" + currentDevice)
				.header("Authorization", adminBearer))
				.andExpect(status().isOk());

		mockMvc.perform(get("/api/admin/users/" + victimId + "/devices").header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1));
		// 被吊销那台的会话立刻失效，另一台仍可用。
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(victim)))
				.andExpect(status().isUnauthorized());
		mockMvc.perform(get("/api/auth/me").header("Authorization", bearerOf(second)))
				.andExpect(status().isOk());
	}

	@Test
	void adminCanChangeUserRoleButNotSelf() throws Exception {
		JsonNode target = enroll("roleuser@grey.local", "desktop");
		long targetId = target.get("user").get("id").asLong();
		JsonNode admin = enroll(ADMIN_EMAIL, "server");
		long adminId = admin.get("user").get("id").asLong();
		String adminBearer = bearerOf(admin);

		// 非名单内账号可手动提成 admin，再降回 user。
		mockMvc.perform(patch("/api/admin/users/" + targetId)
				.header("Authorization", adminBearer)
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"role\":\"admin\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.role").value("admin"));
		mockMvc.perform(patch("/api/admin/users/" + targetId)
				.header("Authorization", adminBearer)
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"role\":\"user\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.role").value("user"));

		// 不能改自己的角色，避免把自己锁在运维面之外。
		mockMvc.perform(patch("/api/admin/users/" + adminId)
				.header("Authorization", adminBearer)
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"role\":\"user\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("cannot_change_own_role"));
	}

	@Test
	void adminUserDetailAggregatesDevicesAndProviders() throws Exception {
		JsonNode victim = enroll("detailuser@grey.local", "desktop");
		enroll("detailuser@grey.local", "phone");
		long victimId = victim.get("user").get("id").asLong();
		String adminBearer = "Bearer " + adminToken();
		mockMvc.perform(get("/api/admin/users/" + victimId + "/detail").header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.email").value("detailuser@grey.local"))
				.andExpect(jsonPath("$.deviceCount").value(2))
				.andExpect(jsonPath("$.providers").isArray());
	}

	@Test
	void adminAuditLogRecordsPrivilegedActions() throws Exception {
		JsonNode victim = enroll("audituser@grey.local", "desktop");
		long victimId = victim.get("user").get("id").asLong();
		String adminBearer = "Bearer " + adminToken();
		mockMvc.perform(patch("/api/admin/users/" + victimId)
				.header("Authorization", adminBearer)
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"status\":\"disabled\"}"))
				.andExpect(status().isOk());
		mockMvc.perform(get("/api/admin/audit?targetType=user&targetId=" + victimId)
				.header("Authorization", adminBearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[?(@.action=='user_disable')]").isNotEmpty());
	}

	@Test
	void adminAuditEndpointRequiresAdminRole() throws Exception {
		JsonNode member = enroll("auditmember@grey.local", "desktop");
		mockMvc.perform(get("/api/admin/audit").header("Authorization", bearerOf(member)))
				.andExpect(status().isForbidden());
	}

	// ---------- 运维台：账号密码登录 + 概览 / 资源端点 ----------

	@Test
	void adminConsoleLogsInWithPasswordAndSeesOverview() throws Exception {
		MvcResult login = mockMvc.perform(post("/api/admin/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("{\"email\":\"ops@grey.local\",\"password\":\"AdminPass123\"}"))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.user.role").value("admin"))
				.andExpect(jsonPath("$.device.name").value("运维台"))
				.andReturn();
		String bearer = "Bearer " + json(login).get("token").asString();

		mockMvc.perform(get("/api/admin/overview").header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.users.total").isNumber())
				.andExpect(jsonPath("$.devices.total").isNumber())
				.andExpect(jsonPath("$.trend.length()").value(7))
				.andExpect(jsonPath("$.recentAudits").isArray());
		mockMvc.perform(get("/api/admin/hosts").header("Authorization", bearer))
				.andExpect(status().isOk());
		mockMvc.perform(get("/api/admin/channels").header("Authorization", bearer))
				.andExpect(status().isOk());
		mockMvc.perform(get("/api/admin/llm/keys").header("Authorization", bearer))
				.andExpect(status().isOk());
		mockMvc.perform(get("/api/admin/llm/usage").header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.byProvider").isArray());
	}

	/** 密码错 / 非管理员账号都回同一个 401，避免把登录接口变成账号枚举器。 */
	@Test
	void adminConsolePasswordLoginRejectsBadCredentials() throws Exception {
		mockMvc.perform(post("/api/admin/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("{\"email\":\"ops@grey.local\",\"password\":\"wrong-password\"}"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.code").value("admin_login_invalid"));
		// 普通用户即使被猜中密码（这里本来也没密码）也不能进运维台。
		mockMvc.perform(post("/api/admin/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("{\"email\":\"member@grey.local\",\"password\":\"whatever-1\"}"))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void adminConsoleResourcesAreAdminOnly() throws Exception {
		JsonNode member = enroll("resource-member@grey.local", "desktop");
		for (String path : new String[] { "/api/admin/overview", "/api/admin/hosts",
				"/api/admin/channels", "/api/admin/llm/keys", "/api/admin/llm/usage",
				"/api/admin/storage", "/api/admin/automation" }) {
			mockMvc.perform(get(path).header("Authorization", bearerOf(member)))
					.andExpect(status().isForbidden());
		}
	}

	// ---------- 运维台：存储与自动化（跨用户聚合） ----------

	@Test
	void adminSeesStorageAndAutomationAcrossUsers() throws Exception {
		JsonNode owner = enroll("platform-owner@grey.local", "desktop");
		long userId = owner.get("user").get("id").asLong();
		LocalDateTime now = LocalDateTime.now().withNano(0);
		// 两条 ready 一条 pending：容量只算 ready，pending 单独计数。
		insertStorage(9_000_001L, userId, "ops-a.png", "image", 2048L, "ready", now);
		insertStorage(9_000_002L, userId, "ops-b.txt", "file", 1024L, "ready", now);
		insertStorage(9_000_003L, userId, "ops-c.txt", "file", 0L, "pending", now);
		jdbc.update("""
				INSERT INTO automation_task (id, user_id, name, intent, execution, enabled,
				    next_run_at, created_at, updated_at)
				VALUES (?, ?, '运维可见任务', 'do it', 'host', 1, ?, ?, ?)
				""", "ops-visible-task", userId, now.plusHours(1), now, now);
		jdbc.update("""
				INSERT INTO automation_task (id, user_id, name, intent, execution, enabled,
				    created_at, updated_at)
				VALUES (?, ?, '运维停用任务', 'do it', 'host', 0, ?, ?)
				""", "ops-disabled-task", userId, now, now);
		// 一条早就该触发还没被认领（overdue），一条未来触发（只算 pending 积压）。
		insertDue(userId, "ops-visible-task", now.minusHours(2), now);
		insertDue(userId, "ops-visible-task", now.plusHours(3), now);
		jdbc.update("""
				INSERT INTO automation_run (user_id, task_id, name, status, mode, created_at)
				VALUES (?, ?, '运维可见任务', 'failed', 'host', ?)
				""", userId, "ops-visible-task", now.minusHours(1));
		jdbc.update("""
				INSERT INTO automation_run (user_id, task_id, name, status, mode, created_at)
				VALUES (?, ?, '运维可见任务', 'done', 'host', ?)
				""", userId, "ops-visible-task", now.minusHours(2));

		String bearer = bearerOf(enroll(ADMIN_EMAIL, "server"));

		JsonNode storage = json(mockMvc.perform(get("/api/admin/storage")
						.header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.recent[?(@.name=='ops-a.png')]").isNotEmpty())
				.andExpect(jsonPath("$.byKind[?(@.kind=='image')]").isNotEmpty())
				.andReturn());
		assertThat(storage.get("objects").asLong()).isGreaterThanOrEqualTo(2);
		assertThat(storage.get("bytes").asLong()).isGreaterThanOrEqualTo(3072);
		assertThat(storage.get("pending").asLong()).isGreaterThanOrEqualTo(1);
		// 明细带 owner email，运维台不用再逐个查用户表。
		assertThat(storage.get("recent").toString()).contains("platform-owner@grey.local");

		JsonNode automation = json(mockMvc.perform(get("/api/admin/automation")
						.header("Authorization", bearer))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.recent[?(@.id=='ops-visible-task')]").isNotEmpty())
				.andReturn());
		assertThat(automation.get("tasks").asLong()).isGreaterThanOrEqualTo(2);
		assertThat(automation.get("enabled").asLong()).isGreaterThanOrEqualTo(1);
		assertThat(automation.get("duePending").asLong()).isGreaterThanOrEqualTo(2);
		assertThat(automation.get("dueOverdue").asLong()).isGreaterThanOrEqualTo(1);
		assertThat(automation.get("runs7d").asLong()).isGreaterThanOrEqualTo(2);
		assertThat(automation.get("runsFailed7d").asLong()).isGreaterThanOrEqualTo(1);
	}

	private void insertStorage(Long id, Long userId, String name, String kind, Long bytes,
			String status, LocalDateTime at) {
		jdbc.update("""
				INSERT INTO storage_object (id, user_id, bucket, object_key, name, content_type,
				    size_bytes, kind, visibility, status, source, created_at, updated_at)
				VALUES (?, ?, 'grey', ?, ?, 'text/plain', ?, ?, 'private', ?, 'upload', ?, ?)
				""", id, userId, "ops/" + name, name, bytes, kind, status, at, at);
	}

	private void insertDue(Long userId, String taskId, LocalDateTime dueAt, LocalDateTime at) {
		jdbc.update("""
				INSERT INTO automation_due (user_id, task_id, name, intent, execution, due_at,
				    status, created_at)
				VALUES (?, ?, '运维可见任务', 'do it', 'host', ?, 'pending', ?)
				""", userId, taskId, dueAt, at);
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
