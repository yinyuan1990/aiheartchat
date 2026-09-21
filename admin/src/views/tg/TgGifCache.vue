<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const props = defineProps<{ loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'toast', t: string): void }>();

interface GifRow { id: number; key: string; url: string; thumb: string; w: number; h: number; duration: number; size: number; query: string; hits: number; blocked: boolean; lastUsedAt: string; createdAt: string }
interface Stats { total: number; blocked: number; bytes: number; max: number }

const stats = ref<Stats | null>(null);
const list = ref<GifRow[]>([]);
const total = ref(0);
const page = ref(1);
const q = ref('');
const loading = ref(false);
const SIZE = 40;

async function load() {
  loading.value = true;
  try {
    const [s, r] = await Promise.all([
      api<Stats>('/admin/gifs/stats'),
      api<{ total: number; list: GifRow[] }>(`/admin/gifs?page=${page.value}&size=${SIZE}&q=${encodeURIComponent(q.value.trim())}`),
    ]);
    stats.value = s;
    list.value = r.list;
    total.value = r.total;
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    loading.value = false;
  }
}
async function block(g: GifRow) {
  if (!confirm('屏蔽这条 GIF？文件会删除，之后不再出现在用户搜索结果里。')) return;
  await api(`/admin/gifs/${g.id}/block`, { method: 'POST' });
  emit('toast', '已屏蔽');
  load();
}
async function unblock(g: GifRow) {
  await api(`/admin/gifs/${g.id}/unblock`, { method: 'POST' });
  emit('toast', '已解除（下次搜到会重新下载）');
  load();
}
async function purge() {
  if (!confirm(`清空全部 GIF 缓存（${stats.value?.total ?? 0} 条）？用户聊天里已发出的 GIF 会变成裂图；屏蔽记录保留。`)) return;
  const r = await api<{ removed: number }>('/admin/gifs/purge', { method: 'POST' });
  emit('toast', `已清空 ${r.removed} 条`);
  page.value = 1;
  load();
}
function mb(n: number) {
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
onMounted(load);
</script>

<template>
  <div>
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">GIF · Telegram @gif 中转缓存</div>
      <div class="muted" style="margin-bottom: 12px">
        表情面板「GIF」页的内容来自 Telegram 的 <b>@gif</b> 机器人（背后是 Tenor），用户搜什么就通过已登录的 Telegram 账号去搜，
        结果（无声 mp4）下载转存到自己服务器并生成动态 WebP 预览；<b>每条 ≤5MB，最多留 {{ stats?.max ?? 3000 }} 条</b>，超出按最久没用的自动清。
        这里只用来看占用和屏蔽不合适的内容，不需要日常维护。
      </div>
      <div class="row" style="gap: 18px; align-items: center; flex-wrap: wrap">
        <span>已缓存 <b>{{ stats?.total ?? '-' }}</b> 条</span>
        <span>占用 <b>{{ stats ? mb(stats.bytes) : '-' }}</b></span>
        <span>已屏蔽 <b>{{ stats?.blocked ?? '-' }}</b> 条</span>
        <span v-if="!props.loggedIn" class="muted" style="color: #ffb020">Telegram 账号未登录，用户搜不到新 GIF（已缓存的仍可用）</span>
        <span class="grow" />
        <button class="small ghost" style="color: #ff5c5c" @click="purge">清空缓存</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="gap: 8px; margin-bottom: 10px; align-items: center">
        <input v-model="q" placeholder="按搜索词过滤" style="width: 200px" @keydown.enter="page = 1; load()" />
        <button class="small ghost" :disabled="loading" @click="page = 1; load()">查询</button>
        <span class="muted">{{ total }} 条 · 按最近使用排序</span>
        <span class="grow" />
        <button class="small ghost" :disabled="page <= 1" @click="page--; load()">上一页</button>
        <span class="muted">{{ page }} / {{ Math.max(1, Math.ceil(total / SIZE)) }}</span>
        <button class="small ghost" :disabled="page * SIZE >= total" @click="page++; load()">下一页</button>
      </div>
      <div v-if="loading" class="muted">加载中…</div>
      <div v-else-if="!list.length" class="muted">还没有缓存</div>
      <div v-else class="gif-grid">
        <div v-for="g in list" :key="g.id" class="gif-cell" :class="{ blocked: g.blocked }">
          <img v-if="g.thumb" :src="g.thumb" loading="lazy" />
          <div v-else class="gif-none">{{ g.blocked ? '已屏蔽' : '无预览' }}</div>
          <div class="gif-meta">
            <span>{{ g.w }}×{{ g.h }} · {{ (g.size / 1024).toFixed(0) }}KB</span>
            <span class="muted" :title="g.query">{{ g.query || '热门' }}</span>
            <span class="muted">{{ fmt(g.lastUsedAt) }}</span>
          </div>
          <div class="row" style="gap: 6px; margin-top: 4px">
            <a v-if="g.url" class="small ghost" :href="g.url" target="_blank" style="text-decoration: none; padding: 2px 8px">看</a>
            <button v-if="!g.blocked" class="small ghost" style="color: #ff5c5c" @click="block(g)">屏蔽</button>
            <button v-else class="small ghost" @click="unblock(g)">解除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gif-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.gif-cell { border: 1px solid var(--line); border-radius: 8px; padding: 8px; font-size: 12px; }
.gif-cell.blocked { opacity: 0.5; }
.gif-cell img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; background: #000; display: block; }
.gif-none { width: 100%; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; background: var(--bg-input, #222); border-radius: 6px; color: #888; }
.gif-meta { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.gif-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
