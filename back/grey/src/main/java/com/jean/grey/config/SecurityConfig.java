package com.jean.grey.config;

import com.jean.grey.auth.BearerTokenFilter;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Arrays;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
public class SecurityConfig {

	@Bean
	SecurityFilterChain securityFilterChain(HttpSecurity http, BearerTokenFilter tokenFilter)
			throws Exception {
		http
				.csrf(csrf -> csrf.disable())
				.cors(cors -> cors.configurationSource(corsSource()))
				.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
				.authorizeHttpRequests(auth -> auth
						.requestMatchers(HttpMethod.POST, "/api/auth/enroll").permitAll()
						.requestMatchers("/api/auth/oidc/**").permitAll()
						.requestMatchers(HttpMethod.POST, "/api/channels/webhook/*").permitAll()
					// 运维台登录本身必须匿名可达（它就是拿 token 的入口），其余 /api/admin/** 仍要 admin。
					.requestMatchers(HttpMethod.POST, "/api/admin/auth/login").permitAll()
					.requestMatchers(HttpMethod.GET, "/api/market/packages", "/api/market/packages/**",
							"/api/market/registry.json", "/api/market/download/**").permitAll()
						.requestMatchers("/actuator/health", "/actuator/health/**").permitAll()
						// 运维台页面（Vue SPA 产物 + 同源 fetch）公开可取：页面不含数据，数据面在 /api/admin/**。
						.requestMatchers("/admin", "/admin/", "/admin/**").permitAll()
						// 运维面：角色由 BearerTokenFilter 按库里的 role 列写成 ROLE_ADMIN。
						.requestMatchers("/api/admin/**").hasRole("ADMIN")
						.anyRequest().authenticated())
				.exceptionHandling(ex -> ex.authenticationEntryPoint((request, response, failure) -> {
					response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
					response.setContentType("application/json;charset=UTF-8");
					response.getWriter().write("{\"code\":\"unauthorized\",\"message\":\"未登录或凭据已失效\"}");
				}))
				.addFilterBefore(tokenFilter, UsernamePasswordAuthenticationFilter.class);
		return http.build();
	}

	@Value("${grey.web.allowed-origins:http://localhost:5173}")
	private String allowedOrigins;

	private CorsConfigurationSource corsSource() {
		CorsConfiguration config = new CorsConfiguration();
		config.setAllowedOrigins(Arrays.stream(allowedOrigins.split(","))
				.map(String::trim)
				.filter(origin -> !origin.isEmpty())
				.toList());
		config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
		config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
		config.setMaxAge(3600L);
		UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
		source.registerCorsConfiguration("/api/**", config);
		return source;
	}

}
