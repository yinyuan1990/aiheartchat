<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';

type Mode = 'raw' | 'light' | 'ai';
interface Settings { enabled: boolean; platforms: string[]; dailyMax: number; hourStart: number; hourEnd: number; gapMin: number; queueDays: number; token: string; lastPostId: string; modes: Record<string, Mode>; dailyMaxes: Record<string, number>; formats: Record<string, 'note' | 'video'> }
interface Agent { online: boolean; lastSeen: string; host: string; accounts: Record<string, { ok: boolean; msg: string; checkedAt: string }>; ip: { ok: boolean; ip: string; where: string; msg: string } | null }
interface PlatformInfo { key: string; name: string; overseas: boolean; english: boolean; fixedFormat: 'note' | 'video' | null }
interface Overview { settings: Settings; agents: Agent[]; counts: Record<string, number>; platforms: PlatformInfo[] }
interface Job {
  id: string; postId: string; platform: string; platformName: string; title: string; content: string; tags: string; status: number;
  scheduledAt: string; claimedAt: string | null; doneAt: string | null; attempts: number; error: string; resultUrl: string; createdAt: string; source: string;
  format: 'note' | 'video' | 'pics'; media: string;
}
function mediaImages(j: Job): string[] {
  if ((j.format !== 'video' && j.format !== 'pics') || !j.media) return [];
  try { return JSON.parse(j.media).images ?? []; } catch { return []; }
}
const FORMAT_NAME: Record<string, string> = { note: '图文', video: '视频', pics: '纯图' };

/** 任务文案切换：原文 / AI 浅处理 / AI 改写，预览后「用这个」写回任务（视频会重新出图） */
const draft = ref<{ jobId: string; mode: Mode; loading: boolean; title: string; content: string; tags: string[]; error: string } | null>(null);
function modesFor(j: Job): { k: Mode; name: string }[] {
  const english = ov.value?.platforms.find((p) => p.key === j.platform)?.english;
  return english
    ? [{ k: 'raw', name: '忠实翻译' }, { k: 'ai', name: '英文改写' }]
    : [{ k: 'raw', name: '原文' }, { k: 'light', name: 'AI 浅处理' }, { k: 'ai', name: 'AI 改写' }];
}
async function loadDraft(j: Job, mode: Mode) {
  draft.value = { jobId: j.id, mode, loading: true, title: '', content: '', tags: [], error: '' };
  try {
    const r = await api<{ title: string; content: string; tags: string[] }>(`/admin/publish/jobs/${j.id}/draft?mode=${mode}`);
    if (draft.value?.jobId === j.id && draft.value.mode === mode) Object.assign(draft.value, { ...r, loading: false });
  } catch (e: any) {
    if (draft.value?.jobId === j.id) Object.assign(draft.value, { loading: false, error: e.message });
  }
}
async function applyDraft(j: Job) {
  const d = draft.value;
  if (!d || d.jobId !== j.id || d.loading || d.error) return;
  const hint = j.format === 'video' ? '\n视频任务：已出的配图会作废，按新文案重新生成（每张 0.2 元）。' : '';
  if (!confirm(`把这版文案设为任务 #${j.id} 最终发出去的文字？${hint}`)) return;
  try {
    const r = await api<{ resetMedia: boolean }>(`/admin/publish/jobs/${j.id}/draft`, { method: 'POST', body: { mode: d.mode } });
    show(r.resetMedia ? '已应用，配图会按新文案重新生成（排到 6 小时内自动出）' : '已应用为发布文案');
    draft.value = null;
    loadJobs();
  } catch (e: any) { show(e.message); }
}

