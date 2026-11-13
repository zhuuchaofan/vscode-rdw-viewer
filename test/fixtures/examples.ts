/**
 * examples/ 下示例文件的生成器。
 *
 * 数据不手工拼字节：先用插件自己的解析器解析 COPY句，再按每个字段的 USAGE 编码，
 * 保证示例数据与 COPY句始终一致。`npm run examples` 重新生成；test/examples.test.ts 检查
 * 仓库中的文件与生成结果一致、并能按预期显示。
 */
import { parseCopybook, layoutRecord, CopyField, LayoutSelection } from '../../src/copybook';
import { encodeShiftJis } from '../../src/sjisEncode';

/** 示例工作区里设置的 COMP-5 / 浮点字节序（examples/.vscode/settings.json） */
export const EXAMPLE_COMP5_LITTLE = true;

// ---------------------------------------------------------------- COPY句

const fixed = (lines: string[], ident: string) =>
  lines
    .map((code, i) => {
      const seq = String((i + 1) * 100).padStart(6, '0');
      let width = 0;
      for (const ch of code) {
        const cp = ch.codePointAt(0)!;
        width += cp < 0x80 || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
      }
      return seq + code + ' '.repeat(Math.max(0, 66 - width)) + ident;
    })
    .join('\n') + '\n';

