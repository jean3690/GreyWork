package com.jean.grey.auth;

import java.io.Serializable;

/**
 * 登录态主体：一次请求对应一个用户的一台设备。
 */
public record AuthPrincipal(Long userId, Long deviceId) implements Serializable {

}
