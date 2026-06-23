// 本地优先的 cockpit 服务：零依赖 Node。
// - GET  /          → 横屏 cockpit 网页（手机浏览器打开）
// - GET  /events    → SSE，推送最新状态
// - POST /ingest      → statusLine 桥喂入的原始 JSON
// - POST /ingest-hook → hook 桥喂入的事件（运行中/等待确认/空闲等）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try { DatabaseSync = (await import('node:sqlite')).DatabaseSync; } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// 内存中的最新状态 + 一小段历史（用于 burn-rate 估算）
const state = {
  statusline: null,        // 渲染用的状态对象（来自 statusLine 或会话转录）
  source: null,            // 'statusline' | 'transcript'
  account: 'unknown',      // 'subscription'（有 5h/7d 额度）| 'api' | 'unknown'
  codex: null,             // Codex CLI 采集结果
  cursor: null,            // Cursor 采集结果（state.vscdb）
  limits: null,            // 持久保留的额度：{ five, seven, capturedAt, model } —— 缓变，不被转录覆盖
  lastHook: null,          // { event, payload, ts }
  updatedAt: null,         // 最近更新时间（server 时钟 / 转录文件 mtime）
  history: [],             // [{ t, ctx, five, seven, cost }]
  config: { theme: null, lang: null, provider: null, hidden: [], pet: null },  // control-panel settings (persisted), pushed to phones over SSE; pet = idle companion on/off ('default' | 'off')
  sessions: [],            // 最近活跃的所有会话（多 agent 监控墙用）
};

const DATA = path.join(__dirname, 'data');
try { mkdirSync(DATA, { recursive: true }); } catch {}

function persistLimits() {
  try { writeFileSync(path.join(DATA, 'limits.json'), JSON.stringify(state.limits)); } catch {}
}
function loadLimits() {
  try { state.limits = JSON.parse(readFileSync(path.join(DATA, 'limits.json'), 'utf8')); state.account = state.limits ? 'subscription' : state.account; } catch {}
}
function persistConfig() { try { writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(state.config)); } catch {} }
function loadConfig() { try { const c = JSON.parse(readFileSync(path.join(DATA, 'config.json'), 'utf8')); if (c && typeof c === 'object') state.config = { theme: null, lang: null, provider: null, hidden: [], pet: null, ...c }; } catch {} }
// 从一条 statusLine JSON 里抽 rate_limits，更新持久额度（订阅账号才有）
function captureLimits(json) {
  const rl = json && (json.rate_limits || json.rateLimits);
  if (!rl) return false;
  const five = rl.five_hour || rl.fiveHour || rl['5h'] || null;
  const seven = rl.seven_day || rl.sevenDay || rl['7d'] || null;
  if (!five && !seven) return false;
  state.limits = { five, seven, capturedAt: Date.now(), model: json.model?.display_name || null };
  state.account = 'subscription';
  persistLimits();
  return true;
}
const clients = new Set();

function n(v) { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; }

// 尽力从 statusLine JSON 里抽取关键指标。字段命名随 Claude Code 版本可能不同，
// 这里做容错；真正的字段形态以网页“诊断”面板里的原始 JSON 为准。
function extractMetrics(s) {
  if (!s || typeof s !== 'object') return { model: null, ctx: null, five: null, seven: null, cost: null };
  const model = s.model?.display_name || s.model?.id || null;
  const cost = n(s.cost?.total_cost_usd);
  const ctx =
    n(s.context_window?.used_percentage) ??
    n(s.contextWindow?.used_percentage) ??
    n(s.context?.used_percentage) ?? null;
  const rl = s.rate_limits || s.rateLimits || {};
  const five = rl.five_hour || rl.fiveHour || rl['5h'] || null;
  const seven = rl.seven_day || rl.sevenDay || rl['7d'] || null;
  const fivePct = five ? n(five.used_percentage ?? five.usedPercentage) : null;
  const sevenPct = seven ? n(seven.used_percentage ?? seven.usedPercentage) : null;
  return { model, ctx, five: fivePct, seven: sevenPct, cost };
}

// ---------- 会话转录数据源（零配置）----------
// Claude Code 把每个会话写到 ~/.claude/projects/<编码路径>/<session>.jsonl。
// 里面的 assistant 消息带 usage（token 用量），可推算上下文占用与模型。
// 注意：转录文件没有 rate_limits（5h/7d）与精确成本——那两项只有 statusLine 提供。
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CTX_LIMIT = process.env.COCKPIT_CTX_LIMIT ? Number(process.env.COCKPIT_CTX_LIMIT) : 200000;
const MODEL_NAMES = {
  'claude-opus-4-8': 'Claude Opus 4.8', 'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6', 'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5', 'claude-fable-5': 'Claude Fable 5',
};
let tFile = null, tMtime = 0;
const ignored = new Set();   // 后台保鲜会话的转录文件，排除以免污染真实上下文显示

