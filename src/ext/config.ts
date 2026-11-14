/** 扩展的设置（rdwViewer.*）与各种「大文件」阈值。 */
import * as vscode from 'vscode';
import { MismatchMode } from '../layout';

export const EDITOR_VIEW_TYPE = 'rdwViewer.editor';

/** 各种「大文件」阈值（导出为可变对象，测试中调小以便用小文件走到大文件的路径） */
export const thresholds = {
  /** 本地文件大于该字节数时采用分页读取（不把整份文件载入内存） */
  pagedFile: 32 * 1024 * 1024,
  /** 文件大于该字节数时异步扫描并显示可取消进度通知 */
  scanProgress: 64 * 1024 * 1024,
  /** 两个文件的条目合计超过这个数时，比较在后台分批执行，显示进度并可以取消 */
  compareProgress: 200_000,
};

export function config() {
  const c = vscode.workspace.getConfiguration('rdwViewer');
  return {
    encoding: c.get<string>('encoding', 'shift_jis'),
    mismatch: c.get<MismatchMode>('lengthMismatch', 'lenient'),
    hiddenPattern: c.get<string>('hiddenFieldPattern', '^FILLER$'),
    binaryEndian: c.get<'big' | 'little'>('binaryEndian', 'big'),
    comp5Endian: c.get<'followBinaryEndian' | 'big' | 'little'>('comp5Endian', 'little'),
    floatFormat: c.get<'ieee' | 'ibm'>('floatFormat', 'ieee'),
    autoPacked: c.get<boolean>('autoDetectPacked', true),
    exportEncoding: c.get<'shift_jis' | 'utf-8-bom'>('exportEncoding', 'shift_jis'),
  };
}
