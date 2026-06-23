// Claude Code hook 桥（可选，但能让 cockpit 显示真实的 运行中/思考中/等待确认/空闲 状态）。
// 配置见 README：把不同事件指向 `node hook-bridge.mjs <事件名>`。
// 事件名作为第一个命令行参数；事件 payload 从 stdin 读入。
// 关键：对 hooks 必须快速退出、且 stdout 不输出内容（避免向 Claude Code 注入文本）。
import http from 'node:http';

const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const PORT = process.env.COCKPIT_PORT || process.env.PORT || 8787;
const event = process.argv[2] || 'unknown';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch {}
  const body = JSON.stringify({ event, payload });
  try {
    const req = http.request(
      { host: HOST, port: PORT, path: '/ingest-hook', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 400 },
      (res) => res.resume()
    );
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.end(body, () => process.exit(0));
  } catch { process.exit(0); }
});
