// 一键把 cockpit 的状态 hook 装进 ~/.claude/settings.json —— 让手机端状态「即时」
// 用法： node install-hooks.mjs
// 幂等（可重复跑）、自动备份原配置到 settings.json.bak。装完重启 Claude Code 生效。
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(__dirname, 'hook-bridge.mjs');
const dir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(dir, 'settings.json');

// 事件 → 状态：UserPromptSubmit=思考 / PreToolUse,PostToolUse=执行 / Stop=完成,即时转空闲 / Notification=等待审批
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
const cmd = (ev) => `node '${bridge}' ${ev}`;
const entry = (ev) => ({ ...((ev === 'PreToolUse' || ev === 'PostToolUse') ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: cmd(ev) }] });

let settings = {};
try { mkdirSync(dir, { recursive: true }); } catch {}
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (e) { console.error('✗ 现有 settings.json 无法解析，未改动。请检查：', settingsPath, '\n', e.message); process.exit(1); }
  copyFileSync(settingsPath, settingsPath + '.bak');
}

settings.hooks = settings.hooks || {};
let added = 0;
for (const ev of EVENTS) {
  const arr = (settings.hooks[ev] = settings.hooks[ev] || []);
  if (JSON.stringify(arr).includes('hook-bridge.mjs')) continue;   // 幂等：已装则跳过
  arr.push(entry(ev));
  added++;
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(added ? `✓ 已装入 ${added} 个状态 hook` : '✓ 已是最新（hook 之前就装好了）');
console.log('  配置文件：', settingsPath);
if (existsSync(settingsPath + '.bak')) console.log('  原配置备份：', settingsPath + '.bak');
console.log('\n→ 现在退出并重开 Claude Code，手机端状态就即时了（按停止立刻变空闲）。');
