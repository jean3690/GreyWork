package com.jean.grey.llm.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.llm.LlmGatewayService;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LlmGatewayController {

	private final LlmGatewayService gatewayService;

	public LlmGatewayController(LlmGatewayService gatewayService) {
		this.gatewayService = gatewayService;
	}

	/** OpenAI 兼容入口：body 原样转发，流式与非流式都走这里。 */
	@PostMapping("/v1/chat/completions")
	public void chatCompletions(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestHeader(value = "X-Grey-Provider", required = false) String provider,
			@RequestBody byte[] body, HttpServletResponse response) {
		gatewayService.forward(principal.userId(), provider, body, response);
	}

}
