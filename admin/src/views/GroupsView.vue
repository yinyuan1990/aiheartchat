<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import ListPager from '../components/ListPager.vue';

/** 群聊：用户建的群 + 币群（钱包代币页的讨论群），后台可看消息、封禁、设置是否对用户显示 */
interface Group {
  id: string; name: string; avatar: string; notice: string;
  owner: { id: string; nickname: string; shortId: string } | null;
  status: number; visible: boolean; hasPassword: boolean;
  coin: { chain: string; address: string } | null;
  members: number; memberLimit: number; messages: number; lastMsgAt: string | null; createdAt: string;
}
interface Msg {
  id: string; type: string; content: string; createdAt: string;
  sender: { id: string; nickname: string; shortId: string; avatar: string; isBot: boolean } | null;
}

interface Page { list: Group[]; total: number; page: number; size: number; counts: Record<string, number> }
const CATS = [
  { key: 'alive', label: '正常' },
  { key: 'hidden', label: '已隐藏' },
  { key: 'banned', label: '已封禁' },
  { key: 'dissolved', label: '已解散' },
  { key: 'all', label: '全部' },
];

const list = ref<Group[]>([]);
const q = ref('');
const cat = ref('alive');
const type = ref<'all' | 'user' | 'coin'>('all');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const counts = ref<Record<string, number>>({});
const current = ref<Group | null>(null);
const msgs = ref<Msg[]>([]);
const more = ref(false);
const busy = ref<string | null>(null);

async function load() {
  const qs = new URLSearchParams({ cat: cat.value, type: type.value, page: String(page.value), size: String(size.value) });
  if (q.value.trim()) qs.set('q', q.value.trim());
  const r = await api<Page>(`/admin/groups?${qs}`);
  // 删掉最后一页的最后几条后页码可能越界：退回最后一页
  if (!r.list.length && r.total > 0 && page.value > 1) {
    page.value = Math.ceil(r.total / size.value);
    return load();
  }
  list.value = r.list;
  total.value = r.total;
  counts.value = r.counts;
  if (current.value) current.value = list.value.find((x) => x.id === current.value!.id) ?? current.value;
}
function search() {
  page.value = 1;
  load();
}
function pickCat(k: string) {
  cat.value = k;
  search();
}
function onPage(p: number, s: number) {
  page.value = p;
  size.value = s;
  load();
}
async function open(g: Group) {
  current.value = g;
  msgs.value = await api<Msg[]>(`/admin/groups/${g.id}/messages`);
  more.value = msgs.value.length >= 50;
}
async function loadMore() {
  if (!current.value || !msgs.value.length) return;
  const older = await api<Msg[]>(`/admin/groups/${current.value.id}/messages?beforeId=${msgs.value[msgs.value.length - 1].id}`);
  msgs.value = [...msgs.value, ...older];
  more.value = older.length >= 50;
}
async function toggleBan(g: Group) {
  const ban = g.status !== 2;
  if (!confirm(ban ? `封禁群「${g.name}」？成员的会话列表里不再显示，也不能再发消息` : `解封群「${g.name}」？`)) return;
  busy.value = g.id;
  try {
    await api(`/admin/groups/${g.id}/status`, { method: 'POST', body: { banned: ban } });
    await load();
  } catch (e: any) {
    alert(e.message);
  } finally {
    busy.value = null;
  }
}
async function toggleVisible(g: Group) {
  const visible = !g.visible;
  if (!visible && !confirm(`对用户隐藏群「${g.name}」？\n\n隐藏后：所有人（包括群成员）的消息列表里看不到它，不推送、不算未读；发消息、搜群、扫码 / 邀请码入群都会被拒绝。消息记录保留，重新打开显示后一切恢复。`)) return;
  busy.value = g.id;
  try {
    await api(`/admin/groups/${g.id}/visible`, { method: 'POST', body: { visible } });
    await load();
  } catch (e: any) {
    alert(e.message);
  } finally {
    busy.value = null;
  }
}

