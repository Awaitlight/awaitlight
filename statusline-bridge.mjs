// Claude Code statusLine 桥：Claude Code 每次渲染会把一段 JSON 通过 stdin 传进来。
// 本脚本：① 把原始 JSON 转发给本地 cockpit 服务；② 落一份 statusline-latest.json 方便你直接 cat 查看；
// ③ 仍向 stdout 打印一行简短状态，保证 Claude Code 自己的状态栏正常显示。
// 设计原则：绝不阻塞 Claude Code —— 转发是 fire-and-forget，出错全部吞掉。
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const PORT = process.env.COCKPIT_PORT || process.env.PORT || 8787;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let json = null;
  try { json = JSON.parse(input); } catch {}

  // 落最新一份，方便 `cat cockpit/statusline-latest.json` 直接看真实字段
  try { await writeFile(path.join(__dirname, 'statusline-latest.json'), input || '{}'); } catch {}

  if (json) forward(input);

  process.stdout.write(renderLine(json));
});

function forward(body) {
  try {
    const req = http.request(
      { host: HOST, port: PORT, path: process.env.COCKPIT_LIMITS_ONLY ? '/ingest?limitsOnly=1' : '/ingest', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 400 },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch {}
}

function pct(v) { const x = Number(v); return Number.isFinite(x) ? Math.round(x) + '%' : null; }

function renderLine(j) {
  if (!j) return '◴ cockpit: no json';
  const model = j?.model?.display_name || j?.model?.id || 'model';
  const ctx = j?.context_window?.used_percentage ?? j?.contextWindow?.used_percentage ?? j?.context?.used_percentage;
  const rl = j?.rate_limits || j?.rateLimits || {};
  const five = (rl.five_hour || rl.fiveHour)?.used_percentage ?? (rl.five_hour || rl.fiveHour)?.usedPercentage;
  const cost = j?.cost?.total_cost_usd;
  const parts = ['▮ ' + model];
  if (pct(ctx)) parts.push('ctx ' + pct(ctx));
  if (pct(five)) parts.push('5h ' + pct(five));
  if (Number.isFinite(Number(cost))) parts.push('$' + Number(cost).toFixed(2));
  return parts.join('  ');
}