// ---------- 后台额度保鲜（零操作、保持最新）----------
const REFRESH_MIN = process.env.COCKPIT_REFRESH_MIN ? Number(process.env.COCKPIT_REFRESH_MIN) : 20;
const REFRESH_MODEL = process.env.COCKPIT_REFRESH_MODEL || 'claude-haiku-4-5';
let refreshing = false, lastRefresh = 0;
function refreshLimits(reason) {
  if (refreshing) return;
  refreshing = true; lastRefresh = Date.now();
  const script = path.join(__dirname, 'refresh-claude.py');
  let child;
  try {
    child = spawn('python3', [script, REFRESH_MODEL], {
      env: { ...process.env, COCKPIT_LIMITS_ONLY: '1', COCKPIT_PORT: String(PORT) },
      stdio: 'ignore',
    });
  } catch { refreshing = false; return; }
  const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60000);
  child.on('exit', () => { clearTimeout(to); refreshing = false; });
  child.on('error', () => { clearTimeout(to); refreshing = false; });
}

function walkJsonl(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // subagents/ 里是某对话派出的子 agent 转录（agent-*.jsonl），不是独立会话——
    // 否则一个派 5 个 agent 的对话会被枚举成 6 个会话/圆环。子 agent 只由 countActiveAgents 计数成套圈内圈。
    if (e.isDirectory()) { if (e.name === 'subagents') continue; walkJsonl(p, acc); }
    else if (e.name.endsWith('.jsonl')) { try { acc.push({ p, m: statSync(p).mtimeMs }); } catch {} }
  }
}

function prettyModel(id) {
  if (!id) return 'model';
  if (MODEL_NAMES[id]) return MODEL_NAMES[id];
  const base = id.replace(/\[.*?\]$/, '');
  return MODEL_NAMES[base] || id;
}

// 兜底安全网：末位事件不是 end_turn（即"工作中"），但很久没动 → 仍判空闲，
// 防遗弃/等权限会话常驻"运行中"。设大一点(180s)优先避免作者最反感的"工作时闪空闲"。
const STALE_MS = 180 * 1000;

// 账号套餐（Max/Pro…）：零操作自动读 ~/.claude.json 的 oauthAccount.*RateLimitTier。
// 用正则抽取，避免 JSON.parse 整个大文件；5 分钟缓存（套餐基本不变）。
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
let planCache = null, planAt = 0;
function prettyPlan(tier) {
  if (!tier) return null; const t = String(tier).toLowerCase();
  if (t.includes('max_20x')) return 'Max 20×';
  if (t.includes('max_5x')) return 'Max 5×';
  if (t.includes('max')) return 'Max';
  if (t.includes('team')) return 'Team';
  if (t.includes('enterprise')) return 'Enterprise';
  if (t.includes('pro')) return 'Pro';
  if (t.includes('free')) return 'Free';
  return null;
}
function readClaudePlan() {
  const now = Date.now();
  if (planCache !== null && now - planAt < 300000) return planCache;
  planAt = now;
  try {
    const txt = readFileSync(CLAUDE_JSON, 'utf8');
    const m = txt.match(/"organizationRateLimitTier"\s*:\s*"([^"]+)"/) || txt.match(/"userRateLimitTier"\s*:\s*"([^"]+)"/);
    planCache = prettyPlan(m && m[1]);
  } catch {}
  return planCache;
}