interface XPicsSettings { enabled: boolean; channel: string; daily: number; min: number; max: number; fetchHour: number; lastFetch: string; lastResult: string }
interface XPicsStatus { settings: XPicsSettings; pool: number; unchecked: number; rejected: number; rejectedSamples: { url: string; reason: string }[]; busy: boolean; samples: string[]; today: { id: string; status: number; scheduledAt: string; manual: boolean; resultUrl: string; error: string }[] }
const xp = ref<XPicsStatus | null>(null);
const xpForm = ref({ enabled: false, channel: '', daily: 5, min: 2, max: 4, fetchHour: 0 });
async function loadXPics(fillForm = false) {
  try {
    xp.value = await api<XPicsStatus>('/admin/xpics');
    const s = xp.value.settings;
    if (fillForm) xpForm.value = { enabled: s.enabled, channel: s.channel, daily: s.daily, min: s.min, max: s.max, fetchHour: s.fetchHour };
  } catch (e: any) { show(e.message); }
}
async function saveXPics() {
  try {
    xp.value = await api<XPicsStatus>('/admin/xpics/settings', { method: 'PUT', body: xpForm.value });
    show('已保存');
  } catch (e: any) { show(e.message); }
}
async function fetchXPics() {
  try {
    await api('/admin/xpics/fetch', { method: 'POST' });
    show('开始拉取最近 24 小时的图，稍等一两分钟刷新');
    setTimeout(() => loadXPics(), 3000);
  } catch (e: any) { show(e.message); }
}
async function postXPicsNow() {
  try {
    const r = await api<{ id: string; images: number }>('/admin/xpics/post-now', { method: 'POST' });
    show(`已排任务 #${r.id}（${r.images} 张），发布机一两分钟内会发`);
    loadXPics(); loadJobs();
  } catch (e: any) { show(e.message); }
}
function lastResult(s?: XPicsSettings) {
  if (!s?.lastResult) return '还没拉过';
  const [t, msg] = s.lastResult.split('|');
  return `${fmt(t)} ${msg}`;
}

const ov = ref<Overview | null>(null);
const form = ref<{ enabled: boolean; platforms: string[]; hourStart: number; hourEnd: number; gapMin: number; queueDays: number; modes: Record<string, Mode>; dailyMaxes: Record<string, number>; formats: Record<string, 'note' | 'video'> }>({ enabled: false, platforms: [], hourStart: 9, hourEnd: 23, gapMin: 45, queueDays: 1, modes: {}, dailyMaxes: {}, formats: {} });
const jobs = ref<Job[]>([]);
const JOB_SIZE = 20;
const jobPage = ref(1);
const jobTotal = ref(0);
const filterStatus = ref('');
const filterPlatform = ref('');
const toast = ref('');
const testing = ref(false);
const testPlatforms = ref<string[]>([]);
const expanded = ref<string | null>(null);
const showToken = ref(false);
let timer: number | undefined;

const STATUS: Record<number, { text: string; cls: string }> = {
  0: { text: '待发', cls: '' }, 1: { text: '发布中', cls: 'ok' }, 2: { text: '成功', cls: 'ok' }, 3: { text: '失败', cls: 'off' }, 4: { text: '跳过', cls: 'off' },
};

