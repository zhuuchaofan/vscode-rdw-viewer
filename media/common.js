/* RDW Viewer webview 共用部分：界面文字、转义、列宽测量、单元格渲染、十六进制 dump。
 * 主视图（main.js）和比较视图（compare.js）都在它之后加载，通过 window.RdwCommon 使用。 */
(function () {
  'use strict';
  const C = {};

  /* ---------- 界面文字（随 init 消息由扩展端发来） ---------- */
  let strings = {};
  C.setStrings = (s) => {
    strings = s || {};
  };
  C.S = function (key, args) {
    const text = strings[key] !== undefined ? strings[key] : key;
    return text.replace(/\{(\w+)\}/g, (m, k) => (args && k in args ? String(args[k]) : m));
  };
  const S = C.S;

  const esc = (C.esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

  /* ---------- 列宽 ----------
   * 列宽以 px 为单位：取「host 按字节数估算的 ch 宽」和「表头文字在实际字体下的测量宽度」中较大者，
   * 这样全角表头不会因字体回退而被截断或与数据列错位。 */
  const measureCtx = document.createElement('canvas').getContext('2d');
  let chPx = 8;
  C.refreshMetrics = (el) => {
    const cs = getComputedStyle(el);
    measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    chPx = measureCtx.measureText('0').width || 8;
  };
  const textPx = (s) => measureCtx.measureText(String(s)).width;
  C.colPx = (col) => {
    const header = Math.max(textPx(col.name) * 1.05, textPx(col.pic), textPx(col.start || '')) + 14;
    return Math.ceil(Math.max(col.width * chPx, header));
  };
  C.isNumeric = (col) => col.type === 'num' || col.type === 'bin';
  C.FILLER_RE = /^FILLER(\(|$)/i;
  C.compileHide = (pattern) => {
    try {
      return pattern ? new RegExp(pattern, 'i') : null;
    } catch (e) {
      return null;
    }
  };

  /**
   * 把 data-top / data-w 应用为实际样式。
   * Webview 的 CSP 禁止行内 style 属性，所以不在 HTML 里写 style="..."，而是通过 CSSOM 设置。
   */
  C.applyLayout = (root, rowWidth) => {
    root.querySelectorAll('.row').forEach((r) => {
      if (r.dataset.top !== undefined) r.style.top = r.dataset.top + 'px';
      if (rowWidth) r.style.width = rowWidth;
    });
    root.querySelectorAll('[data-w]').forEach((c) => {
      c.style.width = c.dataset.w + 'px';
    });
  };

  /* ---------- 单元格 ---------- */
  /* 自动识别 COMP-3 的片段标记：数值、十六进制 */
  C.plainSeg = (s) =>
    String(s).replace(//g, '[').replace(//g, ']').replace(//g, '‹').replace(//g, '›');
  const segHtml = (s) =>
    esc(s)
      .replace(/([^]*)/g, `<span class="pk" title="${esc(S('packedTitle'))}">[$1]</span>`)
      .replace(/([^]*)/g, '<span class="raw">‹$1›</span>');

  /**
   * 文字的显示：末尾补位的空格显示为淡色的 ·（全角空格为 □），控制字符图形（␀ 等）着色。
   * 中间的空格（如「山田　太郎」）是数据本身的一部分，不做标记。
   */
  const textHtml = (s) => {
    const m = /[ 　]+$/.exec(s);
    const head = m ? s.slice(0, m.index) : s;
    let html = esc(head).replace(/[␀-␟␡]/g, (c) => `<span class="cc">${c}</span>`);
    if (m) {
      html += `<span class="ws">${m[0].replace(/ /g, '·').replace(/　/g, '□')}</span>`;
    }
    return html;
  };

  /** 单元格内容：自动识别的正文 / 文字（标出空白）/ 解码后的数值 */
  C.cellHtml = (text, col) => {
    if (col.kind === 'body') return segHtml(text);
    if (col.type === 'bin' || col.kind === 'missing') return esc(text);
    return textHtml(text);
  };

  /** 表头行的单元格（k=0..2：项目名 / 属性 / 相对位置） */
  C.headerCells = (vis, k) => {
    let html = '';
    for (const { col, px } of vis) {
      const cls = (k === 0 ? '' : k === 1 ? ' pic' : ' pos') + (C.isNumeric(col) ? ' num' : '');
      const text = k === 0 ? col.name : k === 1 ? col.pic : col.start || '';
      const dim = C.FILLER_RE.test(col.name) || col.kind === 'extra' ? ' dim' : '';
      html += `<div class="c hd${cls}${dim} ${col.kind}" data-w="${px}" title="${esc(text)}">${esc(text)}</div>`;
    }
    return html;
  };

  /* ---------- 十六进制 dump ---------- */
  const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
  const PER_LINE = 16;

  /**
   * 一条记录的 dump：偏移 | 16 字节十六进制 | 文字。
   * 字段交替着色，选中的字段（opts.selCol）高亮；opts.other 为比较对象的字节，不同的字节标出。
   */
  C.dumpHtml = (info, opts) => {
    opts = opts || {};
    if (!info) {
      return `<div class="dempty">${esc(opts.empty || '')}</div>`;
    }
    const bytes = info.bytes;
    const n = bytes.length;
    const chars = info.chars;
    const fieldAt = new Int32Array(n).fill(-1);
    info.fields.forEach((f, k) => {
      for (let i = f.start - 1; i < f.start - 1 + f.len && i < n; i++) fieldAt[i] = k;
    });
    const selField = opts.selCol === undefined ? -1 : info.fields.findIndex((f) => f.col === opts.selCol);
    const other = opts.other;
    const cls = (i) => {
      const f = fieldAt[i];
      let c = f < 0 ? '' : f % 2 ? ' fb' : ' fa';
      if (f >= 0 && f === selField) c += ' fs';
      if (other && (i >= other.length || other[i] !== bytes[i])) c += ' dd';
      return c;
    };

    const offHex = '0x' + info.offset.toString(16).toUpperCase().padStart(8, '0');
    let head;
    if (info.error !== null) {
      head =
        `<span class="derr">${esc(info.error)}</span>` +
        `<span>${esc(S('dumpSkipped', { off: offHex, n }))}${info.truncated ? esc(S('dumpTruncated')) : ''}</span>`;
    } else {
      head =
        `<span>${esc(S('dumpRecord', { n: info.entry + 1, off: offHex, len: n }))}</span>` +
        `<span class="drdw" title="${esc(S('dumpRdwTitle'))}">RDW ${esc(info.front)} … ${esc(info.back)}</span>`;
    }
    const lines = [];
    let ruler = '<span class="doff"></span><span class="dhex">';
    for (let i = 0; i < PER_LINE; i++) ruler += `<span class="b${i === 8 ? ' g8' : ''}">+${i.toString(16).toUpperCase()}</span>`;
    lines.push(`<div class="dline druler">${ruler}</span></div>`);
    for (let start = 0; start < n; start += PER_LINE) {
      const end = Math.min(n, start + PER_LINE);
      let hx = '';
      let tx = '';
      let carried = true; // 行首仍是上一行多字节字符的后续字节
      for (let i = start; i < end; i++) {
        hx += `<span class="b${cls(i)}${i - start === 8 ? ' g8' : ''}" data-i="${i}">${hex2(bytes[i])}</span>`;
        if (chars[i] === '') {
          // 上一行的多字节字符的后续字节：留出位置保持对齐
          if (carried) tx += `<span class="t w1${cls(i)}" data-i="${i}"></span>`;
          continue;
        }
        carried = false;
        let j = i + 1;
        while (j < n && chars[j] === '') j++;
        const w = Math.min(j - i, end - i, 4);
        tx += `<span class="t w${w}${cls(i)}" data-i="${i}">${esc(chars[i])}</span>`;
      }
      lines.push(
        `<div class="dline"><span class="doff">${start.toString(16).toUpperCase().padStart(4, '0')}</span>` +
          `<span class="dhex">${hx}</span><span class="dtxt">${tx}</span></div>`
      );
    }
    if (!n) lines.push(`<div class="dempty">${esc(S('dumpEmpty'))}</div>`);
    return `<div class="dhead">${head}</div><div class="dinfo">${esc(S('dumpHint'))}</div><div class="dlines">${lines.join('')}</div>`;
  };

  /**
   * dump 的鼠标操作：悬停时在信息行显示位置和字段，点击字节时回调 onPick(列下标)。
   * getInfo() 返回当前显示的 DumpInfo。
   */
  C.bindDump = (el, getInfo, onPick) => {
    const fieldOf = (info, i) => info.fields.find((f) => i >= f.start - 1 && i < f.start - 1 + f.len);
    el.addEventListener('mouseover', (ev) => {
      const t = ev.target.closest('[data-i]');
      const info = getInfo();
      if (!t || !info) return;
      const i = Number(t.dataset.i);
      const f = fieldOf(info, i);
      const box = t.closest('.dcol') || el;
      const line = box.querySelector('.dinfo');
      if (!line) return;
      line.textContent =
        S('dumpPos', { pos: i + 1, hex: i.toString(16).toUpperCase(), byte: hex2(info.bytes[i]) }) +
        (f ? ` · ${f.name}（${S('dumpField', { pos: f.start, len: f.len })}）` : '');
    });
    el.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-i]');
      const info = getInfo();
      if (!t || !info) return;
      const f = fieldOf(info, Number(t.dataset.i));
      if (f && onPick) onPick(f.col);
    });
  };

  /**
   * 表格与 dump 面板之间的分隔条：拖动调整 dump 面板的高度。
   * 高度通过 CSSOM 设置；onChange(高度) 用于保存。
   */
  C.splitter = (bar, panel, height, onChange) => {
    let h = height;
    const apply = () => {
      const max = Math.max(80, window.innerHeight - 160);
      h = Math.min(Math.max(h, 60), max);
      panel.style.height = h + 'px';
    };
    apply();
    bar.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const y0 = ev.clientY;
      const h0 = h;
      const move = (e) => {
        h = h0 - (e.clientY - y0);
        apply();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        onChange && onChange(h);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    window.addEventListener('resize', apply);
  };

  window.RdwCommon = C;
})();
