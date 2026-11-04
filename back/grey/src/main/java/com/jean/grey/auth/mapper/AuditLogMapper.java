package com.jean.grey.auth.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.auth.entity.AuditLog;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AuditLogMapper extends BaseMapper<AuditLog> {
}
