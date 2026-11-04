package com.jean.grey.account.web;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * 运维台的入口：Vue SPA 的构建产物在 `static/admin/index.html`（源码 apps/admin）。
 *
 * 为什么不让框架自己找目录索引：静态资源处理器不认 `/admin/`，直接返回文件既保住短地址
 * （反代按前缀暴露时只配一条），也让 MockMvc 里能断言到真实内容（forward 在测试里只拿到空体）。
 * 路由用 hash（/admin/#/users），所以这里只需要这一条映射，不用给每个前端路由补 fallback。
 * 页面本身公开可取 —— 里面没有任何数据，真正的门禁在 `/api/admin/**`。
 */
@Controller
public class AdminPageController {

	private static final String PAGE = "static/admin/index.html";

	@GetMapping({ "/admin", "/admin/" })
	public ResponseEntity<Resource> console() {
		return ResponseEntity.ok()
				// 显式带 charset：静态文件是 UTF-8 中文，靠响应头而不是 meta 嗅探。
				.contentType(MediaType.parseMediaType("text/html;charset=UTF-8"))
				.body(new ClassPathResource(PAGE));
	}

}
