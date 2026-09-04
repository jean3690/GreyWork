import { describe, expect, it } from "vitest";
import { assertSqlAllowed, classifySqlRisk, SqlRiskError, stripSqlComments } from "../../src/sql-risk";

describe("classifySqlRisk", () => {
  it("识别只读查询", () => {
    expect(classifySqlRisk("SELECT * FROM cities")).toBe("read-only");
    expect(classifySqlRisk("WITH base AS (SELECT 1) SELECT * FROM base")).toBe("read-only");
    expect(classifySqlRisk("SHOW TABLES")).toBe("read-only");
    expect(classifySqlRisk("DESCRIBE cities")).toBe("read-only");
    expect(classifySqlRisk("EXPLAIN SELECT 1")).toBe("read-only");
    expect(classifySqlRisk("VALUES (1), (2)")).toBe("read-only");
  });

  it("识别写语句", () => {
    expect(classifySqlRisk("INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifySqlRisk("UPDATE t SET a = 1")).toBe("write");
    expect(classifySqlRisk("DELETE FROM t")).toBe("write");
    expect(classifySqlRisk("MERGE INTO t USING s ON t.id = s.id")).toBe("write");
    expect(classifySqlRisk("COPY t FROM 'file.csv'")).toBe("write");
  });

  it("识别 DDL", () => {
    expect(classifySqlRisk("CREATE TABLE t (id INT)")).toBe("ddl");
    expect(classifySqlRisk("ALTER TABLE t ADD COLUMN a INT")).toBe("ddl");
    expect(classifySqlRisk("DROP TABLE t")).toBe("ddl");
    expect(classifySqlRisk("TRUNCATE TABLE t")).toBe("ddl");
    expect(classifySqlRisk("GRANT SELECT ON t TO r")).toBe("ddl");
  });

  it("识别事务控制", () => {
    expect(classifySqlRisk("BEGIN")).toBe("transaction");
    expect(classifySqlRisk("COMMIT")).toBe("transaction");
    expect(classifySqlRisk("ROLLBACK")).toBe("transaction");
  });

  it("大小写不敏感", () => {
    expect(classifySqlRisk("select * from t")).toBe("read-only");
    expect(classifySqlRisk("DELETE FROM t")).toBe("write");
    expect(classifySqlRisk("Create Table t (a int)")).toBe("ddl");
  });

  it("剥离注释后分类", () => {
    expect(classifySqlRisk("-- 只读查询\nSELECT * FROM t")).toBe("read-only");
    expect(classifySqlRisk("/* 写操作 */ INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifySqlRisk("SELECT 1 -- 内嵌注释仍只读")).toBe("read-only");
    expect(classifySqlRisk("SELECT '-- 字符串里的注释'")).toBe("read-only");
    expect(classifySqlRisk("SELECT '/* 不是注释 */'")).toBe("read-only");
  });

  it("多语句取首条", () => {
    expect(classifySqlRisk("SELECT 1; DELETE FROM t")).toBe("read-only");
    expect(classifySqlRisk("DELETE FROM t; SELECT 1")).toBe("write");
  });

  it("无法识别返回 unknown", () => {
    expect(classifySqlRisk("")).toBe("unknown");
    expect(classifySqlRisk("   ")).toBe("unknown");
    expect(classifySqlRisk("12345")).toBe("unknown");
    expect(classifySqlRisk("-- 只有注释")).toBe("unknown");
  });

  it("stripSqlComments 保持字符串内容", () => {
    expect(stripSqlComments("SELECT '-- 注释' FROM t")).toContain("'-- 注释'");
    expect(stripSqlComments("SELECT '/* 注释 */'")).toContain("'/* 注释 */'");
    expect(stripSqlComments("SELECT 1 -- 行注释\n")).toBe("SELECT 1 ");
  });
});

describe("assertSqlAllowed（只读默认策略）", () => {
  it("只读语句默认放行", () => {
    expect(assertSqlAllowed("SELECT * FROM t")).toBe("read-only");
  });

  it("写语句未显式允许时抛 SqlRiskError", () => {
    expect(() => assertSqlAllowed("INSERT INTO t VALUES (1)")).toThrow(SqlRiskError);
    expect(() => assertSqlAllowed("INSERT INTO t VALUES (1)")).toThrow(/写操作/);
  });

  it("DDL 未显式允许时抛 SqlRiskError", () => {
    expect(() => assertSqlAllowed("DROP TABLE t")).toThrow(SqlRiskError);
    expect(() => assertSqlAllowed("DROP TABLE t")).toThrow(/DDL/);
  });

  it("allowWrite 显式放行写/DDL 并返回风险等级", () => {
    expect(assertSqlAllowed("INSERT INTO t VALUES (1)", { allowWrite: true })).toBe("write");
    expect(assertSqlAllowed("CREATE TABLE t (a INT)", { allowWrite: true })).toBe("ddl");
  });

  it("事务控制与无法识别语句一律拒绝（fail-closed）", () => {
    expect(() => assertSqlAllowed("BEGIN")).toThrow(SqlRiskError);
    expect(() => assertSqlAllowed("BEGIN")).toThrow(/事务控制/);
    expect(() => assertSqlAllowed("garbage")).toThrow(SqlRiskError);
  });
});
