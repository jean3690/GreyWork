package com.jean.grey.storage.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.storage.StorageService;
import java.util.List;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 对象存储 HTTP 面。未启用时 config 仍可访问（前端据此隐藏入口），其余接口 409。
 */
@RestController
@RequestMapping("/api/storage")
public class StorageController {

	private final StorageService storageService;

	public StorageController(StorageService storageService) {
		this.storageService = storageService;
	}

	public record CreateUploadRequest(String name, String contentType, Long sizeBytes,
			String sha256, String visibility) {
	}

	@GetMapping("/config")
	public StorageService.ConfigView config() {
		return storageService.config();
	}

	@PostMapping("/uploads")
	public StorageService.UploadTicket createUpload(
			@AuthenticationPrincipal AuthPrincipal principal,
			@RequestBody CreateUploadRequest request) {
		return storageService.createUpload(principal.userId(), request.name(),
				request.contentType(), request.sizeBytes(), request.sha256(),
				request.visibility());
	}

	@PostMapping("/objects/{id}/complete")
	public StorageService.ObjectView complete(
			@AuthenticationPrincipal AuthPrincipal principal, @PathVariable long id) {
		return storageService.completeUpload(principal.userId(), id);
	}

	@GetMapping("/objects")
	public List<StorageService.ObjectView> list(
			@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(defaultValue = "50") int limit) {
		return storageService.list(principal.userId(), limit);
	}

	@GetMapping("/objects/{id}")
	public StorageService.ObjectView get(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long id) {
		return storageService.get(principal.userId(), id);
	}

	@GetMapping("/objects/{id}/download")
	public StorageService.DownloadTicket download(
			@AuthenticationPrincipal AuthPrincipal principal, @PathVariable long id) {
		return storageService.download(principal.userId(), id);
	}

	@DeleteMapping("/objects/{id}")
	public Map<String, Object> delete(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable long id) {
		storageService.delete(principal.userId(), id);
		return Map.of("deleted", true);
	}

}