function show(t: string) { toast.value = t; setTimeout(() => (toast.value = ''), 2600); }
function fmt(t?: string | null) {
  if (!t) return '—';
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function loadOverview(fillForm = false) {
  try {
    ov.value = await api<Overview>('/admin/publish/overview');
    const s = ov.value.settings;
    if (fillForm) form.value = { enabled: s.enabled, platforms: [...s.platforms], hourStart: s.hourStart, hourEnd: s.hourEnd, gapMin: s.gapMin, queueDays: s.queueDays ?? 1, modes: { ...(s.modes ?? {}) }, dailyMaxes: { ...(s.dailyMaxes ?? {}) }, formats: { ...(s.formats ?? {}) } };
    if (!testPlatforms.value.length) testPlatforms.value = [...s.platforms];
  } catch (e: any) { show(e.message); }
}
async function loadJobs() {
  const q = new URLSearchParams();
  if (filterStatus.value !== '') q.set('status', filterStatus.value);
  if (filterPlatform.value) q.set('platform', filterPlatform.value);
  q.set('page', String(jobPage.value));
  q.set('size', String(JOB_SIZE));
  const r = await api<{ total: number; list: Job[] }>(`/admin/publish/jobs?${q.toString()}`);
  jobs.value = r.list;
  jobTotal.value = r.total;
  // 删掉最后一页的最后一条后，页码退回有数据的那页
  if (!r.list.length && jobPage.value > 1) { jobPage.value = Math.max(1, Math.ceil(r.total / JOB_SIZE)); await loadJobs(); }
}
function reloadJobs() { jobPage.value = 1; loadJobs(); }
async function save() {
  try {
    ov.value = await api<Overview>('/admin/publish/settings', { method: 'PUT', body: form.value });
    show(form.value.enabled ? '已保存。已开启：之后同步进来的新树洞帖会自动分发（旧帖不发）' : '已保存，分发已关闭');
  } catch (e: any) { show(e.message); }
}
async function rotate() {
  if (!confirm('更换 token 后本机发布机要重新配置（publisher/config.json）。确定？')) return;
  ov.value = await api<Overview>('/admin/publish/token/rotate', { method: 'POST' });
  show('token 已更换');
}
async function copyToken() {
  if (!ov.value) return;
  await navigator.clipboard.writeText(ov.value.settings.token).catch(() => {});
  show('已复制');
}
async function testPublish() {
  if (!testPlatforms.value.length) return show('先勾选平台');
  if (!confirm(`用最近一条树洞帖，立刻给 ${testPlatforms.value.length} 个平台各排一条任务（发布机在线会马上发）。确定？`)) return;
  testing.value = true;
  try {
    const r = await api<{ postId: string; jobs: { platform: string; title: string }[] }>('/admin/publish/test', { method: 'POST', body: { platforms: testPlatforms.value } });
    show(`已排 ${r.jobs.length} 条（帖子 #${r.postId}），看下面列表`);
    filterStatus.value = '';
    jobPage.value = 1;
    await loadJobs();
  } catch (e: any) { show(e.message); } finally { testing.value = false; }
}
async function retry(j: Job) { await api(`/admin/publish/jobs/${j.id}/retry`, { method: 'POST' }); show('已重排，马上重发'); loadJobs(); }
async function skip(j: Job) { await api(`/admin/publish/jobs/${j.id}/skip`, { method: 'POST' }); loadJobs(); }
async function remove(j: Job) { if (!confirm('删除这条任务记录？')) return; await api(`/admin/publish/jobs/${j.id}`, { method: 'DELETE' }); loadJobs(); }
function toggle(list: string[], key: string) {
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.push(key);
}
onMounted(() => {
  loadOverview(true); loadJobs(); loadXPics(true);
  timer = window.setInterval(() => { loadOverview(); loadJobs(); loadXPics(); }, 15000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div>
    <div class="page-title">内容分发（推广）</div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">规则</div>
      <div class="muted" style="margin-bottom: 12px">
        私密树洞里 <b>Telegram 同步进来的每一条新帖</b>，按各平台的文案模式（原文直发 / AI 改写，见下方）出稿，渲染成卡片图，由你本机的发布机以真实浏览器发到下面勾选的平台。<b>不挑不审</b>；超过每日上限的顺延，最多往后排「当天满了最多往后排 N 天」，再排不进的跳过（任务列表里记为「跳过」），所以每日条数少的平台队列不会越积越多。开启时以当前最新一条为起点，之前的旧帖不发。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center">
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="form.enabled" type="checkbox" style="width: auto" /> <b :style="{ color: form.enabled ? 'var(--accent)' : '' }">{{ form.enabled ? '已开启' : '已关闭' }}</b></label>
        <span class="muted">平台：</span>
        <label v-for="p in ov?.platforms ?? []" :key="p.key" class="muted" style="display: flex; align-items: center; gap: 4px">
          <input type="checkbox" style="width: auto" :checked="form.platforms.includes(p.key)" @change="toggle(form.platforms, p.key)" /> {{ p.name }}
        </label>
        <label class="muted">时段 <input v-model.number="form.hourStart" type="number" min="0" max="23" style="width: 50px" /> ~ <input v-model.number="form.hourEnd" type="number" min="1" max="24" style="width: 50px" /> 点</label>
        <label class="muted">同平台间隔 ≥ <input v-model.number="form.gapMin" type="number" min="0" max="600" style="width: 56px" /> 分钟</label>
        <label class="muted" title="每天新帖比某平台的每日条数多时，多出来的最多往后排几天，再排不下就跳过，队列不会越积越多">当天满了最多往后排 <input v-model.number="form.queueDays" type="number" min="0" max="7" style="width: 44px" /> 天（0 = 只排当天）</label>
        <button class="small" @click="save">保存</button>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line)">
        <span class="muted">各平台：</span>
        <label v-for="p in ov?.platforms ?? []" :key="p.key" class="muted" style="display: flex; align-items: center; gap: 4px">
          {{ p.name }}<span v-if="p.overseas" style="font-size: 11px">（外网{{ p.english ? '·英文' : '·中文' }}）</span>
          <select v-model="form.modes[p.key]" style="width: auto">
            <option value="raw">{{ p.english ? '忠实翻译' : '原文直发' }}</option>
            <option v-if="!p.english" value="light">AI 浅处理</option>
            <option value="ai">{{ p.english ? '英文改写' : 'AI 改写' }}</option>
          </select>
          <span v-if="p.fixedFormat">{{ p.fixedFormat === 'video' ? '视频' : '图文' }}</span>
          <select v-else v-model="form.formats[p.key]" style="width: auto">
            <option value="note">图文</option>
            <option value="video">视频</option>
          </select>
          每天 <input v-model.number="form.dailyMaxes[p.key]" type="number" min="1" max="50" style="width: 50px" /> 条
        </label>
        <div class="muted" style="font-size: 12px; width: 100%">
          <b>原文直发</b>：一个字不改、不过滤，标题取第一句按平台截长度；<b>AI 浅处理</b>：同原文直发，只把明显的性器官词换成拼音首字母（如 鸡巴→JB、阴道→YD）；<b>AI 改写</b>：按平台出标题 / 正文 / 话题，敏感词软化、去引流词。
          <b>视频</b>：文案切成 4~7 段旁白，万相 2.7 组图每段出一张剧照（0.2 元/张，同一帖子多个视频平台共用一组图），发布机合成配音字幕视频再发；任务排到 6 小时内才出图。改了点上面「保存」，只影响之后新入队的任务（含测试发布）。
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div style="font-weight: 600; margin-bottom: 6px">发布机（国内一台发国内平台，出口在国外的一台发 X / YouTube）</div>
      <div v-if="ov && !ov.agents.length" class="muted">还没有发布机上线</div>
      <div v-for="a in ov?.agents ?? []" :key="a.host" class="row" style="flex-wrap: wrap; gap: 14px; align-items: center; font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--line)">
        <b>{{ a.host }}</b>
        <span class="tag" :class="a.online ? 'ok' : 'off'">{{ a.online ? '在线' : '离线' }}</span>
        <span class="muted">上次心跳 {{ fmt(a.lastSeen) }}</span>
        <span v-if="a.ip" :title="a.ip.msg">出口 <span class="tag ok">{{ a.ip.ok ? '国内 → 发国内平台' : '国外 → 发外网平台' }}</span> <span class="muted">{{ a.ip.ip }} {{ a.ip.where }}</span></span>
        <template v-for="p in ov?.platforms ?? []" :key="p.key">
          <span v-if="a.accounts[p.key]" :title="a.accounts[p.key].msg">
            {{ p.name }} <span class="tag" :class="a.accounts[p.key].ok ? 'ok' : 'off'">{{ a.accounts[p.key].ok ? '已登录' : '未登录 / 失效' }}</span>
          </span>
        </template>
      </div>
      <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.7">
        发布机 token：<code style="user-select: all">{{ showToken ? ov?.settings.token : '••••••••••••' }}</code>
        <button class="small ghost" style="margin-left: 6px" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
        <button class="small ghost" @click="copyToken">复制</button>
        <button class="small ghost" @click="rotate">更换</button>
        <br />离线时任务只排队不发，发布机上线后按排期补发。某平台显示「未登录 / 失效」时，在本机 `publisher` 目录跑 <code>python publisher.py login 平台</code> 重新扫码。
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div style="font-weight: 600; margin-bottom: 6px">X 美女图（Telegram 频道 → X 纯图帖，只发 X）</div>
      <div class="muted" style="margin-bottom: 12px">
        每天 <b>{{ xpForm.fetchHour }} 点</b>用后台登录的 Telegram 账号拉来源频道<b>最近 24 小时</b>的图片，存到服务器 MinIO（<code>xpics/日期/</code>）进图片池；
        按每天次数在上面的发布时段（{{ form.hourStart }}~{{ form.hourEnd }} 点）里平均排开，每次从池子取几张（同一相册的放一起），<b>正文不带文字</b>，由外网发布机发到 X，发完自动回复一条 USDC 代币链接。不占上面 X 的每日条数。X 一条最多 4 张图。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center">
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="xpForm.enabled" type="checkbox" style="width: auto" /> <b :style="{ color: xpForm.enabled ? 'var(--accent)' : '' }">{{ xpForm.enabled ? '已开启' : '已关闭' }}</b></label>
        <label class="muted">来源频道 t.me/<input v-model="xpForm.channel" style="width: 140px" /></label>
        <label class="muted">每天 <input v-model.number="xpForm.daily" type="number" min="1" max="20" style="width: 50px" /> 次</label>
        <label class="muted">每次 <input v-model.number="xpForm.min" type="number" min="1" max="4" style="width: 44px" /> ~ <input v-model.number="xpForm.max" type="number" min="1" max="4" style="width: 44px" /> 张</label>
        <label class="muted">每天 <input v-model.number="xpForm.fetchHour" type="number" min="0" max="23" style="width: 50px" /> 点拉取</label>
        <button class="small" @click="saveXPics">保存</button>
        <button class="small ghost" :disabled="xp?.busy" @click="fetchXPics">{{ xp?.busy ? '拉取中…' : '立即获取' }}</button>
        <button class="small ghost" @click="postXPicsNow">立即发一条</button>
      </div>
      <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.8">
        图片池可用 <b>{{ xp?.pool ?? 0 }}</b> 张 · 待检查 {{ xp?.unchecked ?? 0 }} · 已过滤 {{ xp?.rejected ?? 0 }}（截图 / 拼图 / 带文字水印 / 非真人女性 / 疑似未成年 / 露点，通义千问看图自动筛）· 最近拉取：{{ lastResult(xp?.settings) }}<br />
        今天：
        <template v-if="xp?.today.length">
          <span v-for="t in xp.today" :key="t.id" style="margin-right: 10px">
            {{ fmt(t.scheduledAt) }}<span v-if="t.manual">（手动）</span>
            <span class="tag" :class="STATUS[t.status]?.cls">{{ STATUS[t.status]?.text }}</span>
            <a v-if="t.resultUrl" :href="t.resultUrl" target="_blank" style="color: var(--accent)">查看</a>
          </span>
        </template>
        <span v-else>还没排</span>
      </div>
      <div v-if="xp?.samples.length" style="display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap">
        <a v-for="(u, k) in xp.samples" :key="k" :href="u" target="_blank"><img :src="u" style="width: 56px; height: 56px; object-fit: cover; border-radius: 4px" /></a>
      </div>
      <div v-if="xp?.rejectedSamples.length" class="muted" style="font-size: 12px; margin-top: 8px">最近被过滤的：</div>
      <div v-if="xp?.rejectedSamples.length" style="display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap">
        <a v-for="(r, k) in xp.rejectedSamples" :key="k" :href="r.url" target="_blank" :title="r.reason" style="text-align: center; font-size: 11px; color: var(--muted, #888); width: 56px">
          <img :src="r.url" style="width: 56px; height: 56px; object-fit: cover; border-radius: 4px; opacity: 0.6" /><br />{{ r.reason }}
        </a>
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div style="font-weight: 600; margin-bottom: 6px">测试发布</div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <span class="muted">用最近一条树洞帖，立刻发到：</span>
        <label v-for="p in ov?.platforms ?? []" :key="p.key" class="muted" style="display: flex; align-items: center; gap: 4px">
          <input type="checkbox" style="width: auto" :checked="testPlatforms.includes(p.key)" @change="toggle(testPlatforms, p.key)" /> {{ p.name }}
        </label>
        <button class="small" :disabled="testing" @click="testPublish">{{ testing ? '出稿中…' : '立刻测试一条' }}</button>
        <span class="muted" style="font-size: 12px">不受上限 / 时段限制；发布机在线的话一两分钟内会发出去，结果在下面看</span>
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div class="row" style="gap: 12px; align-items: center; margin-bottom: 8px">
        <div style="font-weight: 600">任务</div>
        <span v-if="ov" class="muted" style="font-size: 12px">待发 {{ ov.counts[0] ?? 0 }} · 发布中 {{ ov.counts[1] ?? 0 }} · 成功 {{ ov.counts[2] ?? 0 }} · 失败 {{ ov.counts[3] ?? 0 }} · 跳过 {{ ov.counts[4] ?? 0 }}</span>
        <select v-model="filterStatus" style="width: auto" @change="reloadJobs">
          <option value="">全部状态</option><option value="0">待发</option><option value="1">发布中</option><option value="2">成功</option><option value="3">失败</option><option value="4">跳过</option>
        </select>
        <select v-model="filterPlatform" style="width: auto" @change="reloadJobs">
          <option value="">全部平台</option><option v-for="p in ov?.platforms ?? []" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select>
        <button class="small ghost" @click="loadJobs">刷新</button>
        <span style="flex: 1" />
        <span class="muted">{{ jobTotal }} 条</span>
        <button class="small ghost" :disabled="jobPage <= 1" @click="jobPage--; loadJobs()">上一页</button>
        <span class="muted">{{ jobPage }} / {{ Math.max(1, Math.ceil(jobTotal / JOB_SIZE)) }}</span>
        <button class="small ghost" :disabled="jobPage * JOB_SIZE >= jobTotal" @click="jobPage++; loadJobs()">下一页</button>
      </div>
      <table v-if="jobs.length">
        <thead><tr><th>#</th><th>平台</th><th>标题 / 文案</th><th>状态</th><th>排期</th><th>完成</th><th>结果 / 错误</th><th>操作</th></tr></thead>
        <tbody>
          <template v-for="j in jobs" :key="j.id">
            <tr>
              <td class="muted">{{ j.id }}<br /><span style="font-size: 11px">{{ j.format === 'pics' ? '美女图' : `帖 #${j.postId}` }}</span></td>
              <td>{{ j.platformName }}<br /><span class="muted" style="font-size: 11px">{{ FORMAT_NAME[j.format] ?? j.format }}</span></td>
              <td style="max-width: 360px; cursor: pointer" @click="expanded = expanded === j.id ? null : j.id">
                <div style="font-weight: 600">{{ j.title || (j.format === 'pics' ? '（纯图，无文字）' : '（无标题）') }}</div>
                <div class="muted" style="font-size: 12px; white-space: pre-wrap" :style="expanded === j.id ? {} : { overflow: 'hidden', maxHeight: '36px' }">{{ j.content }}</div>
                <div v-if="j.tags" class="muted" style="font-size: 11px">#{{ j.tags.split(',').join(' #') }}</div>
                <div v-if="j.format === 'video' && !j.media && j.status === 0" class="muted" style="font-size: 11px; color: var(--accent)">等待出图（排到 6 小时内自动出，一组约 1~3 分钟）</div>
                <div v-if="mediaImages(j).length" style="display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap" @click.stop>
                  <a v-for="(u, k) in mediaImages(j)" :key="k" :href="u" target="_blank"><img :src="u" style="width: 42px; height: 75px; object-fit: cover; border-radius: 4px" /></a>
                </div>
                <div v-if="expanded === j.id" class="muted" style="font-size: 11px; margin-top: 6px; border-top: 1px dashed var(--line); padding-top: 4px">原文：{{ j.source }}…</div>
                <div v-if="expanded === j.id && j.format !== 'pics' && j.status !== 1 && j.status !== 2" style="margin-top: 8px; font-size: 12px" @click.stop>
                  <div class="row" style="gap: 6px; align-items: center; flex-wrap: wrap">
                    <span class="muted">切换文案看看：</span>
                    <button v-for="m in modesFor(j)" :key="m.k" class="small" :class="draft?.jobId === j.id && draft.mode === m.k ? '' : 'ghost'" @click="loadDraft(j, m.k)">{{ m.name }}</button>
                    <span class="muted" style="font-size: 11px">（浅处理 / 改写每点一次调一次 AI）</span>
                  </div>
                  <div v-if="draft?.jobId === j.id" style="margin-top: 6px; padding: 8px; background: var(--bg2, rgba(127,127,127,.08)); border-radius: 6px">
                    <div v-if="draft.loading" class="muted">出稿中…</div>
                    <div v-else-if="draft.error" style="color: #ff6b6b">{{ draft.error }}</div>
                    <template v-else>
                      <div style="font-weight: 600">{{ draft.title || '（无标题）' }}</div>
                      <div style="white-space: pre-wrap; margin-top: 4px">{{ draft.content }}</div>
                      <div v-if="draft.tags.length" class="muted" style="font-size: 11px; margin-top: 4px">#{{ draft.tags.join(' #') }}</div>
                      <button class="small" style="margin-top: 8px" @click="applyDraft(j)">用这版发出去{{ j.format === 'video' ? '（重新生成配图）' : '' }}</button>
                    </template>
                  </div>
                </div>
              </td>
              <td><span class="tag" :class="STATUS[j.status]?.cls">{{ STATUS[j.status]?.text }}</span><br /><span class="muted" style="font-size: 11px">第 {{ j.attempts }} 次</span></td>
              <td class="muted">{{ fmt(j.scheduledAt) }}</td>
              <td class="muted">{{ fmt(j.doneAt) }}</td>
              <td style="max-width: 220px; font-size: 12px">
                <a v-if="j.resultUrl" :href="j.resultUrl" target="_blank" style="color: var(--accent)">查看</a>
                <span v-if="j.error" style="color: #ff6b6b">{{ j.error }}</span>
              </td>
              <td>
                <div class="row">
                  <button v-if="j.status !== 1" class="small ghost" @click="retry(j)">{{ j.status === 0 ? '立刻发' : '重发' }}</button>
                  <button v-if="j.status === 0" class="small ghost" @click="skip(j)">跳过</button>
                  <button class="small ghost" @click="remove(j)">删除</button>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-else class="muted">还没有任务</div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
