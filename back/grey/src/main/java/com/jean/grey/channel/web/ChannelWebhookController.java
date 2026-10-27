package com.jean.grey.channel.web;

import com.jean.grey.channel.ChannelService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/**
 * 平台侧回调入口。鉴权不靠登录态：URL 里的 k 就是该绑定的一次性 secret。
 */
@RestController
@RequestMapping("/api/channels/webhook")
public class ChannelWebhookController {

	private final ChannelService channelService;

	public ChannelWebhookController(ChannelService channelService) {
		this.channelService = channelService;
	}

	public record InboundRequest(String externalId, JsonNode payload) {
	}

	public record InboundResponse(Long messageId, boolean duplicate, Long hostDeviceId) {
	}

	@PostMapping("/{bindingId}")
	@ResponseStatus(HttpStatus.ACCEPTED)
	public InboundResponse receive(@PathVariable Long bindingId, @RequestParam("k") String secret,
			@RequestBody InboundRequest request) {
		String payload = request.payload() == null ? null : request.payload().toString();
		ChannelService.Ingested ingested = channelService.ingest(bindingId, secret,
				request.externalId(), payload);
		return new InboundResponse(ingested.messageId(), ingested.duplicate(),
				ingested.hostDeviceId());
	}

}
