package com.jean.grey.auth.web;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.auth.TokenService;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.common.ApiException;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/devices")
public class DeviceController {

	private final UserDeviceMapper userDeviceMapper;
	private final TokenService tokenService;

	public DeviceController(UserDeviceMapper userDeviceMapper, TokenService tokenService) {
		this.userDeviceMapper = userDeviceMapper;
		this.tokenService = tokenService;
	}

	public record DeviceItem(Long id, String name, String platform, LocalDateTime lastSeenAt,
			LocalDateTime createdAt, boolean current) {
	}

	@GetMapping
	public List<DeviceItem> list(@AuthenticationPrincipal AuthPrincipal principal) {
		return userDeviceMapper.selectList(Wrappers.<UserDevice>lambdaQuery()
				.eq(UserDevice::getUserId, principal.userId())
				.orderByDesc(UserDevice::getCreatedAt))
				.stream()
				.map(device -> new DeviceItem(device.getId(), device.getName(), device.getPlatform(),
						device.getLastSeenAt(), device.getCreatedAt(),
						device.getId().equals(principal.deviceId())))
				.toList();
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public void delete(@AuthenticationPrincipal AuthPrincipal principal, @PathVariable Long id) {
		UserDevice device = userDeviceMapper.selectById(id);
		if (device == null || !principal.userId().equals(device.getUserId())) {
			throw ApiException.notFound("device_not_found", "设备不存在");
		}
		userDeviceMapper.deleteById(id);
		tokenService.revokeDevice(id);
	}

}
