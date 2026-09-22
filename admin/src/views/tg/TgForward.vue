<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const props = defineProps<{ loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'toast', t: string): void }>();

interface Status { target: string; title: string; subscribers: number; canPost: boolean; error: string; sources: number; running: boolean }
interface Source {
  id: number; channel: string; title: string; subscribers: number; enabled: boolean; dropAuthor: boolean; mediaOnly: boolean; maxPerRun: number; blockWords: string;
  lastMsgId: number; lastSyncAt: string | null; lastError: string; forwardedCount: number; syncing?: boolean;
}
interface Preview {
  channel: string; title: string; subscribers: number; about: string; noforwards: boolean; latestMsgId: number;
  samples: { msgId: number; text: string; media: number; date: string }[];
}

const status = ref<Status | null>(null);
const targetInput = ref('');
const savingTarget = ref(false);
const sources = ref<Source[]>([]);
const emptyForm = () => ({ channel: '', enabled: true, dropAuthor: true, mediaOnly: false, maxPerRun: 3, blockWords: '', backfill: 3 });
const form = ref<{ id?: number } & ReturnType<typeof emptyForm>>(emptyForm());
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const syncing = ref<number | null>(null);

function normalize(raw: string) {
  return raw.trim().replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
}
async function loadStatus() {
  try {
    status.value = await api<Status>('/admin/tg-forward/status');
    if (!targetInput.value) targetInput.value = status.value.target;
  } catch (e: any) {
    emit('toast', e.message);
  }
}
async function loadSources() {
  sources.value = await api<Source[]>('/admin/tg-forward/sources');
}
async function saveTarget() {
  savingTarget.value = true;
  try {
    status.value = await api<Status>('/admin/tg-forward/target', { method: 'PUT', body: { channel: targetInput.value } });
    emit('toast', '目标频道已保存');
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    savingTarget.value = false;
  }
}
async function doPreview() {
  if (!form.value.channel.trim()) return emit('toast', '请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api<Preview>(`/admin/tg-forward/sources/preview?channel=${encodeURIComponent(form.value.channel)}`);
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  if (!preview.value || preview.value.channel.toLowerCase() !== normalize(form.value.channel).toLowerCase()) {
    return emit('toast', '请先点「解析」核对频道，再保存');
  }
  try {
    const isNew = !form.value.id;
    await api('/admin/tg-forward/sources', { method: 'POST', body: { ...form.value, backfill: isNew ? form.value.backfill : 0 } });
    emit('toast', isNew && form.value.backfill > 0 ? `已添加，正在把最近 ${form.value.backfill} 条转到目标频道…` : '已保存，每 10 分钟自动转发新消息');
    form.value = emptyForm();
    preview.value = null;
    loadSources();
    loadStatus();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
function editSource(s: Source) {
  form.value = { id: s.id, channel: s.channel, enabled: s.enabled, dropAuthor: s.dropAuthor, mediaOnly: s.mediaOnly, maxPerRun: s.maxPerRun, blockWords: s.blockWords, backfill: 0 };
  preview.value = null;
}
async function removeSource(s: Source) {
  if (!confirm(`删除来源 @${s.channel}？已转发到目标频道的消息不会删除`)) return;
  await api(`/admin/tg-forward/sources/${s.id}`, { method: 'DELETE' });
  loadSources();
  loadStatus();
}
async function syncNow(s: Source, backfill = 0) {
  if (backfill) {
    const n = prompt('把最近几条转到目标频道？（1~20，不看游标）', '3');
    if (n === null) return;
    backfill = Math.min(20, Math.max(1, Number(n) || 3));
  }
  syncing.value = s.id;
  try {
    const r = await api<{ started: boolean }>(`/admin/tg-forward/sources/${s.id}/sync${backfill ? `?backfill=${backfill}` : ''}`, { method: 'POST' });
    emit('toast', r.started ? '已开始转发，每条间隔 2.5 秒…' : '已有任务在跑，等它结束');
    const before = s.forwardedCount;
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      await loadSources();
      const cur = sources.value.find((x) => x.id === s.id);
      if (cur && !cur.syncing) {
        emit('toast', cur.lastError ? `出错：${cur.lastError}` : `完成：转发了 ${cur.forwardedCount - before} 条`);
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
onMounted(() => { loadStatus(); loadSources(); });
</script>

<template>
  <div>
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">频道转发 · 目标频道</div>
      <div class="muted" style="margin-bottom: 12px">
        推广用：把下面来源频道里的新消息，用已登录的 Telegram 账号<b>转发到你自己的频道</b>。<b>和 App 内容无关</b>，不会进树洞 / 养眼图片。
        账号必须是目标频道的<b>管理员</b>并有「发布消息」权限。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">目标频道 <input v-model="targetInput" placeholder="smsd2030 或 https://t.me/smsd2030" style="width: 300px" @keydown.enter="saveTarget" /></label>
        <button class="small" :disabled="savingTarget || !props.loggedIn" @click="saveTarget">{{ savingTarget ? '校验中…' : '保存' }}</button>
        <span v-if="!props.loggedIn" class="muted" style="color: #ffb020">先登录 Telegram 账号</span>
      </div>
      <div v-if="status" style="margin-top: 10px; font-size: 13px">
        <span v-if="status.title">
          <a :href="`https://t.me/${status.target}`" target="_blank" style="color: var(--accent)">@{{ status.target }}</a>
          「{{ status.title }}」 · {{ status.subscribers.toLocaleString() }} 订阅 ·
          <span class="tag" :class="status.canPost ? 'ok' : 'off'">{{ status.canPost ? '账号可发布' : '账号无发布权限' }}</span>
        </span>
        <span v-if="status.error" style="color: #ff6b6b; margin-left: 8px">{{ status.error }}</span>
      </div>
    </div>

    <div class="card" style="margin-top: 12px">
      <div style="font-weight: 600; margin-bottom: 6px">来源频道（可多个）</div>
      <div class="muted" style="margin-bottom: 12px">
        填频道 → 点<b>「解析」</b>核对 → 添加。添加后只转<b>之后新发</b>的消息（每 10 分钟查一次，每轮最多「每轮上限」条，相册算 1 条）；「补最近 N 条」可以立刻转几条看效果。
        「隐藏转发来源」= 去掉「转发自 xx」头，像自己发的；开了「禁止转发」的频道加不了。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">频道 <input v-model="form.channel" placeholder="频道用户名 或 https://t.me/xxx" style="width: 280px" @keydown.enter="doPreview" /></label>
        <label class="muted">每轮上限 <input v-model.number="form.maxPerRun" type="number" min="1" max="20" style="width: 60px" /> 条</label>
        <label class="muted">屏蔽词 <input v-model="form.blockWords" placeholder="逗号分隔，含这些词的不转" style="width: 220px" /></label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="form.dropAuthor" type="checkbox" style="width: auto" /> 隐藏转发来源</label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="form.mediaOnly" type="checkbox" style="width: auto" /> 只转带图 / 视频的</label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="form.enabled" type="checkbox" style="width: auto" /> 启用</label>
        <label v-if="!form.id" class="muted">添加后先补最近 <input v-model.number="form.backfill" type="number" min="0" max="20" style="width: 50px" /> 条</label>
        <button class="small ghost" :disabled="previewing || !props.loggedIn" @click="doPreview">{{ previewing ? '解析中…' : '解析' }}</button>
        <button class="small" :disabled="!preview || preview.noforwards" @click="saveSource">{{ form.id ? '保存修改' : '添加来源' }}</button>
        <button v-if="form.id" class="small ghost" @click="form = emptyForm(); preview = null">取消编辑</button>
      </div>

      <div v-if="preview" style="margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <div class="row" style="gap: 10px; align-items: baseline">
          <span style="font-size: 16px; font-weight: 600">{{ preview.title }}</span>
          <span class="muted">@{{ preview.channel }} · {{ preview.subscribers.toLocaleString() }} 订阅 · 最新 #{{ preview.latestMsgId }}</span>
          <span v-if="preview.noforwards" class="tag off">禁止转发，加不了</span>
        </div>
        <div v-if="preview.about" class="muted" style="margin-top: 4px; white-space: pre-wrap; font-size: 12px">{{ preview.about }}</div>
        <div class="muted" style="margin: 8px 0">最近的消息：</div>
        <div v-for="s in preview.samples" :key="s.msgId" class="row" style="padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px">
          <span style="flex: 1">{{ s.text || '（无文字）' }} <span v-if="s.media" class="muted">· {{ s.media }} 个媒体</span></span>
          <span class="muted" style="flex-shrink: 0">{{ fmt(s.date) }} · #{{ s.msgId }}</span>
        </div>
      </div>

      <table v-if="sources.length" style="margin-top: 14px">
        <thead><tr><th>频道</th><th>标题</th><th>订阅</th><th>状态</th><th>设置</th><th>已转发</th><th>上次检查</th><th>错误</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sources" :key="s.id">
            <td><a :href="`https://t.me/${s.channel}`" target="_blank" style="color: var(--accent)">@{{ s.channel }}</a></td>
            <td>{{ s.title }}</td>
            <td class="muted">{{ s.subscribers.toLocaleString() }}</td>
            <td><span class="tag" :class="s.enabled ? 'ok' : 'off'">{{ s.enabled ? '启用' : '停用' }}</span></td>
            <td class="muted" style="font-size: 12px">
              每轮 {{ s.maxPerRun }} 条{{ s.dropAuthor ? ' · 隐藏来源' : '' }}{{ s.mediaOnly ? ' · 只带媒体' : '' }}{{ s.blockWords ? ` · 屏蔽「${s.blockWords}」` : '' }}
            </td>
            <td>{{ s.forwardedCount }} <span class="muted">(至 #{{ s.lastMsgId }})</span></td>
            <td class="muted">{{ s.lastSyncAt ? fmt(s.lastSyncAt) : '—' }}</td>
            <td class="muted" style="max-width: 220px; color: #ff6b6b">{{ s.lastError }}</td>
            <td>
              <div class="row">
                <button class="small" :disabled="syncing === s.id || s.syncing || !props.loggedIn" @click="syncNow(s)">{{ syncing === s.id || s.syncing ? '转发中…' : '立即检查' }}</button>
                <button class="small ghost" :disabled="syncing === s.id || s.syncing || !props.loggedIn" @click="syncNow(s, 1)">补最近 N 条</button>
                <button class="small ghost" @click="editSource(s)">编辑</button>
                <button class="small ghost" @click="removeSource(s)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted" style="margin-top: 10px">还没有来源</div>
    </div>
  </div>
</template>
