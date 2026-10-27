package com.jean.grey.auth.web;

import com.jean.grey.auth.AuthService;
import com.jean.grey.auth.oidc.OidcService;
import com.jean.grey.config.OidcProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth/oidc")
public class OidcController {

	private final OidcService oidcService;
	private final OidcProperties properties;
	private final AuthService authService;

	public OidcController(OidcService oidcService, OidcProperties properties,
			AuthService authService) {
		this.oidcService = oidcService;
		this.properties = properties;
		this.authService = authService;
	}

	public record ExchangeRequest(@NotBlank String ticket) {
	}

	@GetMapping("/providers")
	public Map<String, Boolean> providers() {
		Map<String, Boolean> result = new LinkedHashMap<>();
		properties.providers().keySet().forEach(id -> result.put(id, oidcService.enabled(id)));
		return result;
	}

	@GetMapping("/{provider}/authorize")
	public ResponseEntity<Void> authorize(@PathVariable String provider,
			@RequestParam String redirect,
			@RequestParam(required = false) String deviceName,
			@RequestParam(required = false) String platform) {
		OidcService.AuthorizeStart start = oidcService.start(provider, redirect, deviceName, platform);
		return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(start.url())).build();
	}

	@GetMapping("/{provider}/callback")
	public ResponseEntity<Void> callback(@PathVariable String provider, @RequestParam String code,
			@RequestParam String state) {
		OidcService.CallbackResult result = oidcService.callback(provider, code, state);
		String separator = result.redirect().contains("?") ? "&" : "?";
		return ResponseEntity.status(HttpStatus.FOUND)
				.location(URI.create(result.redirect() + separator + "ticket=" + result.ticket()))
				.build();
	}

	@PostMapping("/exchange")
	public AuthController.SessionView exchange(@Valid @RequestBody ExchangeRequest request) {
		OidcService.TicketPayload payload = oidcService.redeem(request.ticket());
		AuthService.Enrolled enrolled = authService.issueSession(payload.userId(),
				payload.deviceName(), payload.platform());
		return new AuthController.SessionView(enrolled.token(),
				new AuthController.UserView(enrolled.user().getId(), enrolled.user().getEmail(),
						enrolled.user().getDisplayName()),
				new AuthController.DeviceView(enrolled.device().getId(),
						enrolled.device().getName(), enrolled.device().getPlatform()));
	}

}
