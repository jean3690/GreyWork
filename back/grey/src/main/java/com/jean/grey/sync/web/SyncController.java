package com.jean.grey.sync.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.sync.SyncService;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/sync")
public class SyncController {

	private final SyncService syncService;
	private final ObjectMapper objectMapper;

	public SyncController(SyncService syncService, ObjectMapper objectMapper) {
		this.syncService = syncService;
		this.objectMapper = objectMapper;
	}

	public record ChangeItem(String kind, String objectId, Long revision, boolean deleted,
			JsonNode payload) {
	}

	public record ChangesResponse(Long revision, boolean hasMore, List<ChangeItem> changes) {
	}

	public record PushRequest(Long baseRevision, JsonNode payload) {
	}

	public record PushResponse(String kind, String objectId, Long revision) {
	}

	@GetMapping("/changes")
	public ChangesResponse changes(@AuthenticationPrincipal AuthPrincipal principal,
			@RequestParam(defaultValue = "0") long since,
			@RequestParam(defaultValue = "200") int limit) {
		SyncService.PullResult result = syncService.pull(principal.userId(), since, limit);
		List<ChangeItem> items = result.changes().stream()
				.map(change -> new ChangeItem(change.kind(), change.objectId(), change.revision(),
						change.deleted(), readPayload(change.payload())))
				.toList();
		return new ChangesResponse(result.revision(), result.hasMore(), items);
	}

	@PutMapping("/objects/{kind}/{objectId}")
	public PushResponse push(@AuthenticationPrincipal AuthPrincipal principal,
			@PathVariable String kind, @PathVariable String objectId,
			@RequestBody PushRequest request) {
		String payload = request.payload() == null ? null : request.payload().toString();
		SyncService.PushResult result = syncService.push(principal.userId(), kind, objectId,
				request.baseRevision(), payload);
		return new PushResponse(result.kind(), result.objectId(), result.revision());
	}

	@DeleteMapping("/objects/{kind}/{objectId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void remove(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable String kind,
			@PathVariable String objectId,
			@RequestParam(required = false) Long baseRevision) {
		syncService.remove(principal.userId(), kind, objectId, baseRevision);
	}

	private JsonNode readPayload(String raw) {
		return raw == null ? null : objectMapper.readTree(raw);
	}

}
