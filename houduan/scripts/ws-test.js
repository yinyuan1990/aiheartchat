/* IM WebSocket 链路自测：男号发消息，女号应实时收到 */
const WebSocket = require('ws');

const BASE = 'http://8.162.5.160:20080';

async function getToken(deviceId) {
  const res = await fetch(`${BASE}/api/auth/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const json = await res.json();
  return json.data.token;
}

async function main() {
  const [tm, tf] = await Promise.all([
    getToken('test_device_m_00000001'),
    getToken('test_device_f_00000001'),
  ]);

  const wsF = new WebSocket(`ws://8.162.5.160:20080/ws?token=${tf}`);
  const wsM = new WebSocket(`ws://8.162.5.160:20080/ws?token=${tm}`);

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时未收到消息')), 10000);
    wsF.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 'msg') {
        console.log('[女号收到]', JSON.stringify(frame.data));
        clearTimeout(timer);
        resolve();
      }
    });
  });

  wsM.on('message', (raw) => {
    console.error('[男号帧]', raw.toString());
  });

  await new Promise((r) => wsM.on('open', r));
  await new Promise((r) => wsF.on('open', r));
  console.log('双端已连接，男号发送消息...');
  wsM.send(JSON.stringify({ op: 'send', tempId: 't1', convType: 1, targetId: '2', msgType: 'text', content: '你好，这是一条加密测试消息' }));

  await done;
  console.log('WS 链路测试通过');
  wsM.close();
  wsF.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
