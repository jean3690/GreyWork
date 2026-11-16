package com.jean.grey.market;

import com.jean.grey.market.entity.CatalogItem;
import java.util.List;
import java.util.Optional;

/**
 * 目录存储抽象：为了 CatalogService 能在不起 Spring / 数据库的情况下被单测
 * （假实现直接给一组条目），生产实现见 {@link MybatisCatalogRepository}。
 */
public interface CatalogRepository {

	List<CatalogItem> listEnabled(String kind);

	List<CatalogItem> listAll();

	Optional<CatalogItem> findById(long id);

	Optional<CatalogItem> findByRef(String kind, String itemRef);

	void insert(CatalogItem item);

	void update(CatalogItem item);

	void deleteById(long id);

	long count(String kind);

}
