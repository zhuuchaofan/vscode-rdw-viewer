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
type MemberCache = Map<string, Promise<CopyMember | null>>;

/** 一次读取中最多展开的登録集原文数（防止异常的引用关系） */
const MAX_COPY_MEMBERS = 200;

/** 查找并读取 COPY 引用的登録集原文（查找顺序见 copyresolve.ts） */
function resolveMember(name: string, library: string | undefined, baseDir: vscode.Uri, cache: MemberCache): Promise<CopyMember | null> {
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
        const text = decodeCopybookText(await vscode.workspace.fs.readFile(found.get(pick.chosen)!));
        return { text, source: rel(pick.chosen), others: pick.others.map(rel) };
      } catch {
        return null;
      }
    })();
    cache.set(key, hit);
  }
  return hit;
}

/** 读取 copybook，事先找到并读取其中（含嵌套的）COPY 引用的登録集原文，然后解析 */
export async function loadCopybook(uri: vscode.Uri, cache: MemberCache = new Map()): Promise<Copybook> {
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
      members.set(k, m);
      queue.push(...copyReferences(m.text));
    }
  }
  return parseCopybook(text, { resolve: (name, library) => members.get(keyOf(name, library)) });
}

/** 工作区中的 copybook 及其总长度（无法解析的为 -1） */
export async function scanCopybooks(): Promise<Array<{ uri: vscode.Uri; total: number }>> {
  const files = await vscode.workspace.findFiles(COPYBOOK_GLOB, '**/{node_modules,.git,out}/**', 500);
  const out: Array<{ uri: vscode.Uri; total: number }> = [];
  const cache: MemberCache = new Map();
  for (const uri of files) {
    let total = -1;
    try {
      total = (await loadCopybook(uri, cache)).totalLength;
    } catch {
      /* 读不了就当长度未知 */
    }
    out.push({ uri, total });
  }
  return out;
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
