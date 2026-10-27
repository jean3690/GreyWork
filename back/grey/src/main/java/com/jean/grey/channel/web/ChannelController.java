package com.jean.grey.channel.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.channel.ChannelService;
import com.jean.grey.channel.entity.ChannelBinding;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/channels")
public class ChannelController {

	private final ChannelService channelService;

	public ChannelController(ChannelService channelService) {
		this.channelService = channelService;
	}

	public record BindRequest(String platform, String accountRef, Long hostDeviceId) {
	}

	public record BindingView(Long id, String platform, String accountRef, Long hostDeviceId,
			String status, boolean hostAlive, LocalDateTime createdAt) {
	}

	public record BindResponse(BindingView binding, String webhookUrl) {
	}

	public record ReassignRequest(Long hostDeviceId) {
	}

	@PostMapping("/bindings")
	@ResponseStatus(HttpStatus.CREATED)
	public BindResponse bind(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody BindRequest request) {
		ChannelService.CreatedBinding created = channelService.bind(principal.userId(),
				principal.deviceId(), request.platform(), request.accountRef(), request.hostDeviceId());
		return new BindResponse(view(created.binding()), created.webhookUrl());
	}

	@GetMapping("/bindings")
	public List<BindingView> list(@AuthenticationPrincipal AuthPrincipal principal) {
		return channelService.list(principal.userId()).stream().map(this::view).toList();
	}

	@PostMapping("/bindings/{id}/reassign")
	public BindingView reassign(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id,
			@RequestBody ReassignRequest request) {
		return view(channelService.reassign(principal.userId(), id, request.hostDeviceId()));
	}

	@PostMapping("/bindings/{id}/disable")
	public BindingView disable(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		return view(channelService.setStatus(principal.userId(), id, "disabled"));
	}

	@PostMapping("/bindings/{id}/enable")
	public BindingView enable(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		return view(channelService.setStatus(principal.userId(), id, "active"));
	}

	@DeleteMapping("/bindings/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void unbind(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		channelService.unbind(principal.userId(), id);
	}

	private BindingView view(ChannelBinding binding) {
		return new BindingView(binding.getId(), binding.getPlatform(), binding.getAccountRef(),
				binding.getHostDeviceId(), channelService.effectiveStatus(binding),
				channelService.hostAlive(binding), binding.getCreatedAt());
	}

}