export const COPYBOOKS: Record<string, string> = {
  // 固定形式：一連番号（1~6 桁目）、識別領域（73~80 桁目）、日本語のコメント
  'CUSTOMER.cpy': fixed(
    [
      '*----------------------------------------------------------------',
      '*    顧客マスター（サンプル）   レコード長 120 バイト',
      '*----------------------------------------------------------------',
      ' 01  CUSTOMER-REC.',
      '     05  CUST-ID             PIC 9(8).',
      '     05  CUST-NAME           PIC X(30).',
      '     05  CUST-KANA           PIC X(20).',
      '     05  CUST-BIRTH          PIC 9(8).',
      '     05  CUST-RANK           PIC X(1).',
      '*        残高・ポイントはパック 10 進',
      '     05  CUST-BALANCE        PIC S9(9)V99  COMP-3.',
      '     05  CUST-POINT          PIC S9(7)     COMP-3.',
      '*        与信限度額はゾーン 10 進（符号は末尾桁に含む）',
      '     05  CUST-LIMIT          PIC S9(9)V99.',
      '     05  CUST-UPDATED        PIC 9(14).',
      '     05  FILLER              PIC X(18).',
    ],
    'CUSTMAST'
  ),
  'HEADER.cpy': `      * ヘッダーレコード（40 バイト）
       01  HEADER-REC.
           05  REC-TYPE            PIC X(1).
           05  FILE-ID             PIC X(10).
           05  CREATE-DATE         PIC 9(8).
           05  CREATE-TIME         PIC 9(6).
           05  FILLER              PIC X(15).
`,
  'DETAIL.cpy': `      * 明細レコード（80 バイト）
       01  DETAIL-REC.
           05  REC-TYPE            PIC X(1).
           05  ORDER-NO            PIC 9(10).
           05  ORDER-DATE          PIC 9(8).
           05  ITEM-CODE           PIC X(10).
           05  ITEM-NAME           PIC X(20).
           05  AMOUNTS             USAGE COMP-3.
               10  QTY             PIC S9(5).
               10  UNIT-PRICE      PIC S9(7)V99.
               10  AMOUNT          PIC S9(9)V99.
           05  TAX-RATE            PIC 9V99.
           05  FILLER              PIC X(14).
`,
  'TRAILER.cpy': `      * トレーラーレコード（30 バイト）
       01  TRAILER-REC.
           05  REC-TYPE            PIC X(1).
           05  REC-COUNT           PIC 9(8).
           05  TOTAL-AMOUNT        PIC S9(11)V99 COMP-3.
           05  FILLER              PIC X(14).
`,
  'SL-HEADER.cpy': `      * 同一レコード長（64 バイト）：ヘッダー  REC-TYPE = 'H'
       01  SL-HEADER-REC.
           05  REC-TYPE            PIC X(1).
           05  FILE-ID             PIC X(10).
           05  BUSINESS-DATE       PIC 9(8).
           05  FILLER              PIC X(45).
`,
  'SL-DETAIL.cpy': `      * 同一レコード長（64 バイト）：明細  REC-TYPE = 'D'
       01  SL-DETAIL-REC.
           05  REC-TYPE            PIC X(1).
           05  STORE-CODE          PIC 9(4).
           05  SALES-DATE          PIC 9(8).
           05  CUST-ID             PIC 9(8).
           05  ITEM-NAME           PIC N(10).
           05  QTY                 PIC S9(4) COMP.
           05  AMOUNT              PIC S9(9) COMP-3.
           05  FILLER              PIC X(16).
`,
  'SL-TRAILER.cpy': `      * 同一レコード長（64 バイト）：トレーラー  REC-TYPE = 'T'
       01  SL-TRAILER-REC.
           05  REC-TYPE            PIC X(1).
           05  REC-COUNT           PIC 9(8).
           05  TOTAL-AMOUNT        PIC S9(13) COMP-3.
           05  FILLER              PIC X(48).
`,
  'PAYMENT.cpy': `      * 支払レコード（56 バイト）
      * 支払区分 PAY-TYPE により PAY-CARD / PAY-BANK / PAY-CASH を切り替える
       01  PAYMENT-REC.
           05  PAY-NO              PIC 9(10).
           05  PAY-DATE            PIC 9(8).
           05  PAY-TYPE            PIC X(1).
               88  PAY-BY-CARD     VALUE 'C'.
               88  PAY-BY-BANK     VALUE 'B'.
               88  PAY-BY-CASH     VALUE 'K'.
           05  PAY-AMOUNT          PIC S9(9)V99 COMP-3.
           05  PAY-CARD.
               10  CARD-NO         PIC X(16).
               10  CARD-EXPIRE     PIC 9(4).
               10  CARD-HOLDER     PIC X(10).
           05  PAY-BANK REDEFINES PAY-CARD.
               10  BANK-CODE       PIC 9(4).
               10  BRANCH-CODE     PIC 9(3).
               10  ACCOUNT-TYPE    PIC X(1).
               10  ACCOUNT-NO      PIC 9(7).
               10  ACCOUNT-NAME    PIC X(15).
           05  PAY-CASH REDEFINES PAY-CARD.
               10  RECEIPT-NO      PIC X(12).
               10  CHANGE-AMOUNT   PIC S9(7) COMP-3.
               10  FILLER          PIC X(14).
           05  FILLER              PIC X(1).
`,
  'NUMERIC.cpy': `      * 数値形式のサンプル（60 バイト）
       01  NUMERIC-REC.
           05  NUM-ID              PIC 9(4).
           05  N-ZONED             PIC S9(5)V99.
           05  N-LEAD-SEP          PIC S9(5) SIGN LEADING SEPARATE.
           05  N-TRAIL-SEP         PIC S9(5) SIGN TRAILING SEPARATE.
           05  N-PACKED            PIC S9(7)V99 COMP-3.
           05  N-BINARY            PIC S9(4) COMP.
           05  N-BINARY-L          PIC S9(9) BINARY.
           05  N-NATIVE            PIC S9(9) COMP-5.
           05  N-FLOAT             COMP-1.
           05  N-DOUBLE            COMP-2.
           05  N-NOTE              PIC X(10).
`,
};

// ---------------------------------------------------------------- 编码

type Value = string | number | Uint8Array | undefined;

function sjis(text: string): Uint8Array {
  return encodeShiftJis(text).bytes;
}

/** 字符串 → 去掉小数点的数字串（按小数位补齐）与符号 */
function digitsOf(value: number | string, scale: number): { digits: string; negative: boolean } {
  const s = typeof value === 'number' ? value.toFixed(scale) : value;
  const negative = s.startsWith('-');
  const [int, frac = ''] = s.replace(/^[+-]/, '').split('.');
  return { digits: int + frac.padEnd(scale, '0').slice(0, scale), negative };
}