// 统一解析一个 Claude 会话转录。兼容两种格式：
//  · CLI 版：assistant 行带 message.usage，首行带 cwd
//  · 桌面版：事件流(type:user/assistant/ai-title/last-prompt/mode/queue-operation)，assistant 行同样带 message.usage+cwd
// 大文件只尾读（最近活动都在末尾），顺带解决"会话极多时整读"的性能待办。
// 返回 { model, modelId, ctxPct, ctxTokens, ctxLimit, cwd, title, lastTs, state }。
function readClaudeSession(file, mtime) {
  let size = 0; try { size = statSync(file).size; } catch { return null; }
  const TAIL = 262144;                                   // 尾读 256KB
  const big = size > TAIL;
  let text; try { text = readChunk(file, big, big ? TAIL : size); } catch { return null; }
  let lines = text.split('\n');
  if (big) lines = lines.slice(1);                       // 丢弃尾读时可能被截断的首行
  let model = null, usage = null, cwd = null, title = null, lastTs = null, lastKind = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const ty = o.type;
    // 实时状态：取"最后一个有时间戳"的事件（尾随的 last-prompt/ai-title/mode 无 timestamp，自动跳过）
    if (lastKind === null && o.timestamp) {
      lastTs = Date.parse(o.timestamp) || null;
      if (ty === 'assistant') {
        lastKind = (o.message && o.message.stop_reason === 'end_turn') ? 'end' : 'work';   // end_turn=回合结束；tool_use/流式=工作中
      } else if (ty === 'user') {
        const c = o.message && o.message.content;
        const txt = Array.isArray(c) ? c.map((x) => (x && x.type === 'text') ? (x.text || '') : '').join('') : (typeof c === 'string' ? c : '');
        if (/\[Request interrupted/.test(txt)) lastKind = 'stopped';   // 用户按了停止（中断标记）→ 立即空闲
        else { const toolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result'); lastKind = toolResult ? 'work' : 'submit'; }   // tool_result=工具完成继续；纯文本=刚提交→思考
      } else lastKind = 'work';
    }
    if (!title && ty === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!usage && o && o.message && o.message.usage) { usage = o.message.usage; model = o.message.model || model; }
    if (usage && cwd && title && lastKind !== null) break;
  }
  if (!cwd && big) {                                      // 尾读没拿到 cwd（CLI 版在首行）→ 补读首部
    const head = readChunk(file, false, 4096).split('\n');
    for (const ln of head) { try { const o = JSON.parse(ln); if (o.cwd) { cwd = o.cwd; break; } } catch {} }
  }
  if (!usage) return null;
  const tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const limit = tokens > CTX_LIMIT ? Math.max(CTX_LIMIT, 1000000) : CTX_LIMIT;
  const pct = Math.min(100, Math.round((tokens / limit) * 1000) / 10);
  const ts = lastTs || mtime || Date.now();
  const age = Date.now() - ts;
  let state;
  if (lastKind === 'stopped') state = 'idle';                     // 用户中断 → 立即空闲（修"按了停止仍显示思考中"）
  else if (lastKind === 'end') state = age < 8000 ? 'done' : 'idle';   // 回合结束：8s 内"已完成"绿，之后空闲
  else if (age > STALE_MS) state = 'idle';                        // 安全网
  else if (lastKind === 'submit') state = 'thinking';
  else state = 'running';                                         // work(tool_use/tool_result/流式)=执行中
  const thinking = /"type":"thinking"/.test(text);   // 近期有 thinking 块 → 扩展思考开启（零操作自动判）
  return { model: prettyModel(model), modelId: model, ctxPct: pct, ctxTokens: tokens, ctxLimit: limit, cwd, title, lastTs: ts, state, thinking };
}

// 同构 wrapper：产出与 dashboard render() 同构的 statusline 对象（pollTranscripts/claudeView 用）
function buildFromTranscript(file) {
  const r = readClaudeSession(file);
  if (!r) return null;
  return {
    _source: 'transcript', _title: r.title, _state: r.state, _thinking: r.thinking,
    model: { display_name: r.model, id: r.modelId },
    context_window: { used_percentage: r.ctxPct, used_tokens: r.ctxTokens, limit: r.ctxLimit },
    workspace: { current_dir: r.cwd || path.basename(file) },
  };
}

function pollTranscripts() {
  const all = [];
  walkJsonl(PROJECTS, all);
  const acc = all.filter((x) => !ignored.has(x.p));   // 排除后台保鲜会话
  if (!acc.length) return;
  acc.sort((a, b) => b.m - a.m);
  // 选最新的"真实"会话：跳过后台 haiku 保鲜会话（它们 mtime 很新会盖住真实会话）
  let p = null, m = 0, syn = null;
  for (const c of acc) { const s = buildFromTranscript(c.p); if (!s) continue; if (/haiku/i.test((s.model && s.model.id) || '')) continue; p = c.p; m = c.m; syn = s; break; }
  if (!syn) return;
  if (p === tFile && m === tMtime) return;     // 没变化
  tFile = p; tMtime = m;
  // 不要覆盖正在活跃的真实 statusLine 数据
  if (state.source === 'statusline' && state.updatedAt && Date.now() - state.updatedAt < 30000) return;
  state.statusline = syn;
  state.source = 'transcript';
  state.updatedAt = m;
  const mm = extractMetrics(syn);
  state.history.push({ t: m, ctx: mm.ctx, five: mm.five, seven: mm.seven, cost: mm.cost });
  if (state.history.length > 600) state.history.shift();
  broadcast();
}

// ---------- Codex CLI 数据源（~/.codex/sessions rollout）----------
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_MODEL_NAMES = { 'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.1-codex': 'GPT-5.1 Codex', 'gpt-5-codex': 'GPT-5 Codex', 'gpt-5-codex-mini': 'GPT-5 Codex mini' };
let cxFile = null, cxMtime = 0, cxModel = null;

function readCodexAuth() {
  try {
    const j = JSON.parse(readFileSync(path.join(CODEX_DIR, 'auth.json'), 'utf8'));
    if (j.auth_mode === 'apiKey' || j.OPENAI_API_KEY) return 'api';
    if (j.auth_mode) return 'subscription';
  } catch {}
  return 'unknown';
}
function readChunk(file, fromEnd, bytes) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const len = Math.min(bytes, size - start);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { if (fd != null) { try { closeSync(fd); } catch {} } }
}
function walkRollouts(dir, acc) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, acc);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) { try { acc.push({ p, m: statSync(p).mtimeMs }); } catch {} }
  }
}
function codexFindModel(file) {
  const head = readChunk(file, false, 65536);
  for (const ln of head.split('\n')) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o && o.payload;
    if (p && typeof p.model === 'string') return p.model;
    if (o && typeof o.model === 'string') return o.model;
  }
  return null;
}
function codexLastTokenCount(file) {
  const tail = readChunk(file, true, 262144);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const p = o && o.payload;
    if (p && p.type === 'token_count' && p.info) return p;
  }
  return null;
}

