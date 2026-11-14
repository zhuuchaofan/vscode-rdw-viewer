
import * as vscode from 'vscode';
import { setLocale } from './i18n';
import { EDITOR_VIEW_TYPE } from './ext/config';
import { RdwEditorProvider, openViewer } from './ext/viewer';
import { openCompare } from './ext/compareView';

export function activate(ctx: vscode.ExtensionContext): void {
  setLocale(vscode.env.language);
  const provider = new RdwEditorProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('rdwViewer.open', (uri?: vscode.Uri) => openViewer(ctx, uri)),
    // エクスプローラーで 2 ファイルを選択した場合は uris に両方が入る
    vscode.commands.registerCommand('rdwViewer.compare', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const list = (uris ?? []).filter((u) => u instanceof vscode.Uri);
      return list.length >= 2 ? openCompare(ctx, list[0], list[1]) : openCompare(ctx, uri);
    })
  );
}

export function deactivate(): void {}

export { EDITOR_VIEW_TYPE, thresholds } from './ext/config';