function packed(value: number | string, f: CopyField): Uint8Array {
  const { digits, negative } = digitsOf(value, f.scale);
  const nibbles = f.length * 2 - 1;
  const d = digits.padStart(nibbles, '0').slice(-nibbles);
  const sign = !f.signed ? 0xf : negative ? 0xd : 0xc;
  const out = new Uint8Array(f.length);
  const all = d + sign.toString(16);
  for (let i = 0; i < f.length; i++) {
    out[i] = parseInt(all.substr(i * 2, 2), 16);
  }
  return out;
}

function zoned(value: number | string, f: CopyField): Uint8Array {
  const { digits, negative } = digitsOf(value, f.scale);
  const n = f.signSeparate ? f.length - 1 : f.length;
  const d = digits.padStart(n, '0').slice(-n);
  if (f.signSeparate) {
    const sign = negative ? '-' : '+';
    return Buffer.from(f.signLeading ? sign + d : d + sign, 'latin1');
  }
  const bytes = Buffer.from(d, 'latin1');
  if (f.signed) {
    // NetCOBOL の符号：符号を持つ桁の上位 4 ビットを 4（正）/ 5（負）にする
    bytes[f.signLeading ? 0 : n - 1] += negative ? 0x20 : 0x10;
  }
  return bytes;
}

function binary(value: number, f: CopyField, little: boolean): Uint8Array {
  const b = Buffer.alloc(f.length);
  const v = BigInt(Math.round(value));
  if (f.length === 2) little ? b.writeInt16LE(Number(v)) : b.writeInt16BE(Number(v));
  else if (f.length === 4) little ? b.writeInt32LE(Number(v)) : b.writeInt32BE(Number(v));
  else little ? b.writeBigInt64LE(v) : b.writeBigInt64BE(v);
  return b;
}

function float(value: number, f: CopyField, little: boolean): Uint8Array {
  const b = Buffer.alloc(f.length);
  if (f.length === 4) little ? b.writeFloatLE(value) : b.writeFloatBE(value);
  else little ? b.writeDoubleLE(value) : b.writeDoubleBE(value);
  return b;
}

function encodeField(f: CopyField, value: Value): Uint8Array {
  if (value instanceof Uint8Array) {
    return value; // 不正データの例などはバイト列をそのまま使う
  }
  if (f.usage === 'COMP-3' || f.usage === 'PACKED-DECIMAL') return packed(value ?? 0, f);
  if (f.usage === 'COMP' || f.usage === 'BINARY' || f.usage === 'COMP-4') return binary(Number(value ?? 0), f, false);
  if (f.usage === 'COMP-5') return binary(Number(value ?? 0), f, EXAMPLE_COMP5_LITTLE);
  if (f.usage === 'COMP-1' || f.usage === 'COMP-2') return float(Number(value ?? 0), f, EXAMPLE_COMP5_LITTLE);
  if (f.type === 'num') return zoned(value ?? 0, f);
  // 文字：Shift_JIS、空白埋め（PIC N は全角空白）
  const isN = /^N/.test(f.pic);
  const text = sjis(String(value ?? ''));
  const pad = isN ? sjis('　'.repeat(f.length)) : Buffer.alloc(f.length, 0x20);
  const out = Buffer.from(pad.subarray(0, f.length));
  out.set(text.subarray(0, f.length));
  return out;
}

/** COPY句の項目名 → 値 からレコード本体を作る */
function body(copybook: string, values: Record<string, Value>, sel: LayoutSelection = {}): Buffer {
  const rec = parseCopybook(COPYBOOKS[copybook]).records[0];
  const layout = layoutRecord(rec, sel);
  const buf = Buffer.alloc(layout.totalLength, 0x20);
  for (const f of layout.fields) {
    const bytes = encodeField(f, values[f.name]);
    if (bytes.length !== f.length) {
      throw new Error(`${copybook} ${f.name}: ${bytes.length} != ${f.length}`);
    }
    buf.set(bytes, f.offset);
  }
  return buf;
}