// ---------- Codex 回合状态（关键修复）----------
// Codex rollout 用 task_started / task_complete / turn_aborted 包住每个回合，这正好对应
// 作者说的"输入框后面是停止按钮=回合进行中(在工作) / 回车按钮=回合结束(空闲)"，且绝对准确。
// 回合内事件最大间隔实测可达 54s（多为"输出完→思考"），故绝不能再用 mtime 窗口判活动——
// 那会在思考时误判空闲（作者反馈的 bug）。改为读回合生命周期：
//   · 末位生命周期是 task_started（其后无 complete/aborted）→ 回合进行中 → 工作中
//       回合内再看"最后一个活动事件"：reasoning/user_message=思考；输出(agent_message)/工具=执行
//   · task_complete → 8s 内"已完成"绿，之后空闲
//   · turn_aborted / thread_rolled_back（用户中断/回滚）→ 立即空闲
// 安全网：回合进行中但这么久零写入 → 视为进程崩溃/遗弃 → 空闲。设得很宽松，因为回合内合法的事件间隔
// 实测可长达 310s/349s/546s（长 reasoning / 长 exec / MCP 调用），偶有更久——宁可晚判空闲也绝不把"工作中"误判成空闲（作者首要原则）。
const CODEX_STALE_MS = 30 * 60 * 1000;
const CX_THINK = new Set(['reasoning', 'user_message']);                 // 思考类活动
const CX_LIFECYCLE = new Set(['task_started', 'task_complete', 'turn_aborted', 'thread_rolled_back']);
const CX_SKIP = new Set(['token_count', 'turn_context', 'session_meta', 'context_compacted']);   // 不代表"思考/执行"的元事件
function readCodexState(file, mtime) {
  const tail = readChunk(file, true, 262144);
  const lines = tail.split('\n');
  let lifecycle = null, activity = null, lastTs = null, parsedAny = false;
  for (let i = lines.length - 1; i >= 0; i--) {                          // 从尾部往前：第一个命中即最新
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    parsedAny = true;
    const p = o && o.payload; const pt = (p && typeof p === 'object') ? p.type : null;
    if (!pt) continue;
    if (lastTs === null && o.timestamp) { const ts = Date.parse(o.timestamp); if (ts) lastTs = ts; }
    if (lifecycle === null && CX_LIFECYCLE.has(pt)) lifecycle = pt;
    if (activity === null && !CX_LIFECYCLE.has(pt) && !CX_SKIP.has(pt)) activity = CX_THINK.has(pt) ? 'thinking' : 'running';
    if (lifecycle !== null && activity !== null && lastTs !== null) break;
  }
  let size = 0; try { size = statSync(file).size; } catch {}
  let fm = mtime; if (fm == null) { try { fm = statSync(file).mtimeMs; } catch { fm = 0; } }
  // 超大单事件兜底：一条工具输出 >256KB（实测 max 5.5MB，p90>50KB 的事件达 384KB）时，尾部全是这条事件的中段、整段无法解析
  // → lifecycle/activity/lastTs 全 null。此刻文件正被写入(回合进行中)，绝不能判空闲——用文件 mtime 作活跃信号判"执行中"。
  const giantEvent = !parsedAny && size > 262144;
  const ts = lastTs || fm || 0;
  const age = Date.now() - ts;
  let state;
  if (lifecycle === 'task_complete') state = age < 8000 ? 'done' : 'idle';
  else if (lifecycle === 'turn_aborted' || lifecycle === 'thread_rolled_back') state = 'idle';
  else if (age > CODEX_STALE_MS) state = 'idle';                         // 安全网：太久无任何写入（崩溃/遗弃）
  else if (lifecycle === 'task_started') state = activity || 'running';  // 回合进行中（停止按钮）→ 工作中
  else if (activity) state = activity;                                   // 尾部无生命周期但有活动（超长回合，task_started 已滚出尾部）
  else if (giantEvent) state = 'running';                                // 超大事件正在写入 → 执行中
  else state = 'idle';                                                   // 尾部确无信号（新建/空文件）→ 空闲
  return { state, active: state !== 'idle', lastTs: ts };
}
function pollCodex() {
  const acc = [];
  walkRollouts(path.join(CODEX_DIR, 'sessions'), acc);
  if (!acc.length) return;
  acc.sort((a, b) => b.m - a.m);
  const newest = acc[0];
  if (newest.p !== cxFile) { cxFile = newest.p; cxModel = codexFindModel(newest.p); cxMtime = 0; }
  if (newest.m === cxMtime) return;
  cxMtime = newest.m;
  const tc = codexLastTokenCount(newest.p);
  if (!tc) return;
  const info = tc.info || {};
  const last = info.last_token_usage || {};
  const total = info.total_token_usage || {};
  const cw = info.model_context_window || null;
  const cur = last.input_tokens || 0;
  const rl = tc.rate_limits || null;
  let limits = null;
  if (rl && (rl.primary || rl.secondary)) {
    limits = { capturedAt: newest.m, planType: rl.plan_type || null };
    if (rl.primary) limits.five = { used_percentage: rl.primary.used_percent, resets_at: rl.primary.resets_at };
    if (rl.secondary) limits.seven = { used_percentage: rl.secondary.used_percent, resets_at: rl.secondary.resets_at };
  }
  const id = cxModel || 'codex';
  state.codex = {
    available: true,
    model: CODEX_MODEL_NAMES[id] || id, modelId: id,
    ctxPct: cw ? Math.round((cur / cw) * 1000) / 10 : null, ctxTokens: cur, ctxMax: cw,
    tokIn: total.input_tokens != null ? total.input_tokens : null, tokOut: total.output_tokens != null ? total.output_tokens : null,
    limits, account: readCodexAuth(), updatedAt: newest.m,
  };
  broadcast();
}

