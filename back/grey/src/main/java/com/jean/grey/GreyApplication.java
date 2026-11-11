package com.jean.grey;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;
import org.springframework.scheduling.annotation.EnableScheduling;

// 认证全走自定义 BearerTokenFilter + 库里角色。Spring Boot 默认兜底生成的随机开发账号
// 既用不上，又会在每次启动日志里打印一次明文密码，直接排除掉。
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@EnableScheduling
public class GreyApplication {

	public static void main(String[] args) {
		SpringApplication.run(GreyApplication.class, args);
	}

}
