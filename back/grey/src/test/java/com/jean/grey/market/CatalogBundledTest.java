package com.jean.grey.market;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
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

	@Test
	@DisplayName("下载测试目录有三个技能与两个可获取的 npm tgz 包")
	void downloadDemosAreBundled() throws Exception {
		assertThat(bundled.skills().stream().filter(skill -> skill.ref().startsWith("greywork/tests/")))
				.extracting(CatalogTypes.SkillEntry::skillId)
				.containsExactly("demo-hello", "demo-checklist", "demo-summary");
		var demos = bundled.servers().stream().filter(server -> server.name().startsWith("io.greywork.demo/")).toList();
		assertThat(demos).hasSize(2);
		for (var server : demos) {
			var pkg = server.packages().getFirst();
			assertThat(pkg.environmentVariables()).isEmpty();
			var resource = new ClassPathResource("static" + pkg.identifier());
			assertThat(resource.exists()).as(pkg.identifier()).isTrue();
			try (var stream = new GZIPInputStream(resource.getInputStream())) {
				assertThat(stream.readAllBytes().length).isGreaterThan(1024);
			}
		}
	}

}
