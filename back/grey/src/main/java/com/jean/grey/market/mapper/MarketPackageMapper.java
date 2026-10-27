package com.jean.grey.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.market.entity.MarketPackage;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface MarketPackageMapper extends BaseMapper<MarketPackage> {

}
