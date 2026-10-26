import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractNextSteps, DEFAULT_STATUS_DOCS } from '../skills/devbrief/scripts/collect.mjs';

// A Windows checkout may turn line endings into CRLF.
const wrap = fs.readFileSync(fileURLToPath(new URL('../skills/devbrief/reference/wrap.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

test('the STATUS.md template in wrap.md reads back as open Next and Blocked items only', () => {
  const template = wrap.match(/```markdown\n([\s\S]*?)```/)[1]
    .replace('<project>', 'shop-api')
    .replace('<the most important next step>', 'Add login')
    .replace(/<waiting on[^>]*>/, 'Payment keys from the bank')
    .replace(/<what this session[^>]*>/, 'Fixed the cart total');
  assert.deepEqual(extractNextSteps(template), {
    title: 'shop-api status',
    items: [
      { text: 'Add login', section: 'Next' },
      { text: 'Payment keys from the bank', section: 'Blocked' },
    ],
  });
});

test('the finished-item conventions in wrap.md are ones the collector skips', () => {
  const doc = '# x\n\n## Next\n- [x] Add login\n- ~~Fix cart~~\n- Done: deploy\n- [ ] Write docs\n';
  assert.deepEqual(extractNextSteps(doc).items, [{ text: 'Write docs', section: 'Next' }]);
});

test('wrap.md lists the same status docs, in the same order, as the collector', () => {
  const block = wrap.match(/```\n(LAUNCH-STATUS[\s\S]*?)```/)[1];
  assert.deepEqual(block.split(/\s+/).filter(Boolean), DEFAULT_STATUS_DOCS);
});
