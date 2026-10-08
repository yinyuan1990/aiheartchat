<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import ListPager from '../components/ListPager.vue';

/** 频道：用户自己开的频道，后台可查看帖子 / 评论、封禁频道、删帖、删评论 */
interface Channel {
  id: string; name: string; avatar: string; description: string;
  owner: { id: string; nickname: string; shortId: string } | null;
  status: number; subscribers: number; posts: number; lastPostAt: string | null; createdAt: string;
}
interface Post {
  id: string; type: string; content: string; createdAt: string;
  reactions: { emoji: string; count: number }[]; commentCount: number;
}
interface Comment {
  id: string; user?: { id: string; nickname: string; avatar: string }; content: string;
  sticker: { url: string; thumb?: string } | null; replyToNickname: string; createdAt: string;
}

interface Page { list: Channel[]; total: number; page: number; size: number; counts: Record<string, number> }
const CATS = [
  { key: 'alive', label: '正常' },
  { key: 'banned', label: '已封禁' },
  { key: 'deleted', label: '频道主已删除' },
  { key: 'all', label: '全部' },
];

const list = ref<Channel[]>([]);
const q = ref('');
const cat = ref('alive');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const counts = ref<Record<string, number>>({});
const current = ref<Channel | null>(null);
const posts = ref<Post[]>([]);
const openComments = ref<string | null>(null);
const comments = ref<Comment[]>([]);

const defaultLimit = ref<number | null>(null);
const limitInput = ref('');
const limitSaved = ref(false);
const retentionDays = ref<number | null>(null);
const retentionInput = ref('');
const retentionSaved = ref(false);

