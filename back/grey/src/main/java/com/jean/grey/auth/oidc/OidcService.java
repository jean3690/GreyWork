package com.jean.grey.auth.oidc;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.entity.UserIdentity;
import com.jean.grey.auth.mapper.UserIdentityMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Emails;
import com.jean.grey.common.Hashes;
import com.jean.grey.config.OidcProperties;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.StringJoiner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * 授权码流程（服务端 confidential client）：
 * authorize → 302 到 IdP → callback 换 access_token → userinfo → 一次性 ticket → 客户端换取登录态。
 * 不解析 id_token，用户身份一律取自 userinfo 端点。
 */
@Service
public class OidcService {

	private static final Logger log = LoggerFactory.getLogger(OidcService.class);
	private static final SecureRandom RANDOM = new SecureRandom();
	private static final Duration STATE_TTL = Duration.ofMinutes(10);
	private static final Duration TICKET_TTL = Duration.ofSeconds(60);

	private final OidcProperties properties;
	private final StringRedisTemplate redis;
	private final AppUserMapper appUserMapper;
	private final UserIdentityMapper identityMapper;
	private final ObjectMapper objectMapper;
	private final HttpClient http;
	private final String publicBaseUrl;

	public OidcService(OidcProperties properties, StringRedisTemplate redis,
			AppUserMapper appUserMapper, UserIdentityMapper identityMapper, ObjectMapper objectMapper,
			@Value("${grey.web.public-base-url:http://localhost:8080}") String publicBaseUrl) {
		this.properties = properties;
		this.redis = redis;
		this.appUserMapper = appUserMapper;
		this.identityMapper = identityMapper;
		this.objectMapper = objectMapper;
		this.publicBaseUrl = publicBaseUrl.endsWith("/")
				? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
				: publicBaseUrl;
		this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
	}

	public record AuthorizeStart(String url) {
	}

	public record CallbackResult(String redirect, String ticket) {
	}

	public record TicketPayload(Long userId, String deviceName, String platform) {
	}

	public AuthorizeStart start(String providerId, String redirect, String deviceName,
			String platform) {
		OidcProperties.Provider provider = requireProvider(providerId);
		requireAllowedRedirect(redirect);

		String state = randomToken();
		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("provider", providerId);
		payload.put("redirect", redirect);
		payload.put("deviceName", deviceName == null ? "" : deviceName);
		payload.put("platform", platform == null ? "" : platform);
		redis.opsForValue().set(stateKey(state), objectMapper.writeValueAsString(payload), STATE_TTL);

		StringJoiner query = new StringJoiner("&");
		query.add("response_type=code");
		query.add("client_id=" + enc(provider.clientId()));
		query.add("redirect_uri=" + enc(callbackUrl(providerId)));
		query.add("scope=" + enc(String.join(" ", provider.scopes())));
		query.add("state=" + enc(state));
		String separator = provider.authorizationUrl().contains("?") ? "&" : "?";
		return new AuthorizeStart(provider.authorizationUrl() + separator + query);
	}

	public CallbackResult callback(String providerId, String code, String state) {
		OidcProperties.Provider provider = requireProvider(providerId);
		String raw = redis.opsForValue().getAndDelete(stateKey(state));
		if (raw == null) {
			throw ApiException.badRequest("oidc_state_invalid", "登录状态已过期，请重新发起");
		}
		JsonNode payload = objectMapper.readTree(raw);
		if (!providerId.equals(payload.path("provider").asString())) {
			throw ApiException.badRequest("oidc_state_mismatch", "登录状态与供应商不一致");
		}

		JsonNode profile = fetchProfile(provider, code, providerId);
		AppUser user = resolveUser(providerId, provider, profile);

		Map<String, Object> ticket = new LinkedHashMap<>();
		ticket.put("userId", user.getId());
		ticket.put("deviceName", payload.path("deviceName").asString());
		ticket.put("platform", payload.path("platform").asString());
		String ticketValue = randomToken();
		redis.opsForValue().set(ticketKey(ticketValue), objectMapper.writeValueAsString(ticket),
				TICKET_TTL);
		return new CallbackResult(payload.path("redirect").asString(), ticketValue);
	}

	/** 一次性 ticket 换登录态，票用完即毁。 */
	public TicketPayload redeem(String ticket) {
		String raw = redis.opsForValue().getAndDelete(ticketKey(ticket));
		if (raw == null) {
			throw ApiException.unauthorized("oidc_ticket_invalid", "登录凭据无效或已使用");
		}
		JsonNode node = objectMapper.readTree(raw);
		return new TicketPayload(node.get("userId").asLong(), node.path("deviceName").asString(),
				node.path("platform").asString());
	}

	public boolean enabled(String providerId) {
		OidcProperties.Provider provider = properties.providers().get(providerId);
		return provider != null && provider.enabled();
	}

	private JsonNode fetchProfile(OidcProperties.Provider provider, String code, String providerId) {
		String form = new StringJoiner("&")
				.add("grant_type=authorization_code")
				.add("code=" + enc(code))
				.add("client_id=" + enc(provider.clientId()))
				.add("client_secret=" + enc(provider.clientSecret() == null ? "" : provider.clientSecret()))
				.add("redirect_uri=" + enc(callbackUrl(providerId)))
				.toString();
		JsonNode tokenJson = send(HttpRequest.newBuilder(URI.create(provider.tokenUrl()))
				.header("Content-Type", "application/x-www-form-urlencoded")
				.header("Accept", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(form)), "token");
		String accessToken = tokenJson.path("access_token").asString();
		if (accessToken == null || accessToken.isBlank()) {
			throw new ApiException(HttpStatus.BAD_GATEWAY, "oidc_token_failed", "身份源没有返回 access_token");
		}
		return send(HttpRequest.newBuilder(URI.create(provider.userinfoUrl()))
				.header("Authorization", "Bearer " + accessToken)
				.header("Accept", "application/json")
				.GET(), "userinfo");
	}

