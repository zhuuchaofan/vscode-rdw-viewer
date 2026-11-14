/**
 * 用 vscode-stub 代替 `vscode` 模块加载 src/extension.ts（必须在第一次 require extension 之前调用）。
 * node --test 中每个测试文件在各自的进程里运行，所以各文件分别调用一次。
 */
import type * as Stub from './vscode-stub';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
// ext 的参数类型是真实的 vscode 类型，与替身不一致，所以按 any 使用
export function loadExtension(): { vscode: typeof Stub; ext: any } {
  const Module = require('module');
  const stubPath = require.resolve('./vscode-stub');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? stubPath : origResolve.call(this, request, ...rest);
  };
  return { vscode: require('./vscode-stub'), ext: require('../../src/extension') };
}
