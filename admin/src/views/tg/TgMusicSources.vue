<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const props = defineProps<{ loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'toast', t: string): void }>();

interface Source {
  id: number; channel: string; title: string; subscribers: number; enabled: boolean;
  lastMsgId: number; lastSyncAt: string | null; lastError: string; importedCount: number; syncing?: boolean;
}
interface PreviewAudio { msgId: number; title: string; performer: string; duration: number; size: number; date: string; hasCover: boolean }
interface Preview {
  channel: string; title: string; subscribers: number; about: string;
  scanned: number; audioCount: number; recentCount: number; audios: PreviewAudio[];
}
const sources = ref<Source[]>([]);
const srcForm = ref<{ id?: number; channel: string; enabled: boolean }>({ channel: '', enabled: true });
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const syncing = ref<number | null>(null);

function normalize(raw: string) {
  return raw.trim().replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
}
async function loadSources() {
  sources.value = await api<Source[]>('/admin/music/sources');
}
async function doPreview() {
  if (!srcForm.value.channel.trim()) return emit('toast', '请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api<Preview>(`/admin/music/sources/preview?channel=${encodeURIComponent(srcForm.value.channel)}`);
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  if (!preview.value || preview.value.channel.toLowerCase() !== normalize(srcForm.value.channel).toLowerCase()) {
    return emit('toast', '请先点「解析」核对频道标题和曲目，再保存');
  }
  if (srcForm.value.id) {
    const old = sources.value.find((s) => s.id === srcForm.value.id);
    if (old && old.channel.toLowerCase() !== preview.value.channel.toLowerCase() && !confirm(`换成 @${preview.value.channel}「${preview.value.title}」？旧频道已同步的曲目会全部删除`)) return;
  }
  try {
    await api('/admin/music/sources', { method: 'POST', body: srcForm.value });
    srcForm.value = { channel: '', enabled: true };
    preview.value = null;
    emit('toast', '已保存，每 10 分钟自动同步一次；可点「立即同步」');
    loadSources();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
function editSource(s: Source) {
  srcForm.value = { id: s.id, channel: s.channel, enabled: s.enabled };
  preview.value = null;
}
async function removeSource(s: Source) {
  if (!confirm(`删除来源 @${s.channel}？已同步的曲目和文件会一起删除`)) return;
  await api(`/admin/music/sources/${s.id}`, { method: 'DELETE' });
  loadSources();
}
async function syncNow(s: Source) {
  syncing.value = s.id;
  try {
    const r = await api<{ started: boolean }>(`/admin/music/sources/${s.id}/sync`, { method: 'POST' });
    emit('toast', r.started ? '已开始后台同步，下载较慢请稍等…' : '已有同步任务在跑，等它结束');
    const before = s.importedCount;
    for (let i = 0; i < 240; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      await loadSources();
      const cur = sources.value.find((x) => x.id === s.id);
      if (cur && !cur.syncing) {
        emit('toast', cur.lastError ? `同步出错：${cur.lastError}` : `同步完成：新增 ${cur.importedCount - before} 首`);
        break;
      }
    }
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    syncing.value = null;
    loadSources();
  }
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
onMounted(loadSources);
</script>

<template>
  <div class="card">
    <div style="font-weight: 600; margin-bottom: 6px">音乐 · 频道来源</div>
    <div class="muted" style="margin-bottom: 12px">
      消息页「音乐」入口的曲目来源。填频道 → 先点<b>「解析」</b>看标题、订阅数、最近的曲目对不对得上 → 再保存。每 10 分钟同步一次，音频转存到自己服务器；<b>最多保留 100 首</b>，超出删最旧的。
    </div>
    <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
      <label class="muted">频道 <input v-model="srcForm.channel" placeholder="wenan_DJ866 或 https://t.me/wenan_DJ866" style="width: 300px" @keydown.enter="doPreview" /></label>
      <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.enabled" type="checkbox" style="width: auto" /> 启用</label>
      <button class="small ghost" :disabled="previewing || !props.loggedIn" @click="doPreview">{{ previewing ? '解析中…' : '解析' }}</button>
      <button class="small" :disabled="!preview" @click="saveSource">{{ srcForm.id ? '保存修改' : '添加来源' }}</button>
      <button v-if="srcForm.id" class="small ghost" @click="srcForm = { channel: '', enabled: true }; preview = null">取消编辑</button>
      <span v-if="!props.loggedIn" class="muted" style="color: #ffb020">先登录 Telegram 账号才能解析</span>
    </div>

    <div v-if="preview" style="margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
      <div class="row" style="gap: 10px; align-items: baseline">
        <span style="font-size: 16px; font-weight: 600">{{ preview.title }}</span>
        <span class="muted">@{{ preview.channel }} · {{ preview.subscribers.toLocaleString() }} 订阅</span>
      </div>
      <div v-if="preview.about" class="muted" style="margin-top: 4px; white-space: pre-wrap; font-size: 12px">{{ preview.about }}</div>
      <div class="muted" style="margin: 8px 0">最近 {{ preview.scanned }} 条音频消息里解析到 {{ preview.audioCount }} 首，保存后首次同步会导入最近 <b style="color: var(--accent)">{{ preview.recentCount }}</b> 首左右：</div>
      <div v-if="preview.audios.length === 0" class="muted">这个频道最近没有音频文件，可能不是音乐频道</div>
      <div v-for="a in preview.audios" :key="a.msgId" class="row" style="padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px">
        <span style="flex: 1">{{ a.title }} <span class="muted">{{ a.performer }}</span></span>
        <span class="muted" style="flex-shrink: 0">{{ fmtDur(a.duration) }} · {{ fmtSize(a.size) }} · {{ fmt(a.date) }} · #{{ a.msgId }}</span>
      </div>
    </div>

    <table v-if="sources.length" style="margin-top: 14px">
      <thead><tr><th>频道</th><th>标题</th><th>订阅</th><th>状态</th><th>已导入</th><th>上次同步</th><th>错误</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="s in sources" :key="s.id">
          <td><a :href="`https://t.me/${s.channel}`" target="_blank" style="color: var(--accent)">@{{ s.channel }}</a></td>
          <td>{{ s.title }}</td>
          <td class="muted">{{ s.subscribers.toLocaleString() }}</td>
          <td><span class="tag" :class="s.enabled ? 'ok' : 'off'">{{ s.enabled ? '启用' : '停用' }}</span></td>
          <td>{{ s.importedCount }} <span class="muted">(至 #{{ s.lastMsgId }})</span></td>
          <td class="muted">{{ s.lastSyncAt ? fmt(s.lastSyncAt) : '—' }}</td>
          <td class="muted" style="max-width: 240px; color: #ff6b6b">{{ s.lastError }}</td>
          <td>
            <div class="row">
              <button class="small" :disabled="syncing === s.id || s.syncing || !props.loggedIn" @click="syncNow(s)">{{ syncing === s.id || s.syncing ? '同步中（下载较慢）…' : '立即同步' }}</button>
              <button class="small ghost" @click="editSource(s)">编辑</button>
              <button class="small ghost" @click="removeSource(s)">删除</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted" style="margin-top: 10px">还没有来源</div>
  </div>
</template>
