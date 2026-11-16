/** copybook 的读取（含 COPY 引用的登録集原文的查找）、工作区中的 copybook 一览与选择。 */
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../i18n';
import { parseCopybook, copyReferences, Copybook, CopyMember } from '../copybook';
import { memberFileNames, pickMember } from '../copyresolve';
import { MappingStore } from './mapping';

const COPYBOOK_GLOB = '**/*.{cpy,CPY,cbl,CBL,cob,COB,copy,COPY}';

/** 把 copybook 文件按 UTF-8 解码，失败则回退 Shift_JIS（日文注释常见） */
function decodeCopybookText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** COPY 引用的登録集原文的查找结果（null=找不到），在一次读取（或一次扫描）中共用 */
type MemberCache = Map<string, Promise<{ member: CopyMember; uri: vscode.Uri } | null>>;

/** 读取一个 copybook 时用到的其他文件（展开的 COPY 原文），以及是否有找不到的 COPY */
interface CopyDeps {
  uris: vscode.Uri[];
  unresolved: boolean;
}

/** 一次读取中最多展开的登録集原文数（防止异常的引用关系） */
const MAX_COPY_MEMBERS = 200;

/** 查找并读取 COPY 引用的登録集原文（查找顺序见 copyresolve.ts） */
function resolveMember(
  name: string,
  library: string | undefined,
  baseDir: vscode.Uri,
  cache: MemberCache
): Promise<{ member: CopyMember; uri: vscode.Uri } | null> {
  const key = `${baseDir.toString()}|${(library ?? '').toUpperCase()}|${name.toUpperCase()}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const names = memberFileNames(name);
      const found = new Map<string, vscode.Uri>();
      // 1. 同一目录（原文名写成相对路径时也按它查找）
      for (const fn of [...new Set([name, ...names.map((n) => path.join(path.dirname(name), n))])]) {
        const uri = vscode.Uri.joinPath(baseDir, fn);
        try {
          if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) found.set(uri.fsPath, uri);
        } catch {
          /* 不存在 */
        }
      }
      // 2. 工作区中的同名文件
      const glob = `**/{${names.map((n) => n.replace(/[{}[\],*?]/g, '?')).join(',')}}`;
      for (const uri of await vscode.workspace.findFiles(glob, '**/{node_modules,.git,out}/**', 20)) {
        found.set(uri.fsPath, uri);
      }
      const pick = pickMember(name, library, [...found.keys()], baseDir.fsPath);
      if (!pick) {
        return null;
      }
      const rel = (f: string) => vscode.workspace.asRelativePath(found.get(f)!);
      try {
        const uri = found.get(pick.chosen)!;
        const text = decodeCopybookText(await vscode.workspace.fs.readFile(uri));
        return { member: { text, source: rel(pick.chosen), others: pick.others.map(rel) }, uri };
      } catch {
        return null;
      }
    })();
    cache.set(key, hit);
  }
  return hit;
}

/** 读取 copybook，事先找到并读取其中（含嵌套的）COPY 引用的登録集原文，然后解析 */
export async function loadCopybook(uri: vscode.Uri, cache: MemberCache = new Map(), deps?: CopyDeps): Promise<Copybook> {
  const text = decodeCopybookText(await vscode.workspace.fs.readFile(uri));
  const baseDir = vscode.Uri.joinPath(uri, '..');
  const keyOf = (name: string, library?: string) => `${(library ?? '').toUpperCase()}|${name.toUpperCase()}`;
  const members = new Map<string, CopyMember>();
  const tried = new Set<string>();
  const queue = copyReferences(text);
  while (queue.length > 0 && tried.size < MAX_COPY_MEMBERS) {
    const ref = queue.shift()!;
    const k = keyOf(ref.name, ref.library);
    if (tried.has(k)) continue;
    tried.add(k);
    const m = await resolveMember(ref.name, ref.library, baseDir, cache);
    if (m) {
      members.set(k, m.member);
      deps?.uris.push(m.uri);
      queue.push(...copyReferences(m.member.text));
    } else if (deps) {
      deps.unresolved = true;
    }
  }
  return parseCopybook(text, { resolve: (name, library) => members.get(keyOf(name, library)) });
}

/** 文件的「版本」：修改时间与大小；取不到时为 undefined */
async function fileStamp(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const st = await vscode.workspace.fs.stat(uri);
    return `${st.mtime}|${st.size}`;
  } catch {
    return undefined;
  }
}

interface ScanEntry {
  stamp: string;
  /** 展开的 COPY 原文及其版本 */
  deps: Array<{ uri: vscode.Uri; stamp: string | undefined }>;
  /** 有找不到的 COPY：工作区新建文件后要重新解析（可能找得到了） */
  unresolved: boolean;
  total: number;
}

/**
 * 工作区 copybook 一览的缓存（文件 URI → 总长度）。
 * 打开没有保存设置的文件时都要按长度自动匹配 copybook，每次重新读取、解析（并为 COPY 在工作区中查找原文）
 * 在 copybook 很多的工作区里要花好几秒；文件本身和展开的 COPY 原文都没有变化时直接使用上次的结果。
 */
const scanCache = new Map<string, ScanEntry>();
let createWatcher: vscode.Disposable | undefined;

/** 工作区中的 copybook 及其总长度（无法解析的为 -1） */
export async function scanCopybooks(): Promise<Array<{ uri: vscode.Uri; total: number }>> {
  if (!createWatcher && vscode.workspace.createFileSystemWatcher) {
    // 新建的文件可能就是之前找不到的 COPY 原文，也可能改变同名原文的选择
    const w = vscode.workspace.createFileSystemWatcher('**/*', false, true, true);
    w.onDidCreate(() => {
      for (const [k, e] of scanCache) if (e.unresolved || e.deps.length > 0) scanCache.delete(k);
    });
    createWatcher = w;
  }
  const files = await vscode.workspace.findFiles(COPYBOOK_GLOB, '**/{node_modules,.git,out}/**', 500);
  const out: Array<{ uri: vscode.Uri; total: number }> = [];
  const cache: MemberCache = new Map();
  const seen = new Set<string>();
  for (const uri of files) {
    const key = uri.toString();
    seen.add(key);
    const stamp = await fileStamp(uri);
    const hit = scanCache.get(key);
    if (hit && stamp !== undefined && hit.stamp === stamp && (await depsUnchanged(hit.deps))) {
      out.push({ uri, total: hit.total });
      continue;
    }
    let total = -1;
    const deps: CopyDeps = { uris: [], unresolved: false };
    try {
      total = (await loadCopybook(uri, cache, deps)).totalLength;
    } catch {
      /* 读不了就当长度未知 */
    }
    if (stamp !== undefined) {
      const depStamps = await Promise.all(deps.uris.map(async (u) => ({ uri: u, stamp: await fileStamp(u) })));
      scanCache.set(key, { stamp, deps: depStamps, unresolved: deps.unresolved, total });
    } else {
      scanCache.delete(key);
    }
    out.push({ uri, total });
  }
  // 已经不在工作区中的文件
  for (const k of [...scanCache.keys()]) if (!seen.has(k)) scanCache.delete(k);
  return out;
}

async function depsUnchanged(deps: ScanEntry['deps']): Promise<boolean> {
  for (const d of deps) {
    if ((await fileStamp(d.uri)) !== d.stamp) return false;
  }
  return true;
}

/** 供测试：清空 copybook 一览的缓存 */
export function clearCopybookScanCache(): void {
  scanCache.clear();
}

export async function pickCopybook(length: number, store: MappingStore, value?: string): Promise<vscode.Uri | undefined> {
  interface Item extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    browse?: boolean;
    match: boolean;
  }
  const items: Item[] = [];
  for (const { uri, total } of await scanCopybooks()) {
    const match = total === length;
    items.push({
      label: `${match ? '$(check) ' : ''}${path.basename(uri.fsPath)}`,
      description: vscode.workspace.asRelativePath(uri, false),
      detail: total >= 0 ? t(match ? 'ext.cpyDetailMatch' : 'ext.cpyDetail', { n: total }) : t('ext.cpyUnparsable'),
      uri,
      match,
    });
  }
  items.sort((a, b) => Number(b.match) - Number(a.match) || a.label.localeCompare(b.label));
  items.push({ label: t('ext.browse'), browse: true, match: false });

  const picked = await vscode.window.showQuickPick(items, {
    title: value === undefined ? t('ext.pickTitle', { len: length }) : t('ext.pickTitleValue', { len: length, value }),
    placeHolder: t('ext.pickPlaceholder'),
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.browse) {
    const res = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: t('ext.openDialogTitle', { len: length }),
      filters: { Copybook: ['cpy', 'cbl', 'cob', 'copy'], [t('ext.allFiles')]: ['*'] },
    });
    return res?.[0];
  }
  return picked.uri;
}
