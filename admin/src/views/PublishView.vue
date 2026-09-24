<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';

type Mode = 'raw' | 'ai';
interface Settings { enabled: boolean; platforms: string[]; dailyMax: number; hourStart: number; hourEnd: number; gapMin: number; token: string; lastPostId: string; modes: Record<string, Mode>; dailyMaxes: Record<string, number> }
interface Agent { online: boolean; lastSeen: string; host: string; accounts: Record<string, { ok: boolean; msg: string; checkedAt: string }>; ip: { ok: boolean; ip: string; where: string; msg: string } | null }
interface Overview { settings: Settings; agent: Agent; counts: Record<string, number>; platforms: { key: string; name: string }[] }
interface Job {
  id: string; postId: string; platform: string; platformName: string; title: string; content: string; tags: string; status: number;
  scheduledAt: string; claimedAt: string | null; doneAt: string | null; attempts: number; error: string; resultUrl: string; createdAt: string; source: string;
}

const ov = ref<Overview | null>(null);
const form = ref<{ enabled: boolean; platforms: string[]; hourStart: number; hourEnd: number; gapMin: number; modes: Record<string, Mode>; dailyMaxes: Record<string, number> }>({ enabled: false, platforms: [], hourStart: 9, hourEnd: 23, gapMin: 45, modes: {}, dailyMaxes: {} });
const jobs = ref<Job[]>([]);
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
    if (fillForm) form.value = { enabled: s.enabled, platforms: [...s.platforms], hourStart: s.hourStart, hourEnd: s.hourEnd, gapMin: s.gapMin, modes: { ...(s.modes ?? {}) }, dailyMaxes: { ...(s.dailyMaxes ?? {}) } };
    if (!testPlatforms.value.length) testPlatforms.value = [...s.platforms];
  } catch (e: any) { show(e.message); }
}
async function loadJobs() {
  const q = new URLSearchParams();
  if (filterStatus.value !== '') q.set('status', filterStatus.value);
  if (filterPlatform.value) q.set('platform', filterPlatform.value);
  jobs.value = await api<Job[]>(`/admin/publish/jobs?${q.toString()}`);
}
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
  loadOverview(true); loadJobs();
  timer = window.setInterval(() => { loadOverview(); loadJobs(); }, 15000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div>
    <div class="page-title">内容分发（推广）</div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">规则</div>
      <div class="muted" style="margin-bottom: 12px">
        私密树洞里 <b>Telegram 同步进来的每一条新帖</b>，按各平台的文案模式（原文直发 / AI 改写，见下方）出稿，渲染成卡片图，由你本机的发布机以真实浏览器发到下面勾选的平台。<b>不挑不审</b>；超过每日上限的顺延到之后几天，3 天内排不进的跳过。开启时以当前最新一条为起点，之前的旧帖不发。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center">
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="form.enabled" type="checkbox" style="width: auto" /> <b :style="{ color: form.enabled ? 'var(--accent)' : '' }">{{ form.enabled ? '已开启' : '已关闭' }}</b></label>
        <span class="muted">平台：</span>
        <label v-for="p in ov?.platforms ?? []" :key="p.key" class="muted" style="display: flex; align-items: center; gap: 4px">
          <input type="checkbox" style="width: auto" :checked="form.platforms.includes(p.key)" @change="toggle(form.platforms, p.key)" /> {{ p.name }}
        </label>
        <label class="muted">时段 <input v-model.number="form.hourStart" type="number" min="0" max="23" style="width: 50px" /> ~ <input v-model.number="form.hourEnd" type="number" min="1" max="24" style="width: 50px" /> 点</label>
        <label class="muted">同平台间隔 ≥ <input v-model.number="form.gapMin" type="number" min="0" max="600" style="width: 56px" /> 分钟</label>
        <button class="small" @click="save">保存</button>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line)">
        <span class="muted">各平台：</span>
        <label v-for="p in ov?.platforms ?? []" :key="p.key" class="muted" style="display: flex; align-items: center; gap: 4px">
          {{ p.name }}
          <select v-model="form.modes[p.key]" style="width: auto">
            <option value="raw">原文直发</option>
            <option value="ai">AI 改写</option>
          </select>
          每天 <input v-model.number="form.dailyMaxes[p.key]" type="number" min="1" max="50" style="width: 50px" /> 条
        </label>
        <div class="muted" style="font-size: 12px; width: 100%">
          <b>原文直发</b>：一个字不改、不过滤，标题取第一句按平台截长度；<b>AI 改写</b>：按平台出标题 / 正文 / 话题，敏感词软化、去引流词。改了点上面「保存」，只影响之后新入队的任务（含测试发布）。
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div style="font-weight: 600; margin-bottom: 6px">发布机（你本机的 publisher）</div>
      <div v-if="ov" class="row" style="flex-wrap: wrap; gap: 14px; align-items: center; font-size: 13px">
        <span class="tag" :class="ov.agent.online ? 'ok' : 'off'">{{ ov.agent.online ? '在线' : '离线' }}</span>
        <span class="muted">上次心跳 {{ fmt(ov.agent.lastSeen) }}<template v-if="ov.agent.host"> · {{ ov.agent.host }}</template></span>
        <span v-if="ov.agent.ip" :title="ov.agent.ip.msg">出口 IP <span class="tag" :class="ov.agent.ip.ok ? 'ok' : 'off'">{{ ov.agent.ip.ok ? '国内' : '国外（VPN？已停发）' }}</span> <span class="muted">{{ ov.agent.ip.ip }} {{ ov.agent.ip.where }}</span></span>
        <template v-for="p in ov.platforms" :key="p.key">
          <span v-if="ov.agent.accounts[p.key]" :title="ov.agent.accounts[p.key].msg">
            {{ p.name }} <span class="tag" :class="ov.agent.accounts[p.key].ok ? 'ok' : 'off'">{{ ov.agent.accounts[p.key].ok ? '已登录' : '未登录 / 失效' }}</span>
          </span>
          <span v-else class="muted">{{ p.name }} <span class="tag off">未检查</span></span>
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
        <select v-model="filterStatus" style="width: auto" @change="loadJobs">
          <option value="">全部状态</option><option value="0">待发</option><option value="1">发布中</option><option value="2">成功</option><option value="3">失败</option><option value="4">跳过</option>
        </select>
        <select v-model="filterPlatform" style="width: auto" @change="loadJobs">
          <option value="">全部平台</option><option v-for="p in ov?.platforms ?? []" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select>
        <button class="small ghost" @click="loadJobs">刷新</button>
      </div>
      <table v-if="jobs.length">
        <thead><tr><th>#</th><th>平台</th><th>标题 / 文案</th><th>状态</th><th>排期</th><th>完成</th><th>结果 / 错误</th><th>操作</th></tr></thead>
        <tbody>
          <template v-for="j in jobs" :key="j.id">
            <tr>
              <td class="muted">{{ j.id }}<br /><span style="font-size: 11px">帖 #{{ j.postId }}</span></td>
              <td>{{ j.platformName }}</td>
              <td style="max-width: 360px; cursor: pointer" @click="expanded = expanded === j.id ? null : j.id">
                <div style="font-weight: 600">{{ j.title || '（无标题）' }}</div>
                <div class="muted" style="font-size: 12px; white-space: pre-wrap" :style="expanded === j.id ? {} : { overflow: 'hidden', maxHeight: '36px' }">{{ j.content }}</div>
                <div v-if="j.tags" class="muted" style="font-size: 11px">#{{ j.tags.split(',').join(' #') }}</div>
                <div v-if="expanded === j.id" class="muted" style="font-size: 11px; margin-top: 6px; border-top: 1px dashed var(--line); padding-top: 4px">原文：{{ j.source }}…</div>
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