/** RDW を付ける（front / back を指定すると不正な RDW を作れる） */
function rdw(b: Uint8Array, front = b.length, back = b.length): Buffer {
  const h = Buffer.alloc(4);
  const t = Buffer.alloc(4);
  h.writeUInt16LE(front);
  t.writeUInt16LE(back);
  return Buffer.concat([h, b, t]);
}

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ---------------------------------------------------------------- データ

const NAMES: Array<[string, string]> = [
  ['山田　太郎', 'ﾔﾏﾀﾞ ﾀﾛｳ'],
  ['佐藤　花子', 'ｻﾄｳ ﾊﾅｺ'],
  ['鈴木　一郎', 'ｽｽﾞｷ ｲﾁﾛｳ'],
  ['高橋　美咲', 'ﾀｶﾊｼ ﾐｻｷ'],
  ['田中　健太', 'ﾀﾅｶ ｹﾝﾀ'],
  ['伊藤　さくら', 'ｲﾄｳ ｻｸﾗ'],
  ['渡辺　翔', 'ﾜﾀﾅﾍﾞ ｼｮｳ'],
  ['中村　陽子', 'ﾅｶﾑﾗ ﾖｳｺ'],
  ['小林　大輔', 'ｺﾊﾞﾔｼ ﾀﾞｲｽｹ'],
  ['加藤　結衣', 'ｶﾄｳ ﾕｲ'],
  ['吉田　蓮', 'ﾖｼﾀﾞ ﾚﾝ'],
  ['山本　真央', 'ﾔﾏﾓﾄ ﾏｵ'],
];

function customers(): Buffer {
  return Buffer.concat(
    NAMES.map(([name, kana], i) =>
      rdw(
        body('CUSTOMER.cpy', {
          'CUST-ID': String(10000001 + i),
          'CUST-NAME': name,
          'CUST-KANA': kana,
          'CUST-BIRTH': String(19700101 + i * 30103),
          'CUST-RANK': 'ABCS'[i % 4],
          'CUST-BALANCE': i % 5 === 3 ? '-1250.50' : ((i + 1) * 123456.78).toFixed(2),
          'CUST-POINT': (i * 1500) % 9000,
          'CUST-LIMIT': i % 6 === 4 ? '-30000.00' : String((i + 1) * 500000) + '.00',
          'CUST-UPDATED': String(20261101093000 + i * 100),
        })
      )
    )
  );
}

function mixedLength(): Buffer {
  const items: Array<[string, string, number, number]> = [
    ['A-1001', 'ボールペン（黒）', 12, 120],
    ['A-2002', 'ノート　Ａ４', 5, 280.5],
    ['B-3003', 'ファイル', 30, 98],
    ['C-4004', 'ホッチキス', 2, 1480],
    ['C-5005', 'ﾏｰｶｰ 赤', 10, 150],
  ];
  const details = items.map(([code, name, qty, price], i) =>
    rdw(
      body('DETAIL.cpy', {
        'REC-TYPE': 'D',
        'ORDER-NO': String(2026110001 + i),
        'ORDER-DATE': '20261113',
        'ITEM-CODE': code,
        'ITEM-NAME': name,
        QTY: qty,
        'UNIT-PRICE': price.toFixed(2),
        AMOUNT: (qty * price).toFixed(2),
        'TAX-RATE': '0.10',
      })
    )
  );
  const total = items.reduce((s, [, , q, p]) => s + q * p, 0);
  return Buffer.concat([
    rdw(body('HEADER.cpy', { 'REC-TYPE': 'H', 'FILE-ID': 'ORDER-DAY', 'CREATE-DATE': '20261113', 'CREATE-TIME': '093000' })),
    ...details,
    rdw(body('TRAILER.cpy', { 'REC-TYPE': 'T', 'REC-COUNT': String(items.length), 'TOTAL-AMOUNT': total.toFixed(2) })),
  ]);
}

