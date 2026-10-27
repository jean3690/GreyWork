package com.jean.grey.channel;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.channel.entity.ChannelBinding;
import com.jean.grey.channel.entity.ChannelMessage;
import com.jean.grey.channel.mapper.ChannelBindingMapper;
import com.jean.grey.channel.mapper.ChannelMessageMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Hashes;
import com.jean.grey.host.HostService;
import com.jean.grey.host.entity.HostInstance;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ChannelService {

	/** 与 Rust 宿主侧通道注册表保持一致。 */
	public static final Set<String> PLATFORMS = Set.of("wechat", "wecom", "feishu", "dingtalk",
			"qq", "telegram", "discord");

	private static final SecureRandom RANDOM = new SecureRandom();

	private final ChannelBindingMapper bindingMapper;
	private final ChannelMessageMapper messageMapper;
	private final HostService hostService;
	private final String publicBaseUrl;

	public ChannelService(ChannelBindingMapper bindingMapper, ChannelMessageMapper messageMapper,
			HostService hostService,
			@Value("${grey.web.public-base-url:http://localhost:8080}") String publicBaseUrl) {
		this.bindingMapper = bindingMapper;
		this.messageMapper = messageMapper;
		this.hostService = hostService;
		this.publicBaseUrl = publicBaseUrl.endsWith("/")
				? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
				: publicBaseUrl;
	}

	public record CreatedBinding(ChannelBinding binding, String secret, String webhookUrl) {
	}

	public record Ingested(Long messageId, boolean duplicate, Long hostDeviceId) {
	}

	@Transactional
	public CreatedBinding bind(Long userId, Long callerDeviceId, String platform, String accountRef,
			Long hostDeviceId) {
		requirePlatform(platform);
		HostInstance host = hostDeviceId != null
				? hostService.requireOwned(userId, hostDeviceId)
				: hostService.pickHost(userId, callerDeviceId);
		if (host == null) {
			throw new ApiException(HttpStatus.CONFLICT, "no_available_host",
					"没有在线宿主可承载该通道，请先启动宿主");
		}

		Long existing = bindingMapper.selectCount(Wrappers.<ChannelBinding>lambdaQuery()
				.eq(ChannelBinding::getUserId, userId)
				.eq(ChannelBinding::getPlatform, platform)
				.eq(ChannelBinding::getAccountRef, accountRef));
		if (existing != null && existing > 0) {
			throw new ApiException(HttpStatus.CONFLICT, "binding_exists", "该账号已绑定过");
		}

		String secret = randomSecret();
		ChannelBinding binding = new ChannelBinding();
		binding.setUserId(userId);
		binding.setPlatform(platform);
		binding.setAccountRef(accountRef);
		binding.setHostDeviceId(host.getDeviceId());
		binding.setStatus("active");
		binding.setSecretHash(Hashes.sha256Hex(secret));
		try {
			bindingMapper.insert(binding);
		}
		catch (DuplicateKeyException ex) {
			throw new ApiException(HttpStatus.CONFLICT, "binding_exists", "该账号已绑定过");
		}
		return new CreatedBinding(binding, secret, webhookUrl(binding.getId(), secret));
	}

	public List<ChannelBinding> list(Long userId) {
		return bindingMapper.selectList(Wrappers.<ChannelBinding>lambdaQuery()
				.eq(ChannelBinding::getUserId, userId)
				.orderByAsc(ChannelBinding::getCreatedAt));
	}

	public List<ChannelBinding> listForHost(Long userId, Long hostDeviceId) {
		return bindingMapper.selectList(Wrappers.<ChannelBinding>lambdaQuery()
				.eq(ChannelBinding::getUserId, userId)
				.eq(ChannelBinding::getHostDeviceId, hostDeviceId)
				.eq(ChannelBinding::getStatus, "active")
				.orderByAsc(ChannelBinding::getCreatedAt));
	}

	public ChannelBinding reassign(Long userId, Long bindingId, Long hostDeviceId) {
		ChannelBinding binding = requireOwned(userId, bindingId);
		hostService.requireOwned(userId, hostDeviceId);
		binding.setHostDeviceId(hostDeviceId);
		bindingMapper.updateById(binding);
		return binding;
	}

	public void unbind(Long userId, Long bindingId) {
		requireOwned(userId, bindingId);
		bindingMapper.deleteById(bindingId);
	}

	/** webhook 入口：平台侧调用，凭 URL 里的一次性 secret 认身份。 */
	@Transactional
	public Ingested ingest(Long bindingId, String secret, String externalId, String payload) {
		ChannelBinding binding = bindingMapper.selectById(bindingId);
		if (binding == null) {
			throw ApiException.notFound("binding_not_found", "通道绑定不存在");
		}
		if (!secretMatches(secret, binding.getSecretHash())) {
			throw ApiException.unauthorized("webhook_secret_invalid", "webhook 凭据不正确");
		}
		if ("disabled".equals(binding.getStatus())) {
			throw new ApiException(HttpStatus.CONFLICT, "binding_disabled", "该通道已被手动停用");
		}

		// 宿主掉线就地接管：消息要落在活着的宿主上，落不了就排队等它回来
		Long hostDeviceId = failover(binding);

		ChannelMessage message = new ChannelMessage();
		message.setUserId(binding.getUserId());
		message.setBindingId(binding.getId());
		message.setPlatform(binding.getPlatform());
		message.setExternalId(externalId);
		message.setPayload(payload);
		message.setReceivedAt(LocalDateTime.now());
		try {
			messageMapper.insert(message);
		}
		catch (DuplicateKeyException ex) {
			ChannelMessage existing = messageMapper.selectOne(Wrappers.<ChannelMessage>lambdaQuery()
					.eq(ChannelMessage::getBindingId, bindingId)
					.eq(ChannelMessage::getExternalId, externalId));
			return new Ingested(existing == null ? null : existing.getId(), true, hostDeviceId);
		}
		return new Ingested(message.getId(), false, hostDeviceId);
	}

	public List<ChannelMessage> pull(Long userId, Long hostDeviceId, long since, int limit) {
		return messageMapper.pullForHost(userId, hostDeviceId, since, Math.clamp(limit, 1, 200));
	}

	/** 生效状态：disabled 是用户意图，degraded 是宿主不在线的推导值。 */
	public String effectiveStatus(ChannelBinding binding) {
		if ("disabled".equals(binding.getStatus())) {
			return "disabled";
		}
		if (binding.getHostDeviceId() == null || !hostService.isAlive(binding.getHostDeviceId())) {
			return "degraded";
		}
		return "active";
	}

	public ChannelBinding setStatus(Long userId, Long bindingId, String status) {
		ChannelBinding binding = requireOwned(userId, bindingId);
		binding.setStatus(status);
		bindingMapper.updateById(binding);
		return binding;
	}

	public boolean hostAlive(ChannelBinding binding) {
		return binding.getHostDeviceId() != null && hostService.isAlive(binding.getHostDeviceId());
	}

	private Long failover(ChannelBinding binding) {
		if (binding.getHostDeviceId() != null && hostService.isAlive(binding.getHostDeviceId())) {
			return binding.getHostDeviceId();
		}
		HostInstance replacement = hostService.pickHost(binding.getUserId(), null);
		if (replacement == null) {
			return binding.getHostDeviceId();
		}
		binding.setHostDeviceId(replacement.getDeviceId());
		bindingMapper.updateById(binding);
		return replacement.getDeviceId();
	}

	public ChannelBinding requireOwned(Long userId, Long bindingId) {
		ChannelBinding binding = bindingMapper.selectById(bindingId);
		if (binding == null || !binding.getUserId().equals(userId)) {
			throw ApiException.notFound("binding_not_found", "通道绑定不存在");
		}
		return binding;
	}

	private String webhookUrl(Long bindingId, String secret) {
		return publicBaseUrl + "/api/channels/webhook/" + bindingId + "?k=" + secret;
	}

	private static boolean secretMatches(String secret, String storedHash) {
		if (secret == null || secret.isBlank()) {
			return false;
		}
		return MessageDigest.isEqual(Hashes.sha256Hex(secret).getBytes(StandardCharsets.UTF_8),
				storedHash.getBytes(StandardCharsets.UTF_8));
	}

	private static String randomSecret() {
		byte[] raw = new byte[32];
		RANDOM.nextBytes(raw);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
	}

	private static void requirePlatform(String platform) {
		if (!PLATFORMS.contains(platform)) {
			throw ApiException.badRequest("platform_unknown", "不支持的通道平台: " + platform);
		}
	}

}
