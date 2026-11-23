package com.jean.grey.sync;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.common.ApiErrorHandler;
import com.jean.grey.sync.web.PreferencesSyncController;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.json.JsonMapper;

class PreferencesSyncControllerTest {

	private final SyncService sync = mock(SyncService.class);
	private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new PreferencesSyncController(sync,
			new PreferencesCodec(JsonMapper.builder().build())))
			.setControllerAdvice(new ApiErrorHandler())
			.setCustomArgumentResolvers(new HandlerMethodArgumentResolver() {
				public boolean supportsParameter(MethodParameter parameter) { return parameter.getParameterType() == AuthPrincipal.class; }
				public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer container,
						NativeWebRequest request, WebDataBinderFactory factory) { return new AuthPrincipal(7L, 9L); }
			}).build();

	@Test
	void aMissingObjectReturnsAnExplicitEmptySnapshot() throws Exception {
		mvc.perform(get("/api/sync/preferences")).andExpect(status().isOk())
				.andExpect(jsonPath("$.revision").isEmpty()).andExpect(jsonPath("$.deleted").value(false))
				.andExpect(jsonPath("$.payload").isEmpty());
		verify(sync).get(7L, "settings", PreferencesCodec.OBJECT_ID);
	}

	@Test
	void longRevisionsRemainStringsInReadsAndWriteReceipts() throws Exception {
		when(sync.get(7L, "settings", PreferencesCodec.OBJECT_ID))
				.thenReturn(new SyncService.ChangeView("settings", PreferencesCodec.OBJECT_ID, 9223372036854775806L, true, null));
		mvc.perform(get("/api/sync/preferences")).andExpect(status().isOk())
				.andExpect(jsonPath("$.revision").value("9223372036854775806"));
		when(sync.push(eq(7L), eq("settings"), eq(PreferencesCodec.OBJECT_ID), eq(9223372036854775806L), any()))
				.thenReturn(new SyncService.PushResult("settings", PreferencesCodec.OBJECT_ID, 9223372036854775807L));
		mvc.perform(put("/api/sync/preferences").contentType(MediaType.APPLICATION_JSON)
				.content("{\"baseRevision\":\"9223372036854775806\",\"payload\":{}}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("9223372036854775807"));
	}

	@Test
	void overflowingAndMalformedVersionsAreRejected() throws Exception {
		mvc.perform(put("/api/sync/preferences").contentType(MediaType.APPLICATION_JSON)
				.content("{\"baseRevision\":\"9223372036854775808\",\"payload\":{}}"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("sync_revision_invalid"));
		mvc.perform(put("/api/sync/preferences").contentType(MediaType.APPLICATION_JSON)
				.content("{\"baseRevision\":123,\"payload\":{}}"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("sync_revision_invalid"));
	}
}
