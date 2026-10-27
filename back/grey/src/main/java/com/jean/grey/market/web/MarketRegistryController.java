package com.jean.grey.market.web;

import com.jean.grey.market.MarketService;
import java.net.URI;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MarketRegistryController {

	private final MarketService marketService;

	public MarketRegistryController(MarketService marketService) {
		this.marketService = marketService;
	}

	/** 宿主可直接消费的注册表；bucket 用来做灰度分流。 */
	@GetMapping("/api/market/registry.json")
	public ResponseEntity<byte[]> registry(@RequestParam(defaultValue = "0") int bucket,
			@RequestParam(required = false) String channel,
			@RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false) String ifNoneMatch) {
		MarketService.RegistryArtifact artifact = marketService.registry(bucket, channel);
		if (artifact.etag().equals(ifNoneMatch)) {
			return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(artifact.etag()).build();
		}
		return ResponseEntity.ok()
				.eTag(artifact.etag())
				.cacheControl(CacheControl.noCache())
				.contentType(org.springframework.http.MediaType.APPLICATION_JSON)
				.body(artifact.body());
	}

	@GetMapping("/api/market/download/{slug}/{version}")
	public ResponseEntity<Void> download(@PathVariable String slug, @PathVariable String version) {
		String target = marketService.download(slug, version);
		return ResponseEntity.status(HttpStatus.FOUND)
				.location(URI.create(target))
				.build();
	}

}
