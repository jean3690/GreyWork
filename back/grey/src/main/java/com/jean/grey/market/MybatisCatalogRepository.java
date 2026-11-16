package com.jean.grey.market;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.jean.grey.market.entity.CatalogItem;
import com.jean.grey.market.mapper.CatalogItemMapper;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class MybatisCatalogRepository implements CatalogRepository {

	private final CatalogItemMapper mapper;

	public MybatisCatalogRepository(CatalogItemMapper mapper) {
		this.mapper = mapper;
	}

	@Override
	public List<CatalogItem> listEnabled(String kind) {
		return mapper.selectList(new LambdaQueryWrapper<CatalogItem>()
				.eq(CatalogItem::getKind, kind)
				.eq(CatalogItem::getEnabled, true)
				.orderByDesc(CatalogItem::getInstalls)
				.orderByAsc(CatalogItem::getName));
	}

	@Override
	public List<CatalogItem> listAll() {
		return mapper.selectList(new LambdaQueryWrapper<CatalogItem>()
				.orderByAsc(CatalogItem::getKind)
				.orderByAsc(CatalogItem::getName));
	}

	@Override
	public Optional<CatalogItem> findById(long id) {
		return Optional.ofNullable(mapper.selectById(id));
	}

	@Override
	public Optional<CatalogItem> findByRef(String kind, String itemRef) {
		return Optional.ofNullable(mapper.selectOne(new LambdaQueryWrapper<CatalogItem>()
				.eq(CatalogItem::getKind, kind)
				.eq(CatalogItem::getItemRef, itemRef)));
	}

	@Override
	public void insert(CatalogItem item) {
		mapper.insert(item);
	}

	@Override
	public void update(CatalogItem item) {
		mapper.updateById(item);
	}

	@Override
	public void deleteById(long id) {
		mapper.deleteById(id);
	}

	@Override
	public long count(String kind) {
		return mapper.selectCount(new LambdaQueryWrapper<CatalogItem>().eq(CatalogItem::getKind, kind));
	}

}
