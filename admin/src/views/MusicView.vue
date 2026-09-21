<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

/** 音乐：已同步曲目管理。Telegram 账号登录与频道来源在「Telegram 来源」页 */
interface Track {
  id: string; sourceId: number; title: string; performer: string; duration: number; size: number;
  url: string; cover: string; postedAt: string; playCount: number;
}
interface Source { id: number; channel: string; title: string }
const tracks = ref<Track[]>([]);
const sources = ref<Source[]>([]);
/** 按来源筛（0 = 全部） */
const sourceFilter = ref(0);
const playing = ref<string | null>(null);
async function loadTracks() {
  tracks.value = await api<Track[]>(`/admin/music/tracks${sourceFilter.value ? `?sourceId=${sourceFilter.value}` : ''}`);
}
async function loadSources() {
  sources.value = await api<Source[]>('/admin/music/sources').catch(() => []);
}
function sourceName(id: number) {
  const s = sources.value.find((x) => x.id === id);
  return s ? (s.title || `@${s.channel}`) : `#${id}`;
}
async function deleteTrack(t: Track) {
  if (!confirm(`删除「${t.title}」？`)) return;
  await api(`/admin/music/tracks/${t.id}/delete`, { method: 'POST' });
  loadTracks();
}
async function purge() {
  const r = await api<{ removed: number }>('/admin/music/purge', { method: 'POST' });
  showToast(`已清理 ${r.removed} 首超量曲目`);
  loadTracks();
}

const toast = ref('');
function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 2200);
}
function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}
function fmtDur(s: number) {
  if (!s) return '—';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

onMounted(() => { loadSources(); loadTracks(); });
</script>

<template>
  <div>
    <div class="page-title">音乐频道</div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">已同步曲目（{{ tracks.length }}）</div>
        <select v-model.number="sourceFilter" @change="loadTracks()">
          <option :value="0">全部来源</option>
          <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.title || '@' + s.channel }}</option>
        </select>
        <button class="small ghost" @click="purge">清理超量</button>
        <button class="small ghost" @click="loadTracks">刷新</button>
        <span class="muted">用户端「消息 → 音乐」看到的就是这些（各来源混排、最新在前）；每个来源超过 100 首自动删该来源最旧的。频道来源（最多 5 个）与 Telegram 账号在「Telegram 来源」页管理</span>
      </div>
      <table>
        <thead><tr><th></th><th style="min-width: 260px">曲目</th><th>来源</th><th>时长</th><th>大小</th><th>发布时间</th><th>播放</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tracks" :key="t.id">
            <td>
              <img v-if="t.cover" :src="t.cover" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover" />
              <div v-else style="width: 40px; height: 40px; border-radius: 6px; background: #2a2a30"></div>
            </td>
            <td>
              <div>{{ t.title }}</div>
              <div class="muted" style="font-size: 12px">{{ t.performer || '未知艺术家' }}</div>
              <audio v-if="playing === t.id" :src="t.url" controls autoplay style="margin-top: 6px; height: 32px; width: 320px"></audio>
            </td>
            <td class="muted" style="font-size: 12px; max-width: 140px">{{ sourceName(t.sourceId) }}</td>
            <td class="muted">{{ fmtDur(t.duration) }}</td>
            <td class="muted">{{ fmtSize(t.size) }}</td>
            <td class="muted">{{ fmt(t.postedAt) }}</td>
            <td class="muted">{{ t.playCount }}</td>
            <td>
              <div class="row">
                <button class="small ghost" @click="playing = playing === t.id ? null : t.id">{{ playing === t.id ? '收起' : '试听' }}</button>
                <button class="small ghost" @click="deleteTrack(t)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="tracks.length === 0"><td colspan="8" class="muted">暂无曲目（到「Telegram 来源」页登录账号、添加来源后点「立即同步」）</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