function sameLength(): Buffer {
  const sales: Array<[string, string, number, number]> = [
    ['0101', '弁当', 3, 1650],
    ['0101', 'お茶', 5, 750],
    ['0202', 'おにぎり', 4, 600],
    ['0303', 'サンドイッチ', 2, 760],
  ];
  return Buffer.concat([
    rdw(body('SL-HEADER.cpy', { 'REC-TYPE': 'H', 'FILE-ID': 'SALES', 'BUSINESS-DATE': '20261113' })),
    ...sales.map(([store, item, qty, amount], i) =>
      rdw(
        body('SL-DETAIL.cpy', {
          'REC-TYPE': 'D',
          'STORE-CODE': store,
          'SALES-DATE': '20261113',
          'CUST-ID': String(10000001 + i),
          'ITEM-NAME': item,
          QTY: qty,
          AMOUNT: amount,
        })
      )
    ),
    rdw(body('SL-TRAILER.cpy', { 'REC-TYPE': 'T', 'REC-COUNT': String(sales.length), 'TOTAL-AMOUNT': sales.reduce((s, x) => s + x[3], 0) })),
  ]);
}

const PAY_SET = 'PAYMENT-REC.PAY-CARD';

function payments(): Buffer {
  const base = (i: number, type: string, amount: string) => ({
    'PAY-NO': String(5000000001 + i),
    'PAY-DATE': '20261113',
    'PAY-TYPE': type,
    'PAY-AMOUNT': amount,
  });
  return Buffer.concat([
    rdw(body('PAYMENT.cpy', { ...base(0, 'C', '12800.00'), 'CARD-NO': '4111111111111111', 'CARD-EXPIRE': '2812', 'CARD-HOLDER': 'TARO YAMA' })),
    rdw(
      body('PAYMENT.cpy', { ...base(1, 'B', '54000.00'), 'BANK-CODE': '0001', 'BRANCH-CODE': '123', 'ACCOUNT-TYPE': '1', 'ACCOUNT-NO': '1234567', 'ACCOUNT-NAME': 'ｻﾄｳ ﾊﾅｺ' }, { [PAY_SET]: 'PAY-BANK' })
    ),
    rdw(body('PAYMENT.cpy', { ...base(2, 'K', '3240.00'), 'RECEIPT-NO': 'R-0000012345', 'CHANGE-AMOUNT': 1760 }, { [PAY_SET]: 'PAY-CASH' })),
    rdw(body('PAYMENT.cpy', { ...base(3, 'C', '980.00'), 'CARD-NO': '5555555555554444', 'CARD-EXPIRE': '2703', 'CARD-HOLDER': 'HANA SATO' })),
    rdw(
      body('PAYMENT.cpy', { ...base(4, 'B', '120000.00'), 'BANK-CODE': '0005', 'BRANCH-CODE': '001', 'ACCOUNT-TYPE': '2', 'ACCOUNT-NO': '7654321', 'ACCOUNT-NAME': 'ｽｽﾞｷ ｲﾁﾛｳ' }, { [PAY_SET]: 'PAY-BANK' })
    ),
  ]);
}

function numerics(): Buffer {
  const ok = (id: string, v: number) => ({
    'NUM-ID': id,
    'N-ZONED': v.toFixed(2),
    'N-LEAD-SEP': Math.trunc(v),
    'N-TRAIL-SEP': Math.trunc(v),
    'N-PACKED': v.toFixed(2),
    'N-BINARY': Math.trunc(v) % 10000,
    'N-BINARY-L': Math.trunc(v) * 100,
    'N-NATIVE': Math.trunc(v) * -3,
    'N-FLOAT': v / 8,
    'N-DOUBLE': v / 7,
    'N-NOTE': 'OK',
  });
  return Buffer.concat([
    rdw(body('NUMERIC.cpy', ok('0001', 1234.56))),
    rdw(body('NUMERIC.cpy', ok('0002', -987.65))),
    rdw(body('NUMERIC.cpy', ok('0003', 0))),
    // 不正・疑わしいデータ：画面ではオレンジで表示される
    rdw(
      body('NUMERIC.cpy', {
        ...ok('9001', 1),
        'N-ZONED': Buffer.from(' 123 45', 'latin1'), // 空白を含む
        'N-LEAD-SEP': Buffer.from('012345', 'latin1'), // 符号がない
        'N-PACKED': hex('00 12 3A 45 6C'), // 数字部に A
        'N-BINARY': hex('30 39'), // 12345：S9(4) を超える
        'N-FLOAT': EXAMPLE_COMP5_LITTLE ? hex('00 00 C0 7F') : hex('7F C0 00 00'), // NaN
        'N-NOTE': 'INVALID',
      })
    ),
  ]);
}

