package com.jean.grey.config;

import com.baomidou.mybatisplus.core.handlers.MetaObjectHandler;
import java.time.LocalDateTime;
import org.apache.ibatis.reflection.MetaObject;
import org.springframework.stereotype.Component;

@Component
public class AuditFieldFillHandler implements MetaObjectHandler {

	@Override
	public void insertFill(MetaObject metaObject) {
		LocalDateTime now = LocalDateTime.now();
		strictInsertFill(metaObject, "createdAt", LocalDateTime.class, now);
		strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, now);
	}

	@Override
	public void updateFill(MetaObject metaObject) {
		strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
	}

}
