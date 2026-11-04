package com.jean.grey.llm.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.jean.grey.llm.entity.LlmUsage;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface LlmUsageMapper extends BaseMapper<LlmUsage> {

	@Select("""
			SELECT COUNT(*) AS requests,
			       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
			       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
			       COALESCE(SUM(total_tokens), 0) AS total_tokens
			FROM llm_usage
			WHERE user_id = #{userId} AND created_at >= #{since}
			""")
	Map<String, Object> summary(@Param("userId") Long userId, @Param("since") LocalDateTime since);

	/** 运维台：跨用户汇总（无 userId 条件）。 */
	@Select("""
			SELECT COUNT(*) AS requests,
			       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
			       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
			       COALESCE(SUM(total_tokens), 0) AS total_tokens
			FROM llm_usage
			WHERE created_at >= #{since}
			""")
	Map<String, Object> summaryAll(@Param("since") LocalDateTime since);

	/** 运维台：按供应商拆分（用量卡片里的占比条）。 */
	@Select("""
			SELECT provider,
			       COUNT(*) AS requests,
			       COALESCE(SUM(total_tokens), 0) AS total_tokens
			FROM llm_usage
			WHERE created_at >= #{since}
			GROUP BY provider
			ORDER BY total_tokens DESC
			""")
	List<Map<String, Object>> summaryByProvider(@Param("since") LocalDateTime since);

}