function broken(): Buffer {
  const line = (s: string) => Buffer.from(s.padEnd(24, ' '), 'latin1');
  const full = rdw(line('LINE-0006 TRUNCATED'));
  return Buffer.concat([
    rdw(line('LINE-0001 OK')),
    rdw(line('LINE-0002 OK')),
    rdw(line('LINE-0003 BAD TRAILER'), 24, 23), // 前後の RDW が不一致
    rdw(line('LINE-0004 OK')),
    rdw(line('LINE-0005 BAD LENGTH'), 9000, 24), // 前 RDW の長さが不正 → 再同期
    rdw(line('LINE-0006 OK')),
    full.subarray(0, full.length - 10), // ファイル末尾が途中で切れている
  ]);
}

function noCopybook(): Buffer {
  const rec = (id: string, name: string, amt: string, qty: string) =>
    rdw(Buffer.concat([Buffer.from(id, 'latin1'), sjis(name.padEnd(10, '　')).subarray(0, 20), hex(amt), hex(qty), Buffer.alloc(12, 0x20)]));
  // 48 バイト：ID(8) 名前(20) 金額 COMP-3(5) 数量 COMP-3(3) 空白(12)
  return Buffer.concat([
    rec('ITEM0001', '鉛筆', '00 00 01 20 0C', '00 01 0C'),
    rec('ITEM0002', '消しゴム', '00 00 00 98 0C', '00 00 5C'),
    rec('ITEM0003', '定規', '00 00 02 50 0C', '00 00 1D'),
  ]);
}

// ---------------------------------------------------------------- 配置

export const MAPPING = {
  copybooks: {
    '120': 'copybooks/CUSTOMER.cpy',
    '40': 'copybooks/HEADER.cpy',
    '80': 'copybooks/DETAIL.cpy',
    '30': 'copybooks/TRAILER.cpy',
    '60': 'copybooks/NUMERIC.cpy',
  },
  discriminators: {
    '64': {
      start: 1,
      length: 1,
      type: 'text' as const,
      copybooks: { H: 'copybooks/SL-HEADER.cpy', D: 'copybooks/SL-DETAIL.cpy', T: 'copybooks/SL-TRAILER.cpy' },
    },
    '56': {
      start: 19,
      length: 1,
      type: 'text' as const,
      copybooks: { C: 'copybooks/PAYMENT.cpy', B: 'copybooks/PAYMENT.cpy', K: 'copybooks/PAYMENT.cpy' },
    },
  },
  layouts: {
    '56=B': { [PAY_SET]: 'PAY-BANK' },
    '56=K': { [PAY_SET]: 'PAY-CASH' },
  } as Record<string, Record<string, string>>,
};

export const SETTINGS = { 'rdwViewer.comp5Endian': EXAMPLE_COMP5_LITTLE ? 'little' : 'big' };

/** examples/ からの相対パス → 内容 */
export function buildExamples(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {
    '01-customer.dat': customers(),
    '02-mixed-length.dat': mixedLength(),
    '03-same-length.dat': sameLength(),
    '04-redefines.dat': payments(),
    '05-numeric.dat': numerics(),
    '06-broken.dat': broken(),
    '07-no-copybook.dat': noCopybook(),
    '.vscode/rdw-viewer.json': Buffer.from(JSON.stringify(MAPPING, null, 2) + '\n'),
    '.vscode/settings.json': Buffer.from(JSON.stringify(SETTINGS, null, 2) + '\n'),
  };
  for (const [name, text] of Object.entries(COPYBOOKS)) {
    out[`copybooks/${name}`] = Buffer.from(text, 'utf8');
  }
  return out;
}
