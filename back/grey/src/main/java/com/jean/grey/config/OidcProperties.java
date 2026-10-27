package com.jean.grey.config;

import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 外部身份源配置。没配 clientId 的 provider 视为未启用。
 */
@ConfigurationProperties(prefix = "grey.oidc")
public record OidcProperties(Map<String, Provider> providers, List<String> allowedRedirects) {

	public OidcProperties {
		providers = providers == null ? Map.of() : providers;
		allowedRedirects = allowedRedirects == null ? List.of() : allowedRedirects;
	}

	public record Provider(String clientId, String clientSecret, String authorizationUrl,
			String tokenUrl, String userinfoUrl, List<String> scopes, String subjectField,
			String emailField, String nameField, boolean linkByEmail) {

		public Provider {
			scopes = scopes == null || scopes.isEmpty() ? List.of("openid", "profile", "email") : scopes;
			subjectField = subjectField == null || subjectField.isBlank() ? "sub" : subjectField;
			nameField = nameField == null || nameField.isBlank() ? "name" : nameField;
		}

		public boolean enabled() {
			return clientId != null && !clientId.isBlank()
					&& authorizationUrl != null && !authorizationUrl.isBlank()
					&& tokenUrl != null && !tokenUrl.isBlank()
					&& userinfoUrl != null && !userinfoUrl.isBlank();
		}
	}

}