// ---------- 多 provider 统一视图 ----------
function claudeView() {
  if (!state.statusline && !state.limits) return null;
  return {
    label: 'Claude Code', statusline: state.statusline, limits: state.limits, plan: readClaudePlan(),
    account: state.account || (state.limits ? 'subscription' : 'unknown'),
    source: state.source, lastHook: state.lastHook, updatedAt: state.updatedAt, history: state.history,
  };
}
function codexView() {
  const c = state.codex;
  if (!c || !c.available) return null;
  // 状态每次快照都从 rollout 实时算（每 2s 一次）——这样 done→idle、stale→idle 的"按时间推进"
  // 不依赖文件 mtime 变化，思考时(文件十几秒不写)也不会误判空闲。
  const cs = cxFile ? readCodexState(cxFile, c.updatedAt) : { state: 'idle' };
  return {
    label: 'Codex CLI',
    statusline: {
      _source: 'rollout', _state: cs.state, model: { display_name: c.model, id: c.modelId },
      context_window: { used_percentage: c.ctxPct, used_tokens: c.ctxTokens, context_window_size: c.ctxMax,
        total_input_tokens: c.tokIn, total_output_tokens: c.tokOut },
    },
    limits: c.limits, account: c.account, source: 'rollout', lastHook: null, updatedAt: c.updatedAt, history: [],
  };
}
// ---------- Cursor 数据源（state.vscdb，需 Node 内置 node:sqlite）----------
const CURSOR_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
let cuMtime = 0;
function pollCursor() {
  if (!DatabaseSync) return;
  let m; try { m = statSync(CURSOR_DB).mtimeMs; } catch { return; }
  if (m === cuMtime) return;
  cuMtime = m;
  let db = null;
  try { db = new DatabaseSync(CURSOR_DB, { readOnly: true }); }
  catch { try { db = new DatabaseSync(CURSOR_DB); } catch { return; } }
  try {
    const sub = db.prepare("SELECT value FROM ItemTable WHERE key='cursorAuth/stripeSubscriptionStatus'").get();
    const subStatus = sub ? String(sub.value) : null;
    const cd = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid DESC LIMIT 1").get();
    let model = null;
    if (cd) { try { const j = JSON.parse(cd.value); model = j.modelConfig && j.modelConfig.modelName; } catch {} }
    state.cursor = { available: true, model: model || null, subStatus, updatedAt: m };
  } catch {} finally { try { if (db) db.close(); } catch {} }
  broadcast();
}
function cursorView() {
  const c = state.cursor;
  if (!c || !c.available) return null;
  return {
    label: 'Cursor',
    statusline: { _source: 'cursor', model: { display_name: c.model || 'Cursor', id: c.model || '' }, context_window: null },
    account: 'budget', subStatus: c.subStatus, limits: null, source: 'cursor', lastHook: null, updatedAt: c.updatedAt, history: [],
  };
}

