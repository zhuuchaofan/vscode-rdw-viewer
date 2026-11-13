/**
 * 字节数据源抽象：把「内存中的 Uint8Array」与「磁盘上的大文件（按页缓存）」统一成同一套随机读取接口。
 *
 * - MemorySource：零拷贝直接切片（小文件、非本地 URI、单元测试使用）。
 * - PagedFileSource：只持有文件描述符 + 固定页数的 LRU 缓存（默认 32 × 1MB = 32MB），
 *   不把整份大文件读入内存，突破 Node.js 单 Buffer 上限（2GB~4GB）并大幅降低内存占用。
 *
 * 本模块不依赖 VS Code，便于直接用 node --test 测试。
 */
import * as fs from 'fs';

export interface ByteSource {
  readonly size: number;
  /** 若底层已经是完整内存缓冲区则直接暴露（供零拷贝快速路径使用），分页文件源为 undefined */
  readonly raw?: Uint8Array;
  /**
   * 读取 [offset, offset + length) 的字节。
   * 注意：分页源返回的视图可能在后续读取挤出缓存页或跨越页边界复用暂存区时失效；
   * 如需长期持有，调用方应自行拷贝。
   */
  read(offset: number, length: number): Uint8Array;
  /** 释放底层文件描述符（内存源为空操作） */
  close(): void;
}

export function isByteSource(x: Uint8Array | ByteSource): x is ByteSource {
  return !(x instanceof Uint8Array) && typeof (x as ByteSource).read === 'function';
}

export function toByteSource(src: Uint8Array | ByteSource): ByteSource {
  return isByteSource(src) ? src : new MemorySource(src);
}

/** 内存数据源：直接基于已有 Uint8Array 切片 */
export class MemorySource implements ByteSource {
  readonly size: number;
  readonly raw: Uint8Array;

  constructor(buf: Uint8Array) {
    this.raw = buf;
    this.size = buf.byteLength;
  }

  read(offset: number, length: number): Uint8Array {
    if (length <= 0 || offset >= this.size) {
      return this.raw.subarray(0, 0);
    }
    const start = Math.max(0, offset);
    const end = Math.min(this.size, offset + length);
    return this.raw.subarray(start, end);
  }

  close(): void {}
}

export interface PagedFileOptions {
  /** 单页字节数（须为正整数，默认 1MB） */
  pageSize?: number;
  /** 最多缓存的页数（默认 32 页，即最多缓存 32MB） */
  maxPages?: number;
}

const DEFAULT_PAGE_SIZE = 1 << 20; // 1 MiB
const DEFAULT_MAX_PAGES = 32; // 32 MiB

interface CachePage {
  data: Uint8Array;
  validLen: number;
}

/**
 * 基于文件描述符的分页随机读取源（LRU 缓存）。
 * - 页内读取直接返回缓存页的 subarray（零分配）。
 * - 跨页读取拷贝到内部复用的 scratch 缓冲区（RDW 单条正文最长 65535B）。
 */
export class PagedFileSource implements ByteSource {
  readonly size: number;
  readonly pageSize: number;
  readonly maxPages: number;
  private fd: number;
  private closed = false;
  /** Map 按插入顺序维护 LRU：最近访问的移到末尾，淘汰时取第一个键并复用其页内存 */
  private pages = new Map<number, CachePage>();
  private scratch = new Uint8Array(65536 + 16);

  private constructor(fd: number, size: number, opts: PagedFileOptions = {}) {
    this.fd = fd;
    this.size = size;
    this.pageSize = Math.max(512, opts.pageSize ?? DEFAULT_PAGE_SIZE);
    this.maxPages = Math.max(2, opts.maxPages ?? DEFAULT_MAX_PAGES);
  }

  static open(filePath: string, opts?: PagedFileOptions): PagedFileSource {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      return new PagedFileSource(fd, stat.size, opts);
    } catch (e) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  /** 当前已缓存的页数（供测试检查 LRU 淘汰） */
  get cachedPages(): number {
    return this.pages.size;
  }

  private getPage(pageIdx: number): CachePage {
    const hit = this.pages.get(pageIdx);
    if (hit) {
      // 刷新 LRU 顺序（仅当不在末尾时重插，避免每次顺次读取都操作 Map）
      if (this.pages.size > 1) {
        this.pages.delete(pageIdx);
        this.pages.set(pageIdx, hit);
      }
      return hit;
    }

    let buf: Uint8Array;
    if (this.pages.size >= this.maxPages) {
      const oldestKey = this.pages.keys().next().value as number;
      const evicted = this.pages.get(oldestKey)!;
      this.pages.delete(oldestKey);
      buf = evicted.data;
    } else {
      buf = new Uint8Array(this.pageSize);
    }

    const fileOff = pageIdx * this.pageSize;
    const want = Math.min(this.pageSize, Math.max(0, this.size - fileOff));
    let got = 0;
    while (got < want) {
      const n = fs.readSync(this.fd, buf, got, want - got, fileOff + got);
      if (n <= 0) {
        break;
      }
      got += n;
    }
    const page: CachePage = { data: buf, validLen: got };
    this.pages.set(pageIdx, page);
    return page;
  }

  read(offset: number, length: number): Uint8Array {
    if (this.closed || length <= 0 || offset < 0 || offset >= this.size) {
      return this.scratch.subarray(0, 0);
    }
    const len = Math.min(length, this.size - offset);
    const startPage = Math.floor(offset / this.pageSize);
    const endPage = Math.floor((offset + len - 1) / this.pageSize);

    if (startPage === endPage) {
      const p = this.getPage(startPage);
      const inPage = offset - startPage * this.pageSize;
      return p.data.subarray(inPage, Math.min(inPage + len, p.validLen));
    }

    // 跨页或超大块读取：若请求大于缓存总容量则直接从 fd 读取到独立缓冲区
    let out: Uint8Array;
    if (len > this.scratch.length) {
      if (len <= 1 << 20) {
        this.scratch = new Uint8Array(len);
        out = this.scratch;
      } else {
        out = new Uint8Array(len);
      }
    } else {
      out = this.scratch;
    }

    let written = 0;
    let pos = offset;
    while (written < len) {
      const pIdx = Math.floor(pos / this.pageSize);
      const p = this.getPage(pIdx);
      const inPage = pos - pIdx * this.pageSize;
      const avail = p.validLen - inPage;
      if (avail <= 0) {
        break;
      }
      const take = Math.min(len - written, avail);
      out.set(p.data.subarray(inPage, inPage + take), written);
      written += take;
      pos += take;
    }
    return out.subarray(0, written);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pages.clear();
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}
