package com.jean.grey.llm.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.llm.LlmKeyService;
import com.jean.grey.llm.LlmUsageService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/llm")
public class LlmKeyController {

	private final LlmKeyService keyService;
	private final LlmUsageService usageService;

	public LlmKeyController(LlmKeyService keyService, LlmUsageService usageService) {
		this.keyService = keyService;
		this.usageService = usageService;
	}

	public record CreateKeyRequest(
			@NotBlank String provider,
			@Size(max = 64) String label,
			String baseUrl,
			@NotBlank String apiKey) {
	}

	@PostMapping("/keys")
	@ResponseStatus(HttpStatus.CREATED)
	public LlmKeyService.KeyView create(@AuthenticationPrincipal AuthPrincipal principal,
			@Valid @RequestBody CreateKeyRequest request) {
		return keyService.create(principal.userId(), request.provider(), request.label(),
				request.baseUrl(), request.apiKey());
	}

	@GetMapping("/keys")
	public List<LlmKeyService.KeyView> list(@AuthenticationPrincipal AuthPrincipal principal) {
		return keyService.list(principal.userId());
	}

	@DeleteMapping("/keys/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void delete(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		keyService.delete(principal.userId(), id);
	}

	@GetMapping("/usage")
	public LlmUsageService.UsageSummary usage(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(defaultValue = "1") int days) {
		return usageService.summary(principal.userId(), days);
	}

}