// ---------- Claude Cowork 数据源（独立会话，不并入 Claude Code）----------
// Cowork = Claude 桌面 App 里跑在沙箱 VM 的 Claude Code，数据写在 Application Support 下，每个会话一份元数据
// local_<id>.json（含 title/model/工作目录/最近活动）+ 一个会话目录 local_<id>/（内含 VM 的 .claude/projects 标准转录）。
// 转录格式与普通 Claude Code 完全一致 → 复用 readClaudeSession 算上下文/状态。5h/7d 额度复用账号级 state.limits（同一 Max 账号）。
const COWORK_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
let cwSessions = [];   // 最近的 cowork 会话（buildSessions 填充；coworkView 取最新活动的做大视图源）
function walkCoworkMeta(dir, acc, depth) {
  if ((depth || 0) > 3) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'skills-plugin' || e.name === 'agent') continue;  // 非用户会话子树（agent/ 里是后台 ditto 跑批）
    if (e.isDirectory() && e.name.startsWith('local_')) continue;    // 会话内容目录，别进去
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkCoworkMeta(p, acc, (depth || 0) + 1);
    else if (/^local_(?!ditto_).*\.json$/.test(e.name)) acc.push(p); // 排除 local_ditto_*（后台 agent 跑批，非用户会话）
  }
}
function coworkTranscript(sessDir, cliId) {
  const all = []; walkJsonl(path.join(sessDir, '.claude', 'projects'), all);
  if (!all.length) return null;
  if (cliId) { const hit = all.find((x) => x.p.endsWith(path.sep + cliId + '.jsonl')); if (hit) return hit.p; }
  const main = all.filter((x) => !x.p.includes(path.sep + 'subagents' + path.sep));   // 兜底别把子 agent 转录当主线
  const pick = (main.length ? main : all).sort((a, b) => b.m - a.m);
  return pick[0].p;
}
function listCoworkSessions() {
  const metas = []; walkCoworkMeta(COWORK_DIR, metas, 0);
  const now = Date.now(), out = [];
  for (const mf of metas) {
    let meta; try { meta = JSON.parse(readFileSync(mf, 'utf8')); } catch { continue; }
    if (!meta || !meta.sessionId || meta.isArchived) continue;
    const last = meta.lastActivityAt || 0;
    if (now - last > SESSION_WINDOW_MS) continue;                   // 只读最近一天活动过的转录，省去翻老会话
    const sessDir = mf.replace(/\.json$/, '');
    const tf = coworkTranscript(sessDir, meta.cliSessionId);
    const r = tf ? readClaudeSession(tf) : null;
    const folder = (Array.isArray(meta.userSelectedFolders) && meta.userSelectedFolders[0]) || meta.cwd || null;
    // 上下文窗口按"元数据里的模型"定 1M/200k——转录里的 message.model 不带 [1m] 后缀，只有元数据带，故用它最可靠（与全局 CTX_LIMIT 无关）。
    let ctxLimit = null, ctxPct = null; const ctxTokens = r ? r.ctxTokens : null;
    if (r) { const base = /\[1m\]/i.test(meta.model || '') ? 1000000 : 200000;
      ctxLimit = ctxTokens > base ? Math.max(base, 1000000) : base;
      ctxPct = Math.min(100, Math.round((ctxTokens / ctxLimit) * 1000) / 10); }
    out.push({
      id: 'cowork:' + meta.sessionId, provider: 'cowork',
      label: projName(folder), cwd: folder, title: meta.title || (r && r.title) || null,
      model: r ? r.model : prettyModel(meta.model), modelId: (r && r.modelId) || meta.model,
      ctx: ctxPct, ctxTokens, ctxLimit,
      cost: null, updatedAt: (r && r.lastTs) || last, state: r ? r.state : 'idle',
      thinking: r ? r.thinking : false, active: r ? r.state !== 'idle' : false,
      agents: (r && r.state !== 'idle' && tf) ? countActiveAgents(tf) : 0,
    });
  }
  return out;
}
function coworkView() {
  const arr = cwSessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const s = arr.find((x) => x.active) || arr[0];
  if (!s) return null;
  return {
    label: 'Claude Cowork',
    statusline: { _source: 'cowork', _state: s.state, _title: s.title, _thinking: s.thinking,
      model: { display_name: s.model, id: s.modelId },
      context_window: { used_percentage: s.ctx, used_tokens: s.ctxTokens, limit: s.ctxLimit },
      workspace: { current_dir: s.cwd || s.label } },
    limits: state.limits, plan: readClaudePlan(),                  // 同一 Max 账号 → 复用账号级 5h/7d
    account: state.limits ? 'subscription' : 'unknown',
    source: 'cowork', lastHook: null, updatedAt: s.updatedAt, history: [],
  };
}

// ---------- 子 agent 计数（同一对话派出的多个 agent → 套圈）----------
// Claude Code 把每个子 agent（Task 工具 / workflow）写到 <会话>/subagents/**/agent-*.jsonl。
// 同一对话同时有几个 agent 在干活，就在该对话的光环里套几个内圈；某个 agent 干完(转录停写) → 它的圈消失、其余顶上。
const AGENT_ACTIVE_MS = 30 * 1000;   // 子 agent 转录这么久没写 → 视为已完成（其内圈消失）
function walkAgents(dir, acc) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAgents(p, acc);
    else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) { try { acc.push(statSync(p).mtimeMs); } catch {} }
  }
}
function countActiveAgents(sessionFile) {
  const dir = sessionFile.replace(/\.jsonl$/, '') + path.sep + 'subagents';
  const mtimes = []; walkAgents(dir, mtimes);
  const now = Date.now(); let n = 0;
  for (const m of mtimes) if (now - m < AGENT_ACTIVE_MS) n++;
  return n;
}

