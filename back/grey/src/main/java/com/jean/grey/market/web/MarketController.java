package com.jean.grey.market.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.market.MarketService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/market")
public class MarketController {

	private final MarketService marketService;

	public MarketController(MarketService marketService) {
		this.marketService = marketService;
	}

	public record CreatePackageRequest(
			@NotBlank @Size(max = 96) String slug,
			@NotBlank @Size(max = 128) String name,
			@Size(max = 64) String author,
			@Size(max = 255) String summary,
			String description,
			@Size(max = 32) String category,
			List<String> tags) {
	}

	public record PublishVersionRequest(
			@NotBlank String version,
			@NotBlank String downloadUrl,
			@NotBlank String sha256,
			String changelog,
			String channel,
			Integer rolloutPercent) {
	}

	public record RolloutRequest(int percent) {
	}

	public record StatusRequest(@NotBlank String status) {
	}

	@PostMapping("/packages")
	@ResponseStatus(HttpStatus.CREATED)
	public MarketService.PackageView create(@AuthenticationPrincipal AuthPrincipal principal,
			@Valid @RequestBody CreatePackageRequest request) {
		return marketService.createPackage(principal.userId(), request.slug(), request.name(),
				request.author(), request.summary(), request.description(), request.category(),
				request.tags());
	}

	@PostMapping("/packages/{slug}/versions")
	@ResponseStatus(HttpStatus.CREATED)
	public MarketService.VersionView publish(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String slug, @Valid @RequestBody PublishVersionRequest request) {
		return marketService.addVersion(principal.userId(), slug, request.version(),
				request.downloadUrl(), request.sha256(), request.changelog(), request.channel(),
				request.rolloutPercent());
	}

	@PostMapping("/packages/{slug}/versions/{version}/rollout")
	public MarketService.VersionView rollout(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String slug, @PathVariable String version,
			@RequestBody RolloutRequest request) {
		return marketService.setRollout(principal.userId(), slug, version, request.percent());
	}

	@PostMapping("/packages/{slug}/status")
	public MarketService.PackageView status(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String slug, @Valid @RequestBody StatusRequest request) {
		return marketService.setStatus(principal.userId(), slug, request.status());
	}

	@GetMapping("/packages")
	public MarketService.SearchPage search(@RequestParam(required = false) String q,
			@RequestParam(required = false) String category,
			@RequestParam(defaultValue = "1") int page,
			@RequestParam(defaultValue = "20") int size) {
		return marketService.search(q, category, page, size);
	}

	@GetMapping("/packages/{slug}")
	public MarketService.DetailView detail(@PathVariable String slug) {
		return marketService.detail(slug);
	}

}
