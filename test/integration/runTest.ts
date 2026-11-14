/**
 * 在真实的 VS Code 中运行集成测试：下载指定版本的 VS Code，加载本扩展，打开 examples/ 作为工作区，
 * 然后执行 suite.ts。
 *
 *   npm run test:integration                      # 最新稳定版
 *   VSCODE_VERSION=1.85.2 npm run test:integration # package.json 的 engines 声明的最低版本
 *
 * Linux 上没有显示器时用 xvfb-run -a 运行（CI 即如此）。
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [path.join(root, 'examples'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('Integration tests failed:', e);
    process.exit(1);
  }
}

void main();
