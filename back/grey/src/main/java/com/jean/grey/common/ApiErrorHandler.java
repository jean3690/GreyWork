package com.jean.grey.common;

import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiErrorHandler {

	private static final Logger log = LoggerFactory.getLogger(ApiErrorHandler.class);

	@ExceptionHandler(ApiException.class)
	ResponseEntity<Map<String, Object>> handleApi(ApiException ex) {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("code", ex.getCode());
		body.put("message", ex.getMessage());
		body.putAll(ex.getDetails());
		return ResponseEntity.status(ex.getStatus()).body(body);
	}

	@ExceptionHandler(MethodArgumentNotValidException.class)
	ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex) {
		Map<String, String> fields = new LinkedHashMap<>();
		ex.getBindingResult().getFieldErrors()
				.forEach(err -> fields.putIfAbsent(err.getField(), err.getDefaultMessage()));
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("code", "validation_failed");
		body.put("message", "请求参数不合法");
		body.put("fields", fields);
		return ResponseEntity.badRequest().body(body);
	}

	@ExceptionHandler(Exception.class)
	ResponseEntity<Map<String, Object>> handleOther(Exception ex) {
		log.error("unhandled error", ex);
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("code", "internal_error");
		body.put("message", "服务内部错误");
		return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
	}

}
