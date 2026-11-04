/** base64 编解码：终端输出按原始字节送给前端（xterm 要 Uint8Array，不要 UTF-8 字符串）。 */
export function base64Encode(data: string | Buffer): string {
  return (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64");
}