	private JsonNode send(HttpRequest.Builder builder, String label) {
		try {
			HttpResponse<String> response = http.send(builder.timeout(Duration.ofSeconds(15)).build(),
					HttpResponse.BodyHandlers.ofString());
			if (response.statusCode() >= 400) {
				log.warn("oidc {} endpoint returned {}", label, response.statusCode());
				throw new ApiException(HttpStatus.BAD_GATEWAY, "oidc_upstream_error",
						"身份源 " + label + " 返回 " + response.statusCode());
			}
			return objectMapper.readTree(response.body());
		}
		catch (java.io.IOException ex) {
			log.warn("oidc {} unreachable", label, ex);
			throw new ApiException(HttpStatus.BAD_GATEWAY, "oidc_upstream_unreachable",
					"连不上身份源 " + label + " 端点");
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new ApiException(HttpStatus.BAD_GATEWAY, "oidc_interrupted", "登录请求被中断");
		}
	}

	@Transactional
	public AppUser resolveUser(String providerId, OidcProperties.Provider provider,
			JsonNode profile) {
		String subject = text(profile, provider.subjectField());
		if (subject == null || subject.isBlank()) {
			throw new ApiException(HttpStatus.BAD_GATEWAY, "oidc_subject_missing",
					"身份源没有返回用户标识字段 " + provider.subjectField());
		}
		// 与入场码路径同一套归一化：否则同一个人在两条登录路径上会开出两个账号。
		String email = Emails.normalize(text(profile, provider.emailField()));
		String displayName = text(profile, provider.nameField());

		UserIdentity existing = identityMapper.selectOne(Wrappers.<UserIdentity>lambdaQuery()
				.eq(UserIdentity::getProvider, providerId)
				.eq(UserIdentity::getSubject, subject));
		if (existing != null) {
			return appUserMapper.selectById(existing.getUserId());
		}

		AppUser user = null;
		if (provider.linkByEmail() && email != null) {
			// LOWER(email) 命中归一化之前写入的历史行（见 AuthService#findByEmail 的说明）。
			user = appUserMapper.selectOne(Wrappers.<AppUser>query()
					.apply("LOWER(email) = {0}", email));
		}
		if (user == null) {
			user = new AppUser();
			user.setEmail(email != null ? email : syntheticEmail(providerId, subject));
			user.setDisplayName(displayName != null && !displayName.isBlank()
					? displayName
					: user.getEmail());
			user.setStatus("active");
			appUserMapper.insert(user);
		}

		try {
			identityMapper.insert(newIdentity(user.getId(), providerId, subject));
		}
		catch (DuplicateKeyException ex) {
			UserIdentity raced = identityMapper.selectOne(Wrappers.<UserIdentity>lambdaQuery()
					.eq(UserIdentity::getProvider, providerId)
					.eq(UserIdentity::getSubject, subject));
			if (raced != null) {
				return appUserMapper.selectById(raced.getUserId());
			}
		}
		return user;
	}

	/** 身份源不给邮箱时用一个确定性的本地占位邮箱，保证用户表唯一键可用。 */
	static String syntheticEmail(String providerId, String subject) {
		return "idp-" + Hashes.sha256Hex(providerId + ":" + subject).substring(0, 16) + "@idp.local";
	}

	private static UserIdentity newIdentity(Long userId, String providerId, String subject) {
		UserIdentity identity = new UserIdentity();
		identity.setUserId(userId);
		identity.setProvider(providerId);
		identity.setSubject(subject);
		return identity;
	}

	private OidcProperties.Provider requireProvider(String providerId) {
		OidcProperties.Provider provider = properties.providers().get(providerId);
		if (provider == null || !provider.enabled()) {
			throw new ApiException(HttpStatus.NOT_FOUND, "oidc_provider_unavailable",
					"未配置的身份源: " + providerId);
		}
		return provider;
	}

	private void requireAllowedRedirect(String redirect) {
		if (redirect == null || redirect.isBlank()) {
			throw ApiException.badRequest("oidc_redirect_required", "缺少登录后跳转地址");
		}
		boolean allowed = properties.allowedRedirects().stream()
				.filter(prefix -> !prefix.isBlank())
				.anyMatch(redirect::startsWith);
		if (!allowed) {
			throw ApiException.badRequest("oidc_redirect_denied", "登录后跳转地址不在允许列表内");
		}
	}

	private String callbackUrl(String providerId) {
		return publicBaseUrl + "/api/auth/oidc/" + providerId + "/callback";
	}

	private static String text(JsonNode node, String field) {
		if (field == null || field.isBlank()) {
			return null;
		}
		JsonNode value = node.path(field);
		return value.isMissingNode() || value.isNull() ? null : value.asString();
	}

	private static String randomToken() {
		byte[] raw = new byte[24];
		RANDOM.nextBytes(raw);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
	}

	private static String stateKey(String state) {
		return "grey:oidc:state:" + state;
	}

	private static String ticketKey(String ticket) {
		return "grey:oidc:ticket:" + ticket;
	}

	private static String enc(String value) {
		return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
	}

}
