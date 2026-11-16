package com.jean.grey.market;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** 内置目录（resources/catalog/*.json）能被解析成领域对象 —— 它是首次启动的种子。 */
class CatalogBundledTest {

	private static CatalogBundled bundled;

	@BeforeAll
	static void load() {
		bundled = new CatalogBundled(JsonMapper.builder().build());
	}

	@Test
	@DisplayName("技能种子包含 SKILL.md 且 ref 三段")
	void skillsAreParsed() {
		assertThat(bundled.skills()).isNotEmpty();
		bundled.skills().forEach(skill -> {
			assertThat(skill.ref().split("/")).hasSize(3);
			assertThat(skill.files()).isNotEmpty();
			assertThat(skill.files()).anySatisfy(file -> assertThat(file.path()).isEqualTo("SKILL.md"));
		});
	}

	@Test
	@DisplayName("MCP 种子带可登记的包类型")
	void serversAreParsed() {
		assertThat(bundled.servers()).isNotEmpty();
		bundled.servers().forEach(server -> {
			assertThat(server.name()).isNotBlank();
			assertThat(server.packages()).isNotEmpty();
			assertThat(server.packages().getFirst().registryType()).isIn("npm", "pypi");
		});
	}

}
