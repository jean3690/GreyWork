package com.jean.grey.admin;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.AuditService;
import com.jean.grey.channel.ChannelService;
import com.jean.grey.channel.entity.ChannelBinding;
import com.jean.grey.channel.mapper.ChannelBindingMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.host.HostService;
import com.jean.grey.host.entity.HostInstance;
import com.jean.grey.host.mapper.HostInstanceMapper;
import com.jean.grey.llm.entity.LlmKey;
import com.jean.grey.llm.mapper.LlmKeyMapper;
import com.jean.grey.llm.mapper.LlmUsageMapper;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

/**
 * 运维台的跨用户只读视图：宿主、通道、模型密钥与用量。
 *
 * 这些数据本来都有「当前用户」版本的接口（/api/hosts、/api/channels、/api/llm）。
 * 运维台不冒充用户去调用它们，而是用这里的 admin 查询 —— 一是那些接口按 userId 收敛，
 * 管理员看不到别人的；二是管理端返回的字段（ownerEmail 等）不该塞进面向用户的 DTO。
 *
 * 只读为主：唯一写操作是「停用/启用某条通道」，因为通道是最容易出事的一类资源
 * （第三方平台 token 泄漏 / 消息风暴），管理员要能立刻掐断。
 */
@Service
public class AdminResourceService {

	/** 列表上限与用户管理一致：运维台是「排查」，不是导出全库。 */
	private static final int MAX_LIST = 200;

	private final AppUserMapper appUserMapper;
	private final HostInstanceMapper hostInstanceMapper;
	private final HostService hostService;
	private final ChannelBindingMapper channelBindingMapper;
	private final ChannelService channelService;
	private final LlmKeyMapper llmKeyMapper;
	private final LlmUsageMapper llmUsageMapper;
	private final AuditService auditService;

	public AdminResourceService(AppUserMapper appUserMapper, HostInstanceMapper hostInstanceMapper,
			HostService hostService, ChannelBindingMapper channelBindingMapper,
			ChannelService channelService, LlmKeyMapper llmKeyMapper,
			LlmUsageMapper llmUsageMapper, AuditService auditService) {
		this.appUserMapper = appUserMapper;
		this.hostInstanceMapper = hostInstanceMapper;
		this.hostService = hostService;
		this.channelBindingMapper = channelBindingMapper;
		this.channelService = channelService;
		this.llmKeyMapper = llmKeyMapper;
		this.llmUsageMapper = llmUsageMapper;
		this.auditService = auditService;
	}

	public record HostItem(Long deviceId, Long userId, String ownerEmail, String name, String version,
			boolean alive, long bindings, LocalDateTime createdAt) {
	}

	public record ChannelItem(Long id, Long userId, String ownerEmail, String platform,
			String accountRef, String status, String storedStatus, Long hostDeviceId, String hostName,
			LocalDateTime createdAt) {
	}

	public record LlmKeyItem(Long id, Long userId, String ownerEmail, String provider, String label,
			String baseUrl, String status, LocalDateTime lastUsedAt, LocalDateTime createdAt) {
	}

	public record UsageByProvider(String provider, long requests, long tokens) {
	}

	public record LlmUsageOverview(long requests7d, long tokens7d, long requestsToday,
			long tokensToday, List<UsageByProvider> byProvider) {
	}

	public List<HostItem> hosts() {
		List<HostInstance> hosts = hostInstanceMapper.selectList(Wrappers.<HostInstance>lambdaQuery()
				.orderByDesc(HostInstance::getCreatedAt)
				.last("LIMIT " + MAX_LIST));
		Map<Long, String> emails = emailsOf(hosts.stream().map(HostInstance::getUserId).toList());
		Map<Long, Long> bindingCounts = channelBindingMapper.selectList(
				Wrappers.<ChannelBinding>lambdaQuery().select(ChannelBinding::getHostDeviceId))
				.stream()
				.filter(binding -> binding.getHostDeviceId() != null)
				.collect(Collectors.groupingBy(ChannelBinding::getHostDeviceId, Collectors.counting()));
		return hosts.stream()
				.map(host -> new HostItem(host.getDeviceId(), host.getUserId(),
						emails.get(host.getUserId()), host.getName(), host.getVersion(),
						hostService.isAlive(host.getDeviceId()),
						bindingCounts.getOrDefault(host.getDeviceId(), 0L), host.getCreatedAt()))
				.toList();
	}

