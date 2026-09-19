<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const emit = defineEmits<{ (e: 'toast', t: string): void }>();

interface Source {
  id: number; channel: string; enabled: boolean; minViews: number; stripLinks: boolean; blockWords: string;
  lastMsgId: number; lastSyncAt: string | null; lastError: string; importedCount: number;
}
const sources = ref<Source[]>([]);
const srcForm = ref<{ id?: number; channel: string; enabled: boolean; minViews: number; stripLinks: boolean; blockWords: string }>({ channel: '', enabled: true, minViews: 0, stripLinks: true, blockWords: '' });
const preview = ref<{ channel: string; count: number; posts: { msgId: number; text: string; photos: string[]; views: number; date: string }[] } | null>(null);
const previewing = ref(false);
const syncing = ref<number | null>(null);

async function loadSources() {
  sources.value = await api<Source[]>('/admin/treehole/sources');
}
async function doPreview() {
  if (!srcForm.value.channel.trim()) return emit('toast', '请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api(`/admin/treehole/sources/preview?channel=${encodeURIComponent(srcForm.value.channel)}`);
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  if (!preview.value) return emit('toast', '请先点「预览」核对频道内容，再保存');
  try {
    await api('/admin/treehole/sources', { method: 'POST', body: srcForm.value });
    srcForm.value = { channel: '', enabled: true, minViews: 0, stripLinks: true, blockWords: '' };
    preview.value = null;
    emit('toast', '已保存，每 10 分钟自动同步一次');
    loadSources();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
function editSource(s: Source) {
  srcForm.value = { id: s.id, channel: s.channel, enabled: s.enabled, minViews: s.minViews, stripLinks: s.stripLinks, blockWords: s.blockWords };
  preview.value = null;
}
async function removeSource(s: Source) {
  if (!confirm(`删除来源 @${s.channel}？已同步的帖子会保留`)) return;
  await api(`/admin/treehole/sources/${s.id}`, { method: 'DELETE' });
  loadSources();
}
async function syncNow(s: Source, full = false) {
  if (full && !confirm('回灌历史会往前翻约 100 条并全部导入，确定？')) return;
  syncing.value = s.id;
  try {
    const r = await api<{ imported: number; skipped: number }>(`/admin/treehole/sources/${s.id}/sync`, { method: 'POST', body: { full } });
    emit('toast', `同步完成：新增 ${r.imported} 条，跳过 ${r.skipped} 条`);
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
onMounted(loadSources);
</script>

<template>
  <div class="card">
    <div style="font-weight: 600; margin-bottom: 6px">私密树洞 · 频道来源</div>
    <div class="muted" style="margin-bottom: 12px">
      抓的是频道<b>网页预览</b>（t.me/s/频道，文字 + 图片，不需要登录账号）：只支持开放了预览的公开频道。
      填频道 → 先点<b>「预览」</b>核对内容对不对得上 → 再保存。每 10 分钟同步一次，帖子只保留 3 天。
    </div>
    <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
      <label class="muted">频道 <input v-model="srcForm.channel" placeholder="xxx 或 https://t.me/xxx" style="width: 220px" @keydown.enter="doPreview" /></label>
      <label class="muted">阅读数 ≥ <input v-model.number="srcForm.minViews" type="number" min="0" style="width: 80px" /></label>
      <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.stripLinks" type="checkbox" style="width: auto" /> 去掉含 @ / 链接的行</label>
      <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.enabled" type="checkbox" style="width: auto" /> 启用</label>
      <label class="muted">屏蔽词 <input v-model="srcForm.blockWords" placeholder="逗号分隔，含则跳过" style="width: 200px" /></label>
      <button class="small ghost" :disabled="previewing" @click="doPreview">{{ previewing ? '抓取中…' : '预览' }}</button>
      <button class="small" :disabled="!preview" @click="saveSource">{{ srcForm.id ? '保存修改' : '添加来源' }}</button>
      <button v-if="srcForm.id" class="small ghost" @click="srcForm = { channel: '', enabled: true, minViews: 0, stripLinks: true, blockWords: '' }; preview = null">取消编辑</button>
    </div>

    <div v-if="preview" style="margin-top: 14px">
      <div class="muted" style="margin-bottom: 8px">@{{ preview.channel }} 最近 {{ preview.count }} 条可抓，预览最新 {{ preview.posts.length }} 条：</div>
      <div v-for="p in preview.posts" :key="p.msgId" class="row" style="align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--line)">
        <div v-if="p.photos.length" class="row" style="gap: 4px; flex-shrink: 0">
          <img v-for="u in p.photos.slice(0, 3)" :key="u" :src="u" referrerpolicy="no-referrer" style="width: 56px; height: 56px; object-fit: cover; border-radius: 6px" />
        </div>
        <div style="flex: 1; white-space: pre-wrap; line-height: 1.5; font-size: 13px">{{ p.text || '（仅图片）' }}</div>
        <div class="muted" style="flex-shrink: 0; font-size: 12px">#{{ p.msgId }} · {{ p.views }} 阅读</div>
      </div>
    </div>

    <table v-if="sources.length" style="margin-top: 14px">
      <thead><tr><th>频道</th><th>状态</th><th>阅读≥</th><th>已导入</th><th>上次同步</th><th>错误</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="s in sources" :key="s.id">
          <td><a :href="`https://t.me/s/${s.channel}`" target="_blank" style="color: var(--accent)">@{{ s.channel }}</a></td>
          <td><span class="tag" :class="s.enabled ? 'ok' : 'off'">{{ s.enabled ? '启用' : '停用' }}</span></td>
          <td>{{ s.minViews }}</td>
          <td>{{ s.importedCount }} <span class="muted">(至 #{{ s.lastMsgId }})</span></td>
          <td class="muted">{{ s.lastSyncAt ? fmt(s.lastSyncAt) : '—' }}</td>
          <td class="muted" style="max-width: 240px; color: #ff6b6b">{{ s.lastError }}</td>
          <td>
            <div class="row">
              <button class="small" :disabled="syncing === s.id" @click="syncNow(s)">{{ syncing === s.id ? '同步中…' : '立即同步' }}</button>
              <button class="small ghost" :disabled="syncing === s.id" @click="syncNow(s, true)">回灌历史</button>
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
