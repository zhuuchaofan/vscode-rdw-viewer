/** examples/ を再生成する：npm run examples */
import * as fs from 'fs';
import * as path from 'path';
import { buildExamples } from './examples';

const root = path.resolve(__dirname, '../../../examples');
for (const [rel, data] of Object.entries(buildExamples())) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`${rel} (${data.length} bytes)`);
}
