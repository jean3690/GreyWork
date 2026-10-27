package com.jean.grey.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class BearerTokenFilter extends OncePerRequestFilter {

	public static final String ATTR_TOKEN = "grey.token";

	private final TokenService tokenService;
	private final AuthService authService;

	public BearerTokenFilter(TokenService tokenService, AuthService authService) {
		this.tokenService = tokenService;
		this.authService = authService;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
			FilterChain chain) throws ServletException, IOException {
		String header = request.getHeader("Authorization");
		if (header != null && header.startsWith("Bearer ")) {
			String token = header.substring(7).trim();
				tokenService.resolve(token).ifPresent(principal -> {
					var authentication = new UsernamePasswordAuthenticationToken(principal, token, List.of());
					SecurityContextHolder.getContext().setAuthentication(authentication);
					request.setAttribute(ATTR_TOKEN, token);
					authService.touch(principal.deviceId());
				});
		}
		chain.doFilter(request, response);
	}

}
