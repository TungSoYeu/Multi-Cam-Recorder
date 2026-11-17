import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../../packages/shared/src/client.ts';

test('ClockSync ước lượng lệch giờ, ưu tiên mẫu có độ trễ thấp', () => {
  const c = new ClockSync();
  // Server nhanh hơn 5000 ms, RTT 200 ms
  c.sample(1000, 1200, 6100);
  assert.equal(c.offset, 5000);
  assert.equal(c.toLocal(10_000), 5000);
  // Mẫu RTT lớn (2000 ms) và lệch → bị bỏ qua
  c.sample(2000, 4000, 9000);
  assert.equal(c.offset, 5000);
  // Mẫu RTT nhỏ hơn → được dùng
  c.sample(5000, 5050, 10_030);
  assert.equal(c.offset, 5005);
  assert.equal(c.rtt, 50);
});
