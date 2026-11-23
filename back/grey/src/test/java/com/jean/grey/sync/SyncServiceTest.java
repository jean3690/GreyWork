package com.jean.grey.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.jean.grey.common.ApiException;
import com.jean.grey.sync.entity.SyncChange;
import com.jean.grey.sync.entity.SyncObject;
import com.jean.grey.sync.mapper.SyncChangeMapper;
import com.jean.grey.sync.mapper.SyncObjectMapper;
import org.apache.ibatis.annotations.Update;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DuplicateKeyException;
import tools.jackson.databind.json.JsonMapper;

class SyncServiceTest {

	private final SyncObjectMapper objects = mock(SyncObjectMapper.class);
	private final SyncChangeMapper changes = mock(SyncChangeMapper.class);
	private final PreferencesCodec codec = new PreferencesCodec(JsonMapper.builder().build());
	private final SyncService service = new SyncService(objects, changes, codec);
	private static final String PREFS = "{\"schemaVersion\":1,\"theme\":\"codex\",\"colorMode\":\"dark\",\"fontSize\":\"medium\",\"radius\":\"small\",\"locale\":\"zh-CN\"}";

	@BeforeEach
	void setup() {
		when(changes.insert(any(SyncChange.class))).thenAnswer(call -> {
			call.getArgument(0, SyncChange.class).setId(9223372036854775806L); return 1;
		});
	}

	@Test
	void onlyPublicFieldsReachTheCurrentObjectAndChangeHistory() {
		String input = PREFS.substring(0, PREFS.length() - 1) + ",\"permissionTier\":\"full\",\"apiKey\":\"secret\",\"workspaceDir\":\"/private\"}";
		service.push(7L, "settings", PreferencesCodec.OBJECT_ID, null, input);
		var object = ArgumentCaptor.forClass(SyncObject.class);
		var change = ArgumentCaptor.forClass(SyncChange.class);
		verify(objects).insert(object.capture()); verify(changes).insert(change.capture());
		assertThat(object.getValue().getPayload()).doesNotContain("secret", "workspaceDir", "permissionTier");
		assertThat(change.getValue().getPayload()).isEqualTo(object.getValue().getPayload());
	}

	@Test
	void futureSchemaIsRejectedBeforeReadingOrWritingTheDatabase() {
		assertThatThrownBy(() -> service.push(7L, "settings", PreferencesCodec.OBJECT_ID, null, PREFS.replace("Version\":1", "Version\":2")))
				.isInstanceOf(ApiException.class);
		verifyNoInteractions(objects, changes);
	}

	@Test
	void updateUsesTheExpectedRevisionAndRejectsALostRace() throws Exception {
		var old = new SyncObject(); old.setUserId(7L); old.setKind("settings"); old.setObjectId("theme"); old.setRevision(41L);
		when(objects.find(7L, "settings", "theme")).thenReturn(old);
		when(objects.update(any(SyncObject.class), eq(41L))).thenReturn(0);
		assertThatThrownBy(() -> service.push(7L, "settings", "theme", 41L, "{}"))
				.isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getStatus().value()).isEqualTo(409));
		verify(objects).update(any(SyncObject.class), eq(41L));
		String sql = String.join("\n", SyncObjectMapper.class.getMethod("update", SyncObject.class, Long.class).getAnnotation(Update.class).value());
		assertThat(sql).contains("AND revision = #{baseRevision}");
	}

	@Test
	void aConcurrentFirstInsertProducesAConflictNotAnInternalError() {
		when(objects.insert(any(SyncObject.class))).thenThrow(new DuplicateKeyException("concurrent create"));
		assertThatThrownBy(() -> service.push(7L, "settings", "theme", null, "{}"))
				.isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getStatus().value()).isEqualTo(409));
	}

	@Test
	void readingTheCurrentPreferenceUsesTheAuthenticatedUser() {
		service.get(7L, "settings", PreferencesCodec.OBJECT_ID);
		verify(objects).find(7L, "settings", PreferencesCodec.OBJECT_ID);
	}
}
