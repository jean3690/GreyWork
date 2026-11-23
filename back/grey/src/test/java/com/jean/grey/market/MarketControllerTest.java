package com.jean.grey.market;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jean.grey.market.web.MarketController;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class MarketControllerTest {

	@Test
	void packageUrlsFollowTheCurrentBackendAndContextPath() throws Exception {
		var catalog = mock(CatalogService.class);
		when(catalog.searchMcp(anyString(), anyInt(), anyString())).thenReturn(Map.of("servers", java.util.List.of()));
		var mvc = MockMvcBuilders.standaloneSetup(new MarketController(catalog)).build();
		mvc.perform(get("https://java.test/grey/api/market/mcp/v0/servers?search=demo&limit=10")
				.contextPath("/grey").with(request -> {
					request.setServerPort(443);
					return request;
				}))
				.andExpect(status().isOk());
		verify(catalog).searchMcp("demo", 10, "https://java.test/grey");
	}
}
