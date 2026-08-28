// SQL 风险分级守卫（借鉴 DBX sql_risk 的只读/写/DDL/事务四级分类）。
// 启发式实现：剥离注释后按首条语句的首 token 分类，不引入 SQL 解析器依赖。
// 局限：无法识别子查询内嵌写语句、字符串内注释等；如需更高准确度可替换为
// node-sql-parser（API 不变）。

export type SqlRisk = "read-only" | "write" | "ddl" | "transaction" | "unknown";

export class SqlRiskError extends Error {
  readonly risk: SqlRisk;
  constructor(risk: SqlRisk, message: string) {
    super(message);
    this.name = "SqlRiskError";
    this.risk = risk;
  }
}

/** 事务控制语句：不应由数据查询路径发起 */
const TRANSACTION_KEYWORDS = new Set(["begin", "start", "commit", "rollback", "end"]);

/** 影响结构/权限的 DDL 语句 */
const DDL_KEYWORDS = new Set(["create", "alter", "drop", "truncate", "grant", "revoke", "attach", "detach", "comment", "analyze"]);

/** 修改数据或环境状态的写语句 */
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "merge", "replace", "copy", "load", "persist"]);

/** 只读查询语句 */
const READ_ONLY_KEYWORDS = new Set(["select", "with", "show", "describe", "explain", "pragma", "values"]);

/** 剥离 SQL 注释（-- 行注释 与 块注释），忽略单引号字符串内出现的注释符。 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inString) {
      out += ch;
      if (ch === "'") {
        // 转义单引号（'' 或 \'）
        if (next === "'" || next === "\\") {
          out += next ?? "";
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      if (i < sql.length) i += 1; // 连同换行一并消费
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 取首条非空语句的首个 token（小写），无有效语句返回 null。 */
export function firstKeyword(sql: string): string | null {
  const cleaned = stripSqlComments(sql);
  // 按分号切分（启发式：不考虑字符串内分号），取第一条非空语句
  const firstStatement = cleaned.split(";").find((part) => part.trim().length > 0);
  if (!firstStatement) return null;
  const match = /^\s*([a-zA-Z]+)/.exec(firstStatement);
  return match ? match[1].toLowerCase() : null;
}

/** 分类 SQL 风险等级。 */
export function classifySqlRisk(sql: string): SqlRisk {
  const keyword = firstKeyword(sql);
  if (!keyword) return "unknown";
  if (TRANSACTION_KEYWORDS.has(keyword)) return "transaction";
  if (DDL_KEYWORDS.has(keyword)) return "ddl";
  if (WRITE_KEYWORDS.has(keyword)) return "write";
  if (READ_ONLY_KEYWORDS.has(keyword)) return "read-only";
  return "unknown";
}

/**
 * 只读默认策略：read-only 放行；write/ddl 需显式 allowWrite；transaction/unknown 一律拒绝（fail-closed）。
 * 返回风险等级供调用方展示。
 */
export function assertSqlAllowed(sql: string, opts: { allowWrite?: boolean } = {}): SqlRisk {
  const risk = classifySqlRisk(sql);
  if (risk === "read-only") return risk;
  if (risk === "write" || risk === "ddl") {
    if (opts.allowWrite) return risk;
    throw new SqlRiskError(risk, `SQL 被守卫拦截：检测到 ${risk === "ddl" ? "DDL（结构变更）" : "写操作"}，未显式允许写执行。`);
  }
  throw new SqlRiskError(risk, `SQL 被守卫拦截：无法识别的语句或事务控制，已拒绝执行。`);
}
