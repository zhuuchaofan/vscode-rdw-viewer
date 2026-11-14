/** 记录长度 / 判别字段值 → copybook 的指定、布局选择的保存（.vscode/rdw-viewer.json 或全局状态）。 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Discriminator } from '../session';

const MAPPING_FILE = ['.vscode', 'rdw-viewer.json'];

const GLOBAL_KEY = 'rdwViewer.copybooks';

interface StoredDiscriminator extends Discriminator {
  /** 字段值 → copybook 路径 */
  copybooks: Record<string, string>;
}

interface MappingConfig {
  /** 长度 → copybook 路径 */
  copybooks: Record<string, string>;
  /** 长度 → 判别字段及「字段值 → copybook」 */
  discriminators: Record<string, StoredDiscriminator>;
  /** 分组（长度，或「长度=字段值」）→ REDEFINES / 01 的布局选择 */
  layouts: Record<string, Record<string, string>>;
}

/** 布局选择的保存键 */
export const layoutKey = (length: number, value?: string) => (value === undefined ? String(length) : `${length}=${value}`);

/**
 * copybook 映射的存储。
 * 有工作区时保存在 <工作区>/.vscode/rdw-viewer.json（路径相对工作区），否则保存在全局状态里（绝对路径）。
 */
export class MappingStore {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder | undefined
  ) {}

  private get file(): vscode.Uri | undefined {
    return this.folder ? vscode.Uri.joinPath(this.folder.uri, ...MAPPING_FILE) : undefined;
  }

  private static normalize(raw: unknown): MappingConfig {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    // 兼容旧版全局状态：直接保存的是「长度 → 路径」
    if (!('copybooks' in o) && !('discriminators' in o)) {
      return { copybooks: { ...(o as Record<string, string>) }, discriminators: {}, layouts: {} };
    }
    return {
      copybooks: { ...((o.copybooks as Record<string, string>) ?? {}) },
      discriminators: { ...((o.discriminators as Record<string, StoredDiscriminator>) ?? {}) },
      layouts: { ...((o.layouts as Record<string, Record<string, string>>) ?? {}) },
    };
  }

  async read(): Promise<MappingConfig> {
    const file = this.file;
    if (!file) {
      return MappingStore.normalize(this.ctx.globalState.get(GLOBAL_KEY));
    }
    try {
      return MappingStore.normalize(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))));
    } catch {
      return MappingStore.normalize(undefined);
    }
  }

  private async write(cfg: MappingConfig): Promise<void> {
    const file = this.file;
    if (!file) {
      await this.ctx.globalState.update(GLOBAL_KEY, cfg);
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder!.uri, MAPPING_FILE[0]));
    const text = JSON.stringify(cfg, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  }

  resolve(stored: string): vscode.Uri {
    if (this.folder && !path.isAbsolute(stored)) {
      return vscode.Uri.joinPath(this.folder.uri, ...stored.split(/[\\/]/));
    }
    return vscode.Uri.file(stored);
  }

  toStored(uri: vscode.Uri): string {
    if (this.folder) {
      const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
    }
    return uri.fsPath;
  }

  /** 为分组指定/清除 copybook；value 为判别字段值（按字段值区分时） */
  async setCopybook(length: number, value: string | undefined, uri: vscode.Uri | undefined): Promise<void> {
    const cfg = await this.read();
    const map = value === undefined ? cfg.copybooks : cfg.discriminators[String(length)]?.copybooks;
    if (!map) {
      return;
    }
    const k = value === undefined ? String(length) : value;
    if (uri) {
      map[k] = this.toStored(uri);
    } else if (value === undefined) {
      // 空字符串 = 明确指定「不使用 copybook」，不再自动选择
      map[k] = '';
    } else {
      delete map[k];
    }
    await this.write(cfg);
  }

  /** 保存布局选择（option 为 undefined 时恢复默认） */
  async setLayout(length: number, value: string | undefined, id: string, option: string | undefined): Promise<void> {
    const cfg = await this.read();
    const k = layoutKey(length, value);
    const sel = { ...(cfg.layouts[k] ?? {}) };
    if (option === undefined) {
      delete sel[id];
    } else {
      sel[id] = option;
    }
    if (Object.keys(sel).length) {
      cfg.layouts[k] = sel;
    } else {
      delete cfg.layouts[k];
    }
    await this.write(cfg);
  }

  /** 设置/取消判别字段；位置和类型不变时保留已指定的 copybook */
  async setDiscriminator(length: number, d: Discriminator | null): Promise<void> {
    const cfg = await this.read();
    const k = String(length);
    if (!d) {
      delete cfg.discriminators[k];
    } else {
      const cur = cfg.discriminators[k];
      const same = cur && cur.start === d.start && cur.length === d.length && cur.type === d.type;
      cfg.discriminators[k] = { start: d.start, length: d.length, type: d.type, copybooks: same ? cur.copybooks : {} };
    }
    await this.write(cfg);
  }
}
