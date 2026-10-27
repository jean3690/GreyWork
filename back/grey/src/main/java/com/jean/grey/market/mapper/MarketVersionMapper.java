package com.jean.grey.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.market.entity.MarketVersion;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface MarketVersionMapper extends BaseMapper<MarketVersion> {

	@Update("UPDATE market_version SET downloads = downloads + 1 WHERE id = #{id}")
	int incrementDownloads(@Param("id") Long id);

}