	public List<ChannelItem> channels() {
		List<ChannelBinding> bindings = channelBindingMapper.selectList(
				Wrappers.<ChannelBinding>lambdaQuery()
						.orderByDesc(ChannelBinding::getCreatedAt)
						.last("LIMIT " + MAX_LIST));
		Map<Long, String> emails = emailsOf(bindings.stream().map(ChannelBinding::getUserId).toList());
		Map<Long, String> hostNames = hostNamesOf(bindings.stream()
				.map(ChannelBinding::getHostDeviceId).filter(Objects::nonNull).toList());
		return bindings.stream()
				.map(binding -> new ChannelItem(binding.getId(), binding.getUserId(),
						emails.get(binding.getUserId()), binding.getPlatform(),
						binding.getAccountRef(), channelService.effectiveStatus(binding),
						binding.getStatus(), binding.getHostDeviceId(),
						hostNames.get(binding.getHostDeviceId()), binding.getCreatedAt()))
				.toList();
	}

	public List<LlmKeyItem> llmKeys() {
		List<LlmKey> keys = llmKeyMapper.selectList(Wrappers.<LlmKey>lambdaQuery()
				.orderByDesc(LlmKey::getCreatedAt)
				.last("LIMIT " + MAX_LIST));
		Map<Long, String> emails = emailsOf(keys.stream().map(LlmKey::getUserId).toList());
		return keys.stream()
				.map(key -> new LlmKeyItem(key.getId(), key.getUserId(), emails.get(key.getUserId()),
						key.getProvider(), key.getLabel(), key.getBaseUrl(), key.getStatus(),
						key.getLastUsedAt(), key.getCreatedAt()))
				.toList();
	}

	public LlmUsageOverview llmUsage() {
		LocalDate today = LocalDate.now();
		LocalDateTime weekStart = today.minusDays(6).atStartOfDay();
		LocalDateTime todayStart = today.atStartOfDay();
		Map<String, Object> week = llmUsageMapper.summaryAll(weekStart);
		Map<String, Object> day = llmUsageMapper.summaryAll(todayStart);
		List<UsageByProvider> byProvider = llmUsageMapper.summaryByProvider(weekStart).stream()
				.map(row -> new UsageByProvider(String.valueOf(row.get("provider")),
						asLong(row.get("requests")), asLong(row.get("total_tokens"))))
				.toList();
		return new LlmUsageOverview(asLong(week.get("requests")), asLong(week.get("total_tokens")),
				asLong(day.get("requests")), asLong(day.get("total_tokens")), byProvider);
	}

	/** 停用 / 启用通道：disabled 是管理员的硬开关，宿主心跳回来也不会自动改回。 */
	public ChannelItem setChannelStatus(Long actorId, Long bindingId, String status) {
		String normalized = status == null ? "" : status.trim().toLowerCase(Locale.ROOT);
		if (!"active".equals(normalized) && !"disabled".equals(normalized)) {
			throw ApiException.badRequest("status_invalid", "status 只能是 active 或 disabled");
		}
		ChannelBinding binding = channelBindingMapper.selectById(bindingId);
		if (binding == null) {
			throw ApiException.notFound("binding_not_found", "通道绑定不存在");
		}
		binding.setStatus(normalized);
		channelBindingMapper.updateById(binding);
		auditService.record(actorId, AuditService.ACTION_CHANNEL_STATUS, AuditService.TARGET_CHANNEL,
				bindingId, "to=" + normalized + ", platform=" + binding.getPlatform());
		return channels().stream()
				.filter(item -> item.id().equals(bindingId))
				.findFirst()
				.orElseThrow(() -> ApiException.notFound("binding_not_found", "通道绑定不存在"));
	}

	private Map<Long, String> emailsOf(Collection<Long> userIds) {
		List<Long> ids = userIds.stream().filter(Objects::nonNull).distinct().toList();
		if (ids.isEmpty()) {
			return Map.of();
		}
		Map<Long, String> emails = new HashMap<>();
		appUserMapper.selectBatchIds(ids)
				.forEach(user -> emails.put(user.getId(), user.getEmail()));
		return emails;
	}

	private Map<Long, String> hostNamesOf(Collection<Long> deviceIds) {
		List<Long> ids = deviceIds.stream().filter(Objects::nonNull).distinct().toList();
		if (ids.isEmpty()) {
			return Map.of();
		}
		return hostInstanceMapper.selectBatchIds(ids).stream()
				.collect(Collectors.toMap(HostInstance::getDeviceId,
						host -> host.getName() == null ? "" : host.getName(), (left, right) -> left));
	}

	private static long asLong(Object value) {
		return value instanceof Number number ? number.longValue() : 0L;
	}

}