// ---------- 多会话枚举（监控墙）：最近活跃的所有 Claude/Codex 会话 ----------
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;   // 回退池：最近一天有活动的会话
function projName(d) { if (!d) return 'session'; const ps = String(d).split('/').filter(Boolean); return ps[ps.length - 1] || 'session'; }
function buildSessions() {
  const out = [], now = Date.now();
  const cl = []; walkJsonl(PROJECTS, cl);
  const clSel = cl.filter((x) => !ignored.has(x.p) && now - x.m <= SESSION_WINDOW_MS).sort((a, b) => b.m - a.m).slice(0, 6);
  for (const { p, m } of clSel) {
    const r = readClaudeSession(p, m); if (!r) continue;
    if (r.modelId && /haiku/i.test(r.modelId)) continue;   // 排除后台额度保鲜（haiku）会话，不污染监控墙
    out.push({ id: 'claude:' + p, provider: 'claude',
      label: projName(r.cwd), title: r.title || null, model: r.model, modelId: r.modelId,
      ctx: r.ctxPct, ctxTokens: r.ctxTokens, ctxLimit: r.ctxLimit,
      cost: null, updatedAt: r.lastTs || m, state: r.state, thinking: r.thinking, active: r.state !== 'idle',   // 事件流状态：active=非空闲（end_turn 即时退出）
      agents: r.state !== 'idle' ? countActiveAgents(p) : 0 });   // 该对话当前在干活的子 agent 数 → 套几个内圈
  }
  const cx = []; walkRollouts(path.join(CODEX_DIR, 'sessions'), cx);
  const cxSel = cx.filter((x) => now - x.m <= SESSION_WINDOW_MS).sort((a, b) => b.m - a.m).slice(0, 4);
  for (const { p, m } of cxSel) {
    const tc = codexLastTokenCount(p); if (!tc) continue;
    const info = tc.info || {}, lastU = info.last_token_usage || {}, cw = info.model_context_window || null, cur = lastU.input_tokens || 0;
    const id = codexFindModel(p) || 'codex';
    const cs = readCodexState(p, m);   // 回合生命周期判状态（task_started 未完=工作中；reasoning=思考/输出=执行；complete=空闲），修"思考时误判空闲"
    out.push({ id: 'codex:' + p, provider: 'codex', label: 'Codex', title: null, model: CODEX_MODEL_NAMES[id] || id, modelId: id,
      ctx: cw ? Math.round((cur / cw) * 1000) / 10 : null, ctxTokens: cur, ctxLimit: cw, cost: null, updatedAt: m, state: cs.state, active: cs.active });
  }
  cwSessions = listCoworkSessions();   // Claude Cowork 会话（独立 provider，不并入 Claude Code）
  for (const s of cwSessions) out.push(s);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function snapshot() {
  const sources = {};
  const cl = claudeView(); if (cl) sources.claude = cl;
  const cx = codexView(); if (cx) sources.codex = cx;
  const cw = coworkView(); if (cw) sources.cowork = cw;
  const cu = cursorView(); if (cu) sources.cursor = cu;
  const preview = (state.preview && Date.now() < state.preview.until) ? { state: state.preview.state } : null;
  return { sources, sessions: state.sessions, serverNow: Date.now(), config: state.config, lan: lanIps().map((ip) => 'http://' + ip + ':' + PORT), preview };
}

function broadcast() {
  const frame = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch {} }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS: 让官方桌面客户端(不同 origin)能读状态(/events)并下发设置(/config、/refresh)。
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
    res.end();
    return;
  }

  // 静态资源：PWA manifest、SVG 图标、主屏图标 PNG（iOS 添加到主屏幕需 PNG 才可靠）、常亮兜底视频
  if (req.method === 'GET' && (url.pathname === '/manifest.webmanifest' || /^\/icon[\w-]*\.(svg|png)$/.test(url.pathname) || /^\/nosleep\.(mp4|webm)$/.test(url.pathname))) {
    const ext = url.pathname.split('.').pop();
    const CT = { manifest: 'application/manifest+json; charset=utf-8', png: 'image/png', svg: 'image/svg+xml; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm' };
    const ctype = url.pathname === '/manifest.webmanifest' ? CT.manifest : (CT[ext] || 'application/octet-stream');
    try {
      const buf = await readFile(path.join(__dirname, url.pathname.slice(1)));
      res.writeHead(200, { 'content-type': ctype, 'cache-control': 'public, max-age=86400' });
      res.end(buf);
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = await readFile(path.join(__dirname, 'dashboard.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('dashboard.html missing');
    }
    return;
  }

  // 电脑端控制台（设置 + 数据源诊断都在这里；手机端只全屏显示）
  if (req.method === 'GET' && (url.pathname === '/control' || url.pathname === '/settings')) {
    try {
      const html = await readFile(path.join(__dirname, 'control.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(500); res.end('control.html missing'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest') {
    const body = await readBody(req);
    try {
      const json = JSON.parse(body || '{}');
      // 后台额度保鲜用 haiku 起会话：其 statusLine 即便漏配 limitsOnly，也绝不污染前台显示。
      // 凡 ingest 模型属保鲜模型(haiku) → 一律只取额度、忽略其转录（作者：保鲜绝不污染显示）。
      const inModel = json && json.model ? (json.model.id || json.model.display_name || '') : '';
      if (url.searchParams.get('limitsOnly') || /haiku/i.test(inModel)) {
        captureLimits(json);
        if (json.transcript_path) ignored.add(json.transcript_path);
        broadcast();
        res.writeHead(204); res.end();
        return;
      }
      state.statusline = json;
      state.source = 'statusline';
      state.updatedAt = Date.now();
      const hadLimits = captureLimits(json);   // 订阅额度：拿到就持久保留
      // 自适应账号判定：见过 rate_limits → 订阅；否则有花费 → API（订阅永不降级）
      if (!hadLimits && state.account !== 'subscription' && json.cost && json.cost.total_cost_usd != null) state.account = 'api';
      try { writeFileSync(path.join(DATA, 'latest-claude.json'), JSON.stringify(json)); } catch {}
      const m = extractMetrics(json);
      state.history.push({ t: state.updatedAt, ctx: m.ctx, five: m.five, seven: m.seven, cost: m.cost });
      if (state.history.length > 600) state.history.shift();
      broadcast();
      res.writeHead(204); res.end();
    } catch {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest-hook') {
    const body = await readBody(req);
    try {
      const json = JSON.parse(body || '{}');
      state.lastHook = { event: json.event || 'unknown', payload: json.payload || {}, ts: Date.now() };
      broadcast();
      res.writeHead(204); res.end();
    } catch {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // 电脑端控制台改设置 → 持久化 + 通过 SSE 实时下发给手机
  if (req.method === 'POST' && url.pathname === '/config') {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body || '{}');
      for (const k of ['theme', 'lang', 'provider']) if (k in j) state.config[k] = j[k];
      // pet: only the built-in idle companion on/off (custom art is a client-side window.AWAITLIGHT_PET hook)
      if ('pet' in j) state.config.pet = j.pet === 'off' ? 'off' : 'default';
      if ('hidden' in j && Array.isArray(j.hidden)) state.config.hidden = j.hidden;
      persistConfig();
      // 设置预览效果：客户端改设置时，让手机&客户端同步"演示"某个状态几秒(改桌宠→idle看桌宠/改主题→active看光环)，到点自动回真实状态。
      if (j.preview && typeof j.preview === 'object' && j.preview.state) {
        const ms = Math.min(10000, Math.max(500, Number(j.preview.ms) || 3500));
        state.preview = { state: String(j.preview.state), until: Date.now() + ms };
        if (state._previewTimer) clearTimeout(state._previewTimer);
        state._previewTimer = setTimeout(() => { state.preview = null; broadcast(); }, ms);
      }
      broadcast();
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end('bad json'); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/refresh') {
    refreshLimits('manual');
    res.writeHead(202); res.end('refreshing');
    return;
  }

  res.writeHead(404); res.end('not found');
});

function lanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

loadLimits();   // 启动时恢复上次拿到的 5h/7d（重启不丢）
loadConfig();   // 恢复电脑端控制台的设置（主题/语言/显示哪个 provider）

server.listen(PORT, () => {
  const bridge = path.join(__dirname, 'statusline-bridge.mjs');
  const ips = lanIps();
  const line = '─'.repeat(58);
  console.log(line);
  console.log('  AI Cockpit 本地服务已启动');
  console.log(line);
  console.log('  手机浏览器打开（与电脑同一 Wi-Fi）：');
  if (ips.length === 0) console.log('    http://<本机IP>:' + PORT + '   (未检测到局域网 IP)');
  for (const ip of ips) console.log('    http://' + ip + ':' + PORT);
  console.log('  本机预览： http://127.0.0.1:' + PORT);
  console.log(line);
  console.log('  ⚙ 电脑端控制台（在这台电脑上打开，调主题 / 选 AI / 看数据源）：');
  console.log('    http://127.0.0.1:' + PORT + '/control');
  console.log('  手机端只全屏显示画面，所有设置在控制台改，实时同步到手机。');
  console.log(line);
  console.log('  把下面这段贴进 ~/.claude/settings.json，让 Claude Code 喂数据：');
  console.log('');
  console.log('  "statusLine": {');
  console.log('    "type": "command",');
  console.log('    "command": "node \\"' + bridge + '\\""');
  console.log('  }');
  console.log('');
  console.log('  配好后在 Claude Code 里发一条消息触发渲染，网页右下角');
  console.log('  “数据诊断”会显示 rate_limits 是否真的拿到了（命门测试）。');
  console.log(line);
  console.log('  另：已自动读取 ~/.claude/projects 会话转录作数据源——');
  console.log('  即使不配 statusLine，模型/上下文占用也会自动显示。');
  console.log(line);

  // 启动会话转录轮询（零配置数据源）
  pollTranscripts();
  setInterval(pollTranscripts, 1200);

  // 多会话监控墙：每 2s 枚举最近活跃的所有会话并推送
  state.sessions = buildSessions();
  setInterval(() => { state.sessions = buildSessions(); broadcast(); }, 2000);

  // 启动 Codex CLI 轮询（~/.codex/sessions rollout）
  pollCodex();
  setInterval(pollCodex, 3000);

  // 启动 Cursor 轮询（state.vscdb）
  pollCursor();
  setInterval(pollCursor, 4000);

  // 后台额度保鲜：启动 20s 后先刷一次，之后每 REFRESH_MIN 分钟一次（零操作保持最新）
  console.log('  后台额度保鲜：每 ' + REFRESH_MIN + ' 分钟用 ' + REFRESH_MODEL + ' 静默刷新 5h/7d，几乎不耗额度。');
  console.log(line);
  setTimeout(() => refreshLimits('startup'), 20000);
  setInterval(() => refreshLimits('interval'), REFRESH_MIN * 60000);
});