async function load() {
  const qs = new URLSearchParams({ cat: cat.value, page: String(page.value), size: String(size.value) });
  if (q.value.trim()) qs.set('q', q.value.trim());
  const r = await api<Page>(`/admin/channels?${qs}`);
  // 封禁 / 解封后当前分类少了一条，页码可能越界：退回最后一页
  if (!r.list.length && r.total > 0 && page.value > 1) {
    page.value = Math.ceil(r.total / size.value);
    return load();
  }
  list.value = r.list;
  total.value = r.total;
  counts.value = r.counts;
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
interface Config { defaultLimit: number; retentionDays: number }
function applyConfig(c: Config) {
  defaultLimit.value = c.defaultLimit;
  limitInput.value = String(c.defaultLimit);
  retentionDays.value = c.retentionDays;
  retentionInput.value = String(c.retentionDays);
}
async function loadConfig() {
  applyConfig(await api<Config>('/admin/channels/config'));
}
async function saveLimit() {
  const n = Number(limitInput.value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return alert('请填写 0 ~ 1000 的整数');
  try {
    applyConfig(await api<Config>('/admin/channels/config', { method: 'POST', body: { defaultLimit: n } }));
    limitSaved.value = true;
    setTimeout(() => (limitSaved.value = false), 1500);
  } catch (e: any) {
    alert(e.message);
  }
}
async function saveRetention() {
  const n = Number(retentionInput.value);
  if (!Number.isInteger(n) || n < 0 || n > 3650) return alert('请填写 0 ~ 3650 的整数');
  if (n > 0 && (retentionDays.value === 0 || n < (retentionDays.value ?? 0))
    && !confirm(`保存后会立即删除所有频道里超过 ${n} 天的消息，连同评论和图片 / 视频 / 语音文件，删除后无法恢复。确定？`)) return;
  try {
    applyConfig(await api<Config>('/admin/channels/config', { method: 'POST', body: { retentionDays: n } }));
    retentionSaved.value = true;
    setTimeout(() => (retentionSaved.value = false), 1500);
  } catch (e: any) {
    alert(e.message);
  }
}
async function open(c: Channel) {
  current.value = c;
  openComments.value = null;
  posts.value = await api<Post[]>(`/admin/channels/${c.id}/posts`);
}
async function toggleBan(c: Channel) {
  const ban = c.status !== 2;
  if (!confirm(ban ? `封禁频道「${c.name}」？订阅者将看不到它` : `解封频道「${c.name}」？`)) return;
  await api(`/admin/channels/${c.id}/status`, { method: 'POST', body: { banned: ban } });
  await load();
  if (current.value?.id === c.id) current.value = list.value.find((x) => x.id === c.id) ?? { ...current.value, status: ban ? 2 : 0 };
}
async function deletePost(p: Post) {
  if (!confirm('删除这条帖子（连同表情回应和评论）？')) return;
  await api(`/admin/channels/posts/${p.id}/delete`, { method: 'POST' });
  posts.value = posts.value.filter((x) => x.id !== p.id);
}
async function toggleComments(p: Post) {
  if (openComments.value === p.id) { openComments.value = null; return; }
  openComments.value = p.id;
  comments.value = await api<Comment[]>(`/admin/channels/posts/${p.id}/comments`);
}
async function deleteComment(c: Comment) {
  if (!confirm('删除这条评论？')) return;
  await api(`/admin/channels/comments/${c.id}/delete`, { method: 'POST' });
  comments.value = comments.value.filter((x) => x.id !== c.id);
}

function statusText(s: number) {
  return s === 0 ? '正常' : s === 2 ? '已封禁' : '频道主已删除';
}
function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
function postText(p: Post) {
  if (p.type === 'text') return p.content;
  if (p.type === 'sticker') return '[表情]';
  if (p.type === 'audio') return '[语音]';
  if (p.type === 'location') return '[位置]';
  return '';
}

onMounted(() => {
  load();
  loadConfig();
});
</script>

<template>
  <div>
    <div class="page-title">频道</div>
    <div class="card" style="margin-bottom: 16px">
      <div class="row">
        <div style="font-weight: 600">每人默认最多创建</div>
        <input v-model="limitInput" type="number" min="0" max="1000" style="width: 90px" data-testid="channel-default-limit" @keydown.enter="saveLimit" />
        <span>个频道</span>
        <button class="small" :disabled="limitInput === String(defaultLimit)" @click="saveLimit">保存</button>
        <span v-if="limitSaved" style="color: #2e9e5b">已保存</span>
        <span class="muted">填 0 = 默认不能创建。个别用户可在「用户管理」里单独设置额度，单独设置的优先。已经建了的频道不受影响，只是超出后不能再建；被封禁的频道也占名额。</span>
      </div>
      <div class="row" style="margin-top: 12px">
        <div style="font-weight: 600">频道消息保留</div>
        <input v-model="retentionInput" type="number" min="0" max="3650" style="width: 90px" data-testid="channel-retention" @keydown.enter="saveRetention" />
        <span>天</span>
        <button class="small" :disabled="retentionInput === String(retentionDays)" @click="saveRetention">保存</button>
        <span v-if="retentionSaved" style="color: #2e9e5b">已保存</span>
        <span class="muted">超过的消息每半小时自动清理一次：消息、评论、表情回应连同图片 / 视频 / 语音文件一起物理删除，无法恢复。填 0 = 永久保留。转发到别处的消息有自己的文件副本，不受影响。频道主也可以在频道资料里一键清空。</span>
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">频道</div>
        <input v-model="q" placeholder="搜频道名 / 简介" style="width: 200px" data-testid="channel-search" @keydown.enter="search" />
        <button class="small ghost" @click="search">搜索 / 刷新</button>
        <span class="muted">所有用户都能开频道（数量见上面的额度），频道主和管理员发帖，开了「订阅者可发消息」的频道订阅者也能发；订阅者可以表情回应和评论。封禁后订阅者的会话列表里不再显示，解封恢复</span>
      </div>
      <div class="cat-tabs">
        <button v-for="c in CATS" :key="c.key" :class="{ ghost: cat !== c.key }" :data-testid="`channel-cat-${c.key}`" @click="pickCat(c.key)">
          {{ c.label }}<span class="n">{{ counts[c.key] ?? 0 }}</span>
        </button>
      </div>
      <table>
        <thead><tr><th></th><th style="min-width: 200px">频道</th><th>频道主</th><th>订阅</th><th>帖子</th><th>最近发帖</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in list" :key="c.id" :style="current?.id === c.id ? 'background: rgba(254,44,85,0.06)' : ''">
            <td>
              <img v-if="c.avatar" :src="c.avatar" style="width: 40px; height: 40px; border-radius: 20px; object-fit: cover" />
              <div v-else style="width: 40px; height: 40px; border-radius: 20px; background: #2a2a30"></div>
            </td>
            <td>
              <div>{{ c.name }}</div>
              <div class="muted" style="font-size: 12px; max-width: 320px; white-space: pre-wrap">{{ c.description || '（无简介）' }}</div>
            </td>
            <td class="muted" style="font-size: 12px">{{ c.owner?.nickname }}<br />ID {{ c.owner?.shortId }}</td>
            <td>{{ c.subscribers }}</td>
            <td>{{ c.posts }}</td>
            <td class="muted">{{ fmt(c.lastPostAt) }}</td>
            <td :style="c.status === 2 ? 'color: var(--accent)' : ''">{{ statusText(c.status) }}</td>
            <td>
              <div class="row">
                <button class="small ghost" @click="open(c)">看帖子</button>
                <button class="small ghost" @click="toggleBan(c)">{{ c.status === 2 ? '解封' : '封禁' }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="list.length === 0"><td colspan="8" class="muted">没有符合条件的频道</td></tr>
        </tbody>
      </table>
      <ListPager :total="total" :page="page" :size="size" @change="onPage" />
    </div>

    <div v-if="current" class="card" style="margin-top: 16px">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">「{{ current.name }}」最近帖子（{{ posts.length }}）</div>
        <button class="small ghost" @click="current = null">收起</button>
      </div>
      <table>
        <thead><tr><th style="min-width: 320px">内容</th><th>时间</th><th>回应</th><th>评论</th><th>操作</th></tr></thead>
        <tbody>
          <template v-for="p in posts" :key="p.id">
            <tr>
              <td>
                <img v-if="p.type === 'image'" :src="p.content" style="max-width: 160px; max-height: 120px; border-radius: 6px" />
                <video v-else-if="p.type === 'video'" :src="p.content" controls style="max-width: 200px; max-height: 140px"></video>
                <div v-else style="white-space: pre-wrap; max-width: 480px">{{ postText(p) }}</div>
              </td>
              <td class="muted">{{ fmt(p.createdAt) }}</td>
              <td class="muted">{{ p.reactions.map((r) => `${r.emoji}${r.count}`).join(' ') || '—' }}</td>
              <td><a style="cursor: pointer" @click="toggleComments(p)">{{ p.commentCount }} 条{{ openComments === p.id ? ' ▲' : '' }}</a></td>
              <td><button class="small ghost" @click="deletePost(p)">删除</button></td>
            </tr>
            <tr v-if="openComments === p.id">
              <td colspan="5" style="background: rgba(0,0,0,0.03)">
                <div v-if="comments.length === 0" class="muted">没有评论</div>
                <div v-for="c in comments" :key="c.id" class="row" style="padding: 4px 0">
                  <span style="font-weight: 600">{{ c.user?.nickname }}</span>
                  <span v-if="c.replyToNickname" class="muted">回复 {{ c.replyToNickname }}</span>
                  <span>{{ c.content }}</span>
                  <img v-if="c.sticker" :src="c.sticker.thumb || c.sticker.url" style="width: 36px; height: 36px" />
                  <span class="muted" style="font-size: 12px">{{ fmt(c.createdAt) }}</span>
                  <button class="small ghost" @click="deleteComment(c)">删除</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="posts.length === 0"><td colspan="5" class="muted">还没有帖子</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
