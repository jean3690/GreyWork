/**
 * 文件内容探测：移植 `crates/greywork-host/src/core/text.rs` 的判定口径。
 *
 * 用途是 `fs_probe_file`：预览面板据此决定「文本视图 / 二进制占位」以及「能不能就地编辑」。
 * 三条判据与 Rust 逐条对齐，任何一条走偏都会让一批正常文件被锁成只读或显示成乱码。
 */
import { closeSync, openSync, readSync } from "node:fs";

export const PROBE_PREFIX_BYTES = 8 * 1024;

export interface FileProbe {
  size: number;
  binary: boolean;
  utf8: boolean;
  bom: boolean;
  crlf: boolean;
}

/** 读文件开头最多 max 字节（探测用，不整个读进来）。 */
export function readPrefix(file: string, max: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(max, PROBE_PREFIX_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function hasUtf8Bom(prefix: Buffer): boolean {
  return prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
}

/**
 * 前缀能否按 UTF-8 解码。**末尾被截断的半个多字节字符不算失败**：前缀按固定字节切，
 * 多字节字符跨在边界上是常态，判成非 UTF-8 会把一大批正常文件锁成只读。
 */
export function isUtf8Prefix(prefix: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    return true;
  } catch {
    // 只有「输入意外结束」才算可续接；其余非法序列一律不认。
    return isTruncatedUtf8(prefix);
  }
}

/** 末尾是否是「被截断的多字节序列」：最多回退 3 个字节找一个合法的起始字节。 */
function isTruncatedUtf8(buffer: Buffer): boolean {
  for (let trim = 1; trim <= 3 && trim <= buffer.length; trim += 1) {
    const candidate = buffer.subarray(0, buffer.length - trim);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      const last = buffer[buffer.length - trim];
      // 回退处必须是多字节字符的起始字节（110/1110/11110 前缀）。
      return last >= 0xc0 && last <= 0xf7;
    } catch {
      continue;
    }
  }
  return false;
}

/** 首个换行是 CRLF 吗；前缀里没有换行时按 LF 处理。 */
export function usesCrlf(prefix: Buffer): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    const byte = prefix[index];
    if (byte === 0x0a) return index > 0 && prefix[index - 1] === 0x0d;
    if (byte === 0x0d) return prefix[index + 1] === 0x0a;
  }
  return false;
}

/** 控制字符：除 `\t` `\n` `\r` `\x0c` 之外的 ASCII 控制符（不含 NUL，NUL 单独判）。 */
function isControl(byte: number): boolean {
  return (byte >= 0x01 && byte <= 0x08) || byte === 0x0b || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f;
}

function looksUtf16(prefix: Buffer): boolean {
  const sample = prefix.subarray(0, Math.min(prefix.length, 64));
  if (sample.length < 4) return false;
  let oddNul = 0;
  let evenNul = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 1) oddNul += 1;
    else evenNul += 1;
  }
  const side = Math.floor(sample.length / 2);
  return oddNul * 10 >= side * 9 || evenNul * 10 >= side * 9;
}

/** 前缀看起来是不是二进制：UTF-16 BOM 放行、NUL（非 UTF-16 迹象）即二进制、控制字符占比 >30%。 */
export function looksBinary(prefix: Buffer): boolean {
  if (prefix.length === 0) return false;
  if (prefix[0] === 0xff && prefix[1] === 0xfe) return false;
  if (prefix[0] === 0xfe && prefix[1] === 0xff) return false;
  if (prefix.includes(0) && !looksUtf16(prefix)) return true;
  let control = 0;
  for (const byte of prefix) {
    if (isControl(byte)) control += 1;
  }
  return control * 10 > prefix.length * 3;
}

export function probeBytes(prefix: Buffer, size: number): FileProbe {
  return {
    size,
    binary: looksBinary(prefix),
    utf8: isUtf8Prefix(prefix),
    bom: hasUtf8Bom(prefix),
    crlf: usesCrlf(prefix),
  };
}
