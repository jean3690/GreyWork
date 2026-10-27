package com.jean.grey.host.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.channel.ChannelService;
import com.jean.grey.channel.entity.ChannelBinding;
import com.jean.grey.channel.entity.ChannelMessage;
import com.jean.grey.host.HostService;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/hosts")
public class HostController {

	private final HostService hostService;
	private final ChannelService channelService;
	private final ObjectMapper objectMapper;

	public HostController(HostService hostService, ChannelService channelService,
			ObjectMapper objectMapper) {
		this.hostService = hostService;
		this.channelService = channelService;
		this.objectMapper = objectMapper;
	}

	public record RegisterRequest(String name, String version, List<String> capabilities) {
	}

	public record SelfView(Long deviceId, boolean alive) {
	}

	public record BindingItem(Long id, String platform, String accountRef) {
	}

	public record MessageItem(Long id, Long bindingId, String platform, String externalId,
			JsonNode payload, LocalDateTime receivedAt) {
	}

	public record MessagePage(Long revision, boolean hasMore, List<MessageItem> messages) {
	}

	@PutMapping("/me")
	public SelfView register(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody RegisterRequest request) {
		hostService.register(principal.userId(), principal.deviceId(),
				request.name() == null ? "" : request.name(),
				request.version() == null ? "" : request.version(),
				request.capabilities());
		return new SelfView(principal.deviceId(), true);
	}

	@PostMapping("/me/heartbeat")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void heartbeat(@AuthenticationPrincipal AuthPrincipal principal) {
		hostService.heartbeat(principal.userId(), principal.deviceId());
	}

	@GetMapping
	public List<HostService.HostView> list(@AuthenticationPrincipal AuthPrincipal principal) {
		return hostService.list(principal.userId());
	}

	/** 宿主启动后拉这份清单，决定要连哪些通道。 */
	@GetMapping("/me/bindings")
	public List<BindingItem> bindings(@AuthenticationPrincipal AuthPrincipal principal) {
		hostService.heartbeat(principal.userId(), principal.deviceId());
		return channelService.listForHost(principal.userId(), principal.deviceId()).stream()
				.map(binding -> new BindingItem(binding.getId(), binding.getPlatform(),
						binding.getAccountRef()))
				.toList();
	}

	/** 入站消息游标拉取：id 单调，客户端自己记住最后一条。 */
	@GetMapping("/me/messages")
	public MessagePage messages(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(defaultValue = "0") long since,
			@RequestParam(defaultValue = "50") int limit) {
		hostService.heartbeat(principal.userId(), principal.deviceId());
		List<ChannelMessage> rows = channelService.pull(principal.userId(), principal.deviceId(),
				since, limit);
		boolean hasMore = rows.size() >= Math.clamp(limit, 1, 200);
		long revision = rows.isEmpty() ? since : rows.getLast().getId();
		List<MessageItem> items = rows.stream()
				.map(row -> new MessageItem(row.getId(), row.getBindingId(), row.getPlatform(),
						row.getExternalId(), readPayload(row.getPayload()), row.getReceivedAt()))
				.toList();
		return new MessagePage(revision, hasMore, items);
	}

	private JsonNode readPayload(String raw) {
		return raw == null ? null : objectMapper.readTree(raw);
	}

}
