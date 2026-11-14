/**
 * 界面文字的多语言支持：日语为主要界面语言，VS Code 的显示语言为中文时显示中文。
 *
 * 不依赖 VS Code：扩展激活时根据 vscode.env.language 调用 setLocale()；
 * 以 "ui." 开头的键会随 init 消息发给 webview。
 * 占位符写成 {name}，由 t() 替换。
 */
import { zh, MessageKey } from './messages/zh';
import { ja } from './messages/ja';

export type { MessageKey };

let dict: Record<MessageKey, string> = ja;
let current = 'ja';

/** 根据 VS Code 的显示语言切换：中文（zh*）显示中文，其他语言一律显示日语（主要界面语言） */
export function setLocale(lang: string | undefined): void {
  const isZh = (lang ?? '').toLowerCase().startsWith('zh');
  dict = isZh ? zh : ja;
  current = isZh ? 'zh' : 'ja';
}

export function getLocale(): string {
  return current;
}

export function t(key: MessageKey, args: Record<string, string | number> = {}): string {
  return dict[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in args ? String(args[name]) : m));
}

/** 发给 webview 的文字（ui.* 键，去掉前缀） */
export function uiStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dict)) {
    if (k.startsWith('ui.')) {
      out[k.slice(3)] = v;
    }
  }
  return out;
}

/** 供测试：两种语言的字典 */
export const DICTS = { zh, ja };
