/* RDW Viewer webview：TF-LINDA 风格的记录表格（虚拟滚动）。
 *
 * 消息协议（host ⇄ webview）见 src/extension.ts / src/session.ts。
 *  host → web : init / rows / cell
 *  web  → host: ready / getRows / cellInfo / chooseCopybook / clearCopybook / setEncoding
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const ROW_H = 20;
  const BLOCK = 64;
  const LEFT_W = 26; // ch：序号 8 + 偏移 14 + 状态 4
  const ERR_VIEW = 'ERR';
  const ORDER_VIEW = 'ORDER';
  const ERR_COLUMNS = [
    { name: '偏移', pic: '', start: 0, width: 12, kind: 'field', type: 'alnum' },
    { name: '跳过字节', pic: '', start: 0, width: 10, kind: 'field', type: 'alnum' },
    { name: '原因', pic: '', start: 0, width: 200, kind: 'field', type: 'alnum' },
  ];

  const state = {
    init: null,
    gen: 0,
    view: null,
    hideFiller: true,
    cache: new Map(), // view -> Map(blockIndex -> rows[] | 'pending')
    selected: null, // {view,row,col}
    pending: new Set(),
  };

  /* ---------- DOM ---------- */
  const app = document.getElementById('app');
  app.innerHTML = [
    '<div id="toolbar"></div>',
    '<div id="tabs"></div>',
    '<div id="banner"></div>',
    '<div id="cellbar"><span class="hint">点击单元格查看字段值和原始字节</span></div>',
    '<div id="scroller"><div id="inner"><div id="hdr"></div><div id="rows"></div></div></div>',
  ].join('');
  const $toolbar = document.getElementById('toolbar');
  const $tabs = document.getElementById('tabs');
  const $banner = document.getElementById('banner');
  const $cellbar = document.getElementById('cellbar');
  const $scroller = document.getElementById('scroller');
  const $inner = document.getElementById('inner');
  const $hdr = document.getElementById('hdr');
  const $rows = document.getElementById('rows');

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- 列定义 ---------- */
  let hideRegex = null;

  function groupOf(key) {
    return state.init.groups.find((g) => g.key === key);
  }

  /** 返回某个分组/错误视图的可见列信息：[{i, col}]、总宽度(ch) */
  const colCache = new Map();
  function visibleCols(key) {
    const hit = colCache.get(key + '|' + state.hideFiller);
    if (hit) {
      return hit;
    }
    let cols;
    if (key === ERR_VIEW) {
      cols = ERR_COLUMNS;
    } else {
      cols = groupOf(key).columns;
    }
    const vis = [];
    let total = 0;
    cols.forEach((col, i) => {
      if (state.hideFiller && hideRegex && key !== ERR_VIEW && hideRegex.test(col.name)) {
        return;
      }
      vis.push({ i, col });
      total += col.width;
    });
    const res = { vis, total };
    colCache.set(key + '|' + state.hideFiller, res);
    return res;
  }

  /** 固定表头的行数：文件顺序视图没有（表头随记录插入），错误视图 1 行，其余 3 行 */
  function hdrRowsOf(view) {
    return view === ORDER_VIEW ? 0 : view === ERR_VIEW ? 1 : 3;
  }

  /* ---------- 视图尺寸 ---------- */
  function viewCount(view) {
    const d = state.init;
    if (view === ORDER_VIEW) return d.orderCount;
    if (view === ERR_VIEW) return d.errorCount;
    const g = groupOf(view);
    return g ? g.count : 0;
  }

  function viewWidth() {
    const d = state.init;
    if (state.view === ORDER_VIEW) {
      let w = visibleCols(ERR_VIEW).total;
      d.groups.forEach((g) => (w = Math.max(w, visibleCols(g.key).total)));
      return LEFT_W + w;
    }
    return LEFT_W + visibleCols(state.view).total;
  }

  /* ---------- 渲染：工具栏 / 标签页 / 提示条 ---------- */
  function renderToolbar() {
    const d = state.init;
    const sizeKB = d.size >= 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : (d.size / 1024).toFixed(1) + ' KB';
    $toolbar.innerHTML =
      `<span class="file">${esc(d.fileName)}</span>` +
      `<span class="meta">${sizeKB} · ${d.total - d.errorCount} 条记录` +
      (d.errorCount ? ` · <span class="st-err">${d.errorCount} 处错误</span>` : '') +
      `</span><span class="spacer"></span>` +
      `<label title="按字段名隐藏列（设置：rdwViewer.hiddenFieldPattern）"><input type="checkbox" id="hideFiller" ${state.hideFiller ? 'checked' : ''}>隐藏 FILLER 列</label>` +
      `<label>编码 <select id="enc">${d.encodings
        .map((e) => `<option value="${e}" ${e === d.encoding ? 'selected' : ''}>${e}</option>`)
        .join('')}</select></label>`;
    document.getElementById('hideFiller').onchange = (ev) => {
      state.hideFiller = ev.target.checked;
      resetView(true);
    };
    document.getElementById('enc').onchange = (ev) => {
      vscode.postMessage({ type: 'setEncoding', encoding: ev.target.value });
    };
  }

  function renderTabs() {
    const d = state.init;
    const parts = d.groups.map((g) => {
      const cb = g.copybookName
        ? `<span class="cb" title="${esc(g.copybookName)}">✔ ${esc(g.copybookName)}</span>`
        : '<span class="nocb">未指定copybook</span>';
      return `<button class="tab ${state.view === g.key ? 'active' : ''}" data-v="${g.key}">${g.length} 字节 <small>× ${g.count}</small>${cb}</button>`;
    });
    if (d.errorCount) {
      parts.push(
        `<button class="tab errtab ${state.view === ERR_VIEW ? 'active' : ''}" data-v="${ERR_VIEW}">错误 <small>× ${d.errorCount}</small></button>`
      );
    }
    parts.push(
      `<button class="tab ordertab ${state.view === ORDER_VIEW ? 'active' : ''}" data-v="${ORDER_VIEW}" title="按文件原始顺序混排，copybook 切换处插入表头">文件顺序</button>`
    );
    $tabs.innerHTML = parts.join('');
    $tabs.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        if (state.view !== b.dataset.v) {
          state.view = b.dataset.v;
          state.selected = null;
          clearCellbar();
          resetView(false);
        }
      };
    });
  }

  function renderBanner() {
    const d = state.init;
    let level = 'info';
    let text = '';
    let buttons = '';
    if (state.view === ORDER_VIEW) {
      const unmapped = d.groups.filter((g) => !g.copybookName).length;
      level = unmapped || d.errorCount ? 'warn' : 'info';
      text = `文件顺序视图：共 ${d.groups.length} 种长度` + (unmapped ? `，其中 ${unmapped} 种尚未指定 copybook（在对应标签页中选择）` : '') + (d.errorCount ? `，${d.errorCount} 处错误` : '') + '。';
    } else if (state.view === ERR_VIEW) {
      level = 'error';
      text = `共 ${d.errorCount} 处 RDW 错误。偏移为文件内的字节位置（十六进制）。`;
    } else {
      const g = groupOf(state.view);
      level = g.banner.level;
      text = g.banner.text;
      buttons = `<button class="primary" data-act="choose">${g.copybookName ? '更换 copybook…' : '选择 copybook…'}</button>`;
      if (g.copybookName || g.banner.level === 'error') {
        buttons += '<button data-act="clear">清除</button>';
      }
    }
    $banner.className = level;
    $banner.innerHTML = `<span class="text">${esc(text)}</span>${buttons}`;
    const g = groupOf(state.view);
    $banner.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        if (!g) return;
        vscode.postMessage({ type: b.dataset.act === 'choose' ? 'chooseCopybook' : 'clearCopybook', length: g.length });
      };
    });
  }

  function clearCellbar() {
    $cellbar.innerHTML = '<span class="hint">点击单元格查看字段值和原始字节</span>';
  }

  /* ---------- 表头 ---------- */
  function headerRowHtml(key, k, isAbs, top) {
    const { vis } = visibleCols(key);
    const label = key === ERR_VIEW ? '#' : ['項目名', '属 性', '相 対 位 置'][k];
    let html = `<div class="row" ${isAbs ? `style="top:${top}px;width:${viewWidth()}ch"` : ''}>`;
    html += `<div class="c l lh hd">${label}</div>`;
    for (const { col } of vis) {
      const cls = k === 0 ? '' : k === 1 ? ' pic' : ' pos';
      const text = k === 0 ? col.name : k === 1 ? col.pic : col.start || '';
      html += `<div class="c hd${cls} ${col.kind}" style="width:${col.width}ch" title="${esc(text)}">${esc(text)}</div>`;
    }
    return html + '</div>';
  }

  function renderStaticHeader() {
    if (state.view === ORDER_VIEW) {
      $hdr.style.display = 'none';
      $hdr.innerHTML = '';
      return;
    }
    $hdr.style.display = '';
    $hdr.style.width = viewWidth() + 'ch';
    const rows = [];
    for (let k = 0; k < hdrRowsOf(state.view); k++) rows.push(headerRowHtml(state.view, k, false));
    $hdr.innerHTML = rows.join('');
  }

  /* ---------- 行 ---------- */
  function rowHtml(row, i, view) {
    const top = i * ROW_H;
    const width = viewWidth();
    if (row.t === 'hdr') {
      return headerRowHtml(row.g, row.k, true, top);
    }
    const isErr = row.t === 'err';
    const key = isErr ? ERR_VIEW : row.g;
    const { vis } = visibleCols(key);
    const warn = !isErr && row.w.length > 0;
    const status = isErr ? '<span class="st-err">✖</span>' : warn ? '<span class="st-warn">⚠</span>' : '';
    let html = `<div class="row ${isErr ? 'err' : ''}" style="top:${top}px;width:${width}ch">`;
    html += `<div class="c l l0">${row.e + 1}</div>`;
    html += `<div class="c l l1" title="偏移 ${row.o}">0x${row.o.toString(16).toUpperCase().padStart(8, '0')}</div>`;
    html += `<div class="c l l2">${status}</div>`;
    const warnSet = isErr ? null : new Set(row.w);
    for (const { i: ci, col } of vis) {
      const text = row.c[ci];
      const isW = warnSet && warnSet.has(ci);
      const sel =
        state.selected && state.selected.view === view && state.selected.row === i && state.selected.col === ci ? ' sel' : '';
      const num = col.type === 'num' ? ' num' : '';
      html += `<div class="c f${isW ? ' w' : ''}${sel}${num}" style="width:${col.width}ch" data-r="${i}" data-c="${ci}" title="${esc(text)}">${esc(text)}</div>`;
    }
    return html + '</div>';
  }

  function cacheFor(view) {
    let m = state.cache.get(view);
    if (!m) {
      m = new Map();
      state.cache.set(view, m);
    }
    return m;
  }

  function requestBlock(view, b) {
    const m = cacheFor(view);
    if (m.has(b)) return;
    m.set(b, 'pending');
    vscode.postMessage({ type: 'getRows', gen: state.gen, view, start: b * BLOCK, count: BLOCK });
  }

  let drawQueued = false;
  function scheduleDraw() {
    if (!drawQueued) {
      drawQueued = true;
      requestAnimationFrame(() => {
        drawQueued = false;
        draw();
      });
    }
  }

  function draw() {
    if (!state.init || !state.view) return;
    const view = state.view;
    const n = viewCount(view);
    const hdrH = hdrRowsOf(view) * ROW_H;
    const top = $scroller.scrollTop;
    const first = Math.max(0, Math.floor((top - hdrH) / ROW_H) - 3);
    const last = Math.min(n - 1, Math.ceil((top + $scroller.clientHeight - hdrH) / ROW_H) + 3);
    const m = cacheFor(view);
    let html = '';
    for (let i = first; i <= last; i++) {
      const b = Math.floor(i / BLOCK);
      const block = m.get(b);
      if (!block) {
        requestBlock(view, b);
        continue;
      }
      if (block === 'pending') continue;
      const row = block[i - b * BLOCK];
      if (row) html += rowHtml(row, i, view);
    }
    $rows.innerHTML = html;
  }

  function resetView(keepScroll) {
    const st = keepScroll ? $scroller.scrollTop : 0;
    colCache.clear();
    if (!keepScroll) {
      $scroller.scrollTop = 0;
      $scroller.scrollLeft = 0;
    }
    const n = viewCount(state.view);
    $inner.style.width = viewWidth() + 'ch';
    $rows.style.height = n * ROW_H + 'px';
    renderTabs();
    renderBanner();
    renderStaticHeader();
    if (n === 0) {
      $rows.innerHTML = '<div id="empty">没有可显示的记录</div>';
    } else {
      $scroller.scrollTop = st;
      draw();
    }
  }

  /* ---------- 事件 ---------- */
  $scroller.addEventListener('scroll', scheduleDraw, { passive: true });
  window.addEventListener('resize', scheduleDraw);

  $rows.addEventListener('click', (ev) => {
    const el = ev.target.closest('.c.f');
    if (!el) return;
    const rowIdx = Number(el.dataset.r);
    const colIdx = Number(el.dataset.c);
    const view = state.view;
    const b = Math.floor(rowIdx / BLOCK);
    const block = cacheFor(view).get(b);
    if (!block || block === 'pending') return;
    const row = block[rowIdx - b * BLOCK];
    if (!row || row.t === 'hdr') return;
    state.selected = { view, row: rowIdx, col: colIdx };
    if (row.t === 'err') {
      $cellbar.innerHTML = `<span class="name">${esc(ERR_COLUMNS[colIdx].name)}</span><span class="value">${esc(row.c[colIdx])}</span>`;
    } else {
      vscode.postMessage({ type: 'cellInfo', g: row.g, e: row.e, col: colIdx });
    }
    draw();
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'init': {
        state.init = msg;
        state.gen = msg.gen;
        state.cache.clear();
        state.selected = null;
        try {
          hideRegex = msg.hiddenPattern ? new RegExp(msg.hiddenPattern, 'i') : null;
        } catch (e) {
          hideRegex = null;
        }
        const keys = msg.groups.map((g) => g.key).concat([ERR_VIEW, ORDER_VIEW]);
        const keep = state.view && keys.includes(state.view);
        if (!keep) {
          state.view = msg.groups.length ? msg.groups[0].key : msg.errorCount ? ERR_VIEW : ORDER_VIEW;
        }
        clearCellbar();
        renderToolbar();
        resetView(keep);
        break;
      }
      case 'rows': {
        if (msg.gen !== state.gen) return;
        const m = cacheFor(msg.view);
        m.set(msg.start / BLOCK, msg.rows);
        if (msg.view === state.view) scheduleDraw();
        break;
      }
      case 'cell': {
        const c = msg.info;
        if (!c) return;
        $cellbar.innerHTML =
          `<span class="name" title="${esc(c.name)}">${esc(c.name)}</span>` +
          `<span class="value ${c.warn ? 'warn' : ''}">${esc(c.text)}</span>` +
          `<span class="hint">${esc(c.pic)} · 位置 ${c.start} · ${c.len} 字节</span>` +
          `<span class="hex" title="${esc(c.hex)}">${esc(c.hex)}</span>`;
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
