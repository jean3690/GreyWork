package com.jean.grey.host;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.channel.entity.ChannelBinding;
import com.jean.grey.channel.mapper.ChannelBindingMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.host.entity.HostInstance;
import com.jean.grey.host.mapper.HostInstanceMapper;
import java.time.Duration;
import java.util.List;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class HostService {

	/** 心跳有效期：90 秒内有心跳算活着。 */
	public static final Duration ALIVE_TTL = Duration.ofSeconds(90);

	private final HostInstanceMapper hostInstanceMapper;
	private final ChannelBindingMapper channelBindingMapper;
	private final StringRedisTemplate redis;
	private final ObjectMapper objectMapper;

	public HostService(HostInstanceMapper hostInstanceMapper,
			ChannelBindingMapper channelBindingMapper, StringRedisTemplate redis,
			ObjectMapper objectMapper) {
		this.hostInstanceMapper = hostInstanceMapper;
		this.channelBindingMapper = channelBindingMapper;
		this.redis = redis;
		this.objectMapper = objectMapper;
	}

	public record HostView(Long deviceId, String name, String version, boolean alive,
			long bindings) {
	}

	public void register(Long userId, Long deviceId, String name, String version,
			List<String> capabilities) {
		HostInstance existing = hostInstanceMapper.selectById(deviceId);
		HostInstance host = existing != null ? existing : new HostInstance();
		host.setDeviceId(deviceId);
		host.setUserId(userId);
		host.setName(name);
		host.setVersion(version);
		host.setCapabilities(capabilities == null ? null : objectMapper.writeValueAsString(capabilities));
		if (existing == null) {
			hostInstanceMapper.insert(host);
		}
		else {
			hostInstanceMapper.updateById(host);
		}
		markAlive(deviceId);
	}

	public void heartbeat(Long userId, Long deviceId) {
		HostInstance host = hostInstanceMapper.selectById(deviceId);
		if (host == null || !host.getUserId().equals(userId)) {
			throw ApiException.notFound("host_unknown", "该设备尚未注册为宿主");
		}
		markAlive(deviceId);
	}

	public boolean isAlive(Long deviceId) {
		return Boolean.TRUE.equals(redis.hasKey(aliveKey(deviceId)));
	}

	public void markAlive(Long deviceId) {
		redis.opsForValue().set(aliveKey(deviceId), "1", ALIVE_TTL);
	}

	public List<HostView> list(Long userId) {
		return hostInstanceMapper.selectList(Wrappers.<HostInstance>lambdaQuery()
				.eq(HostInstance::getUserId, userId)
				.orderByAsc(HostInstance::getCreatedAt))
				.stream()
				.map(host -> new HostView(host.getDeviceId(), host.getName(), host.getVersion(),
						isAlive(host.getDeviceId()), channelBindingMapper.selectCount(
								Wrappers.<ChannelBinding>lambdaQuery()
										.eq(ChannelBinding::getHostDeviceId, host.getDeviceId()))))
				.toList();
	}

	public HostInstance requireOwned(Long userId, Long deviceId) {
		HostInstance host = hostInstanceMapper.selectById(deviceId);
		if (host == null || !host.getUserId().equals(userId)) {
			throw ApiException.badRequest("host_unknown", "目标宿主不存在或不属于当前用户");
		}
		return host;
	}

	/**
	 * 分片策略：优先落在调用方自己身上（桌面/服务端绑定通道时通常就是它自己），
	 * 否则退到最早注册且在线的宿主；都没有则报错，交给上层让用户先起宿主。
	 */
	public HostInstance pickHost(Long userId, Long callerDeviceId) {
		if (callerDeviceId == null) {
			return oldestAlive(userId);
		}
		HostInstance caller = hostInstanceMapper.selectById(callerDeviceId);
		if (caller != null && caller.getUserId().equals(userId) && isAlive(callerDeviceId)) {
			return caller;
		}
		return oldestAlive(userId);
	}

	private HostInstance oldestAlive(Long userId) {
		return hostInstanceMapper.selectList(Wrappers.<HostInstance>lambdaQuery()
				.eq(HostInstance::getUserId, userId)
				.orderByAsc(HostInstance::getCreatedAt))
				.stream()
				.filter(candidate -> isAlive(candidate.getDeviceId()))
				.findFirst()
				.orElse(null);
	}

	private static String aliveKey(Long deviceId) {
		return "grey:host:" + deviceId;
	}

}