function statusText(s: number) {
  return s === 0 ? '正常' : s === 2 ? '已封禁' : '群主已解散';
}
function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
const TYPE_TEXT: Record<string, string> = {
  sticker: '[表情]', audio: '[语音]', location: '[位置]', callout: '[喊单卡片]', perp: '[合约喊单]',
  payreq: '[收款]', transfer: '[转账卡片]', gift: '[礼物]', call: '[通话记录]',
};
function msgText(m: Msg) {
  if (m.type === 'text') return m.content;
  return TYPE_TEXT[m.type] ?? `[${m.type}]`;
}
function shortAddr(a: string) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-title">群管理</div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px; flex-wrap: wrap">
        <div style="font-weight: 600">群聊</div>
        <input v-model="q" placeholder="搜群名 / 群 ID / 群主 6 位 ID" style="width: 220px" data-testid="group-search" @keydown.enter="search" />
        <button class="small ghost" @click="search">搜索 / 刷新</button>
        <select v-model="type" data-testid="group-kind" @change="search">
          <option value="all">全部类型</option>
          <option value="user">用户建的群</option>
          <option value="coin">币群</option>
        </select>
      </div>
      <div class="cat-tabs">
        <button v-for="c in CATS" :key="c.key" :class="{ ghost: cat !== c.key }" :data-testid="`group-cat-${c.key}`" @click="pickCat(c.key)">
          {{ c.label }}<span class="n">{{ counts[c.key] ?? 0 }}</span>
        </button>
      </div>
      <p class="muted" style="margin-bottom: 12px">
        「正常」= 没解散、没封禁的群（包括已隐藏的）。「对用户显示」默认打开，关掉后这个群不出现在任何人的消息列表里（包括群成员），不推送、不算未读，发消息 / 搜群 / 扫码入群都会被拒；消息记录保留，重新打开即恢复。
        币群（钱包代币页的讨论群）同样适用，隐藏后从代币页也进不去。
      </p>
      <table>
        <thead>
          <tr><th></th><th style="min-width: 180px">群</th><th>群主</th><th>成员</th><th>消息</th><th>最近消息</th><th>创建</th><th>状态</th><th>对用户显示</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="g in list" :key="g.id" :style="current?.id === g.id ? 'background: rgba(254,44,85,0.06)' : ''" :data-testid="`group-row-${g.id}`">
            <td>
              <img v-if="g.avatar" :src="g.avatar" style="width: 40px; height: 40px; border-radius: 20px; object-fit: cover" />
              <div v-else style="width: 40px; height: 40px; border-radius: 20px; background: #2a2a30"></div>
            </td>
            <td>
              <div class="row" style="gap: 6px; flex-wrap: wrap">
                <span>{{ g.name }}</span>
                <span v-if="g.coin" class="tag warn" :title="`${g.coin.chain} ${g.coin.address}`">币群 · {{ g.coin.chain }} {{ shortAddr(g.coin.address) }}</span>
                <span v-if="g.hasPassword" class="tag off">有入群密码</span>
              </div>
              <div class="muted" style="font-size: 12px; max-width: 300px; white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical">{{ g.notice || '（无公告）' }}</div>
              <div class="muted" style="font-size: 12px">ID {{ g.id }}</div>
            </td>
            <td class="muted" style="font-size: 12px">{{ g.owner?.nickname }}<br />ID {{ g.owner?.shortId }}</td>
            <td>{{ g.members }}<span class="muted"> / {{ g.memberLimit }}</span></td>
            <td>{{ g.messages }}</td>
            <td class="muted">{{ fmt(g.lastMsgAt) }}</td>
            <td class="muted">{{ fmt(g.createdAt) }}</td>
            <td :style="`white-space: nowrap;${g.status === 2 ? ' color: var(--accent)' : ''}`">{{ statusText(g.status) }}</td>
            <td>
              <label class="row" style="gap: 6px; cursor: pointer; white-space: nowrap">
                <input type="checkbox" :checked="g.visible" :disabled="busy === g.id" :data-testid="`group-visible-${g.id}`" @click.prevent="toggleVisible(g)" />
                <span :class="['tag', g.visible ? 'ok' : 'off']">{{ g.visible ? '显示中' : '已隐藏' }}</span>
              </label>
            </td>
            <td>
              <div class="row" style="white-space: nowrap">
                <button class="small ghost" @click="open(g)">看消息</button>
                <button class="small ghost" :disabled="busy === g.id" @click="toggleBan(g)">{{ g.status === 2 ? '解封' : '封禁' }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="list.length === 0"><td colspan="10" class="muted">没有符合条件的群</td></tr>
        </tbody>
      </table>
      <ListPager :total="total" :page="page" :size="size" @change="onPage" />
    </div>

    <div v-if="current" class="card">
      <div class="row" style="margin-bottom: 12px; flex-wrap: wrap">
        <div style="font-weight: 600">「{{ current.name }}」最近消息（{{ msgs.length }}）</div>
        <span v-if="!current.visible" class="tag off">已对用户隐藏</span>
        <button class="small ghost" @click="open(current)">刷新</button>
        <button class="small ghost" @click="current = null">收起</button>
      </div>
      <table>
        <thead><tr><th>发送人</th><th style="min-width: 300px">内容</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="m in msgs" :key="m.id">
            <td class="muted" style="font-size: 12px; white-space: nowrap">
              {{ m.sender?.nickname ?? '（已注销）' }}<span v-if="m.sender?.isBot"> · 机器人</span><br />
              <span v-if="m.sender?.shortId">ID {{ m.sender.shortId }}</span>
            </td>
            <td>
              <img v-if="m.type === 'image'" :src="m.content" style="max-width: 160px; max-height: 120px; border-radius: 6px" />
              <video v-else-if="m.type === 'video'" :src="m.content" controls style="max-width: 200px; max-height: 140px"></video>
              <div v-else style="white-space: pre-wrap; max-width: 520px; word-break: break-all">{{ msgText(m) }}</div>
            </td>
            <td class="muted" style="white-space: nowrap">{{ fmt(m.createdAt) }}</td>
          </tr>
          <tr v-if="msgs.length === 0"><td colspan="3" class="muted">还没有消息</td></tr>
        </tbody>
      </table>
      <div v-if="more" style="margin-top: 12px"><button class="small ghost" @click="loadMore">加载更早的消息</button></div>
    </div>
  </div>
</template>
