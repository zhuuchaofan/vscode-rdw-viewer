/** 判别字段值的解码缓存：相同字节只解码一次（按判别字段分组、统计取值时使用）。 */
import { t } from './i18n';
import { sanitize, toHex } from './decode';
import { decodePacked } from './numeric';
import { Discriminator } from './sessionTypes';

/**
 * 针对单个判别字段的字节级去重解码缓存（开放定址哈希表）：
 * 判别字段通常只有寥寥几种取值（如 '01'/'02'/'03' 或几个 COMP-3 代码），
 * 用原始字节直接命中已解码的字符串，避免百万条记录重复调用 TextDecoder / trimEnd / 正则替换。
 */
export class DiscValueCache {
  private cap = 64;
  private size = 0;
  private hashes = new Uint32Array(64);
  private used = new Uint8Array(64);
  private rawKeys: Uint8Array[] = new Array(64);
  private values: string[] = new Array(64);

  constructor(
    private readonly d: Discriminator,
    private readonly decoder: TextDecoder
  ) {}

  private decode(bytes: Uint8Array): string {
    if (this.d.type === 'comp3') {
      const signed = (bytes[bytes.length - 1] & 0x0f) !== 0xf;
      const r = decodePacked(bytes, 0, signed);
      return r.ok ? r.text : t('disc.invalid', { hex: toHex(bytes) });
    }
    return sanitize(this.decoder.decode(bytes)).trimEnd() || t('disc.blank');
  }

  private grow(): void {
    const oldCap = this.cap;
    const oldHashes = this.hashes;
    const oldUsed = this.used;
    const oldKeys = this.rawKeys;
    const oldVals = this.values;

    this.cap = oldCap * 2;
    this.hashes = new Uint32Array(this.cap);
    this.used = new Uint8Array(this.cap);
    this.rawKeys = new Array(this.cap);
    this.values = new Array(this.cap);
    const mask = this.cap - 1;

    for (let i = 0; i < oldCap; i++) {
      if (!oldUsed[i]) continue;
      let slot = oldHashes[i] & mask;
      while (this.used[slot]) {
        slot = (slot + 1) & mask;
      }
      this.used[slot] = 1;
      this.hashes[slot] = oldHashes[i];
      this.rawKeys[slot] = oldKeys[i];
      this.values[slot] = oldVals[i];
    }
  }

  get(bytes: Uint8Array): string {
    const len = bytes.length;
    let h = 0x811c9dc5;
    for (let i = 0; i < len; i++) {
      h = Math.imul(h ^ bytes[i], 0x01000193);
    }
    h >>>= 0;

    let mask = this.cap - 1;
    let slot = h & mask;
    while (this.used[slot]) {
      if (this.hashes[slot] === h) {
        const k = this.rawKeys[slot];
        if (k.length === len) {
          let eq = true;
          for (let i = 0; i < len; i++) {
            if (k[i] !== bytes[i]) {
              eq = false;
              break;
            }
          }
          if (eq) {
            return this.values[slot];
          }
        }
      }
      slot = (slot + 1) & mask;
    }

    const val = this.decode(bytes);
    // 拷贝一份独立字节作为缓存键（分页源返回的视图可能被复用覆盖）
    const copy = bytes.slice();
    if ((this.size + 1) * 2 >= this.cap) {
      this.grow();
      mask = this.cap - 1;
      slot = h & mask;
      while (this.used[slot]) {
        slot = (slot + 1) & mask;
      }
    }
    this.used[slot] = 1;
    this.hashes[slot] = h;
    this.rawKeys[slot] = copy;
    this.values[slot] = val;
    this.size++;
    return val;
  }
}
