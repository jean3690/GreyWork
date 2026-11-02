package com.jean.grey.auth;

import com.jean.grey.account.entity.AppUser;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
					// 账号被禁用 / 删除后，手上还没过期的 token 也必须立刻失效。
					// 顺手把会话回收：之后同一枚 token 连「查库」这一步都不用走，直接 401。
					AppUser user = authService.loadActive(principal.userId());
					if (user == null) {
						tokenService.revoke(token);
						return;
					}
					// 角色随每请求从库里取：改名单 / 降权下一次请求即生效，不需要重发 token。
					List<SimpleGrantedAuthority> authorities = RolePolicy.isAdminRole(user.getRole())
							? List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))
							: List.of();
					var authentication = new UsernamePasswordAuthenticationToken(principal, token, authorities);
					SecurityContextHolder.getContext().setAuthentication(authentication);
					request.setAttribute(ATTR_TOKEN, token);
					// 设备心跳命中（5 分钟一次）时顺带把会话 TTL 拉满：语义从「登录后 30 天」
					// 变成「空闲 30 天」，一直有活动的设备不会被突然登出。
					if (authService.touch(principal.deviceId())) {
						tokenService.extend(token);
					}
				});
		}
		chain.doFilter(request, response);
	}

}
