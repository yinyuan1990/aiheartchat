<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

// ---------- Telegram 账号 ----------
interface TgStatus {
  apiId: number;
  customApi: boolean;
  loggedIn: boolean;
  user: { id: string; firstName: string; username: string; phone: string } | null;
  pendingPhone: string;
  error: string;
}
const tg = ref<TgStatus | null>(null);
const apiForm = ref({ apiId: '', apiHash: '' });
const showApi = ref(false);
const phone = ref('');
const code = ref('');
const password = ref('');
const needPassword = ref(false);
const codeSent = ref(false);
const busy = ref('');

async function loadTg() {
  try {
    tg.value = await api<TgStatus>('/admin/telegram/status');
    if (tg.value.pendingPhone && !codeSent.value) { phone.value = tg.value.pendingPhone; codeSent.value = true; }
  } catch (e: any) {
    showToast(e.message);
  }
}
async function saveApi() {
  busy.value = 'api';
  try {
    tg.value = await api<TgStatus>('/admin/telegram/api', { method: 'PUT', body: apiForm.value });
    showToast('已保存');
    showApi.value = false;
  } catch (e: any) {
    showToast(e.message);
  } finally {
    busy.value = '';
  }
}
async function sendCode() {
  busy.value = 'code';
  try {
    const r = await api<{ viaApp: boolean }>('/admin/telegram/send-code', { method: 'POST', body: { phone: phone.value } });
    codeSent.value = true;
    needPassword.value = false;
    showToast(r.viaApp ? '验证码已发到你已登录的 Telegram App 里' : '验证码已通过短信发送');
  } catch (e: any) {
    showToast(e.message);
  } finally {
    busy.value = '';
  }
}
async function signIn() {
  busy.value = 'signin';
  try {
    const r = await api<any>('/admin/telegram/sign-in', { method: 'POST', body: { code: code.value, password: password.value || undefined } });
    if (r.needPassword) {
      needPassword.value = true;
      showToast('该账号开了两步验证，请输入密码');
      return;
    }
    tg.value = r;
    codeSent.value = false;
    code.value = ''; password.value = ''; needPassword.value = false;
    showToast('Telegram 已登录');
    loadSources();
  } catch (e: any) {
    showToast(e.message);
  } finally {
    busy.value = '';
  }
}
async function logoutTg() {
  if (!confirm('退出 Telegram 账号后音乐同步会停止，确定？')) return;
  busy.value = 'logout';
  try {
    tg.value = await api<TgStatus>('/admin/telegram/logout', { method: 'POST' });
    codeSent.value = false;
  } catch (e: any) {
    showToast(e.message);
  } finally {
    busy.value = '';
  }
}

// ---------- 来源 ----------
interface Source {
  id: number; channel: string; title: string; subscribers: number; enabled: boolean;
  lastMsgId: number; lastSyncAt: string | null; lastError: string; importedCount: number;
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

async function loadSources() {
  sources.value = await api<Source[]>('/admin/music/sources');
}
async function doPreview() {
  if (!srcForm.value.channel.trim()) return showToast('请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api<Preview>(`/admin/music/sources/preview?channel=${encodeURIComponent(srcForm.value.channel)}`);
  } catch (e: any) {
    showToast(e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  if (!preview.value || preview.value.channel.toLowerCase() !== normalize(srcForm.value.channel).toLowerCase()) {
    return showToast('请先点「解析」核对频道标题和曲目，再保存');
  }
  if (srcForm.value.id) {
    const old = sources.value.find((s) => s.id === srcForm.value.id);
    if (old && old.channel.toLowerCase() !== preview.value.channel.toLowerCase() && !confirm(`换成 @${preview.value.channel}「${preview.value.title}」？旧频道已同步的曲目会全部删除`)) return;
  }
  try {
    await api('/admin/music/sources', { method: 'POST', body: srcForm.value });
    srcForm.value = { channel: '', enabled: true };
    preview.value = null;
    showToast('已保存，每 10 分钟自动同步一次；可点「立即同步」');
    loadSources();
  } catch (e: any) {
    showToast(e.message);
  }
}
function normalize(raw: string) {
  return raw.trim().replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
}
function editSource(s: Source) {
  srcForm.value = { id: s.id, channel: s.channel, enabled: s.enabled };
  preview.value = null;
}
async function removeSource(s: Source) {
  if (!confirm(`删除来源 @${s.channel}？已同步的曲目和文件会一起删除`)) return;
  await api(`/admin/music/sources/${s.id}`, { method: 'DELETE' });
  loadSources();
  loadTracks();
}
async function syncNow(s: Source) {
  syncing.value = s.id;
  try {
    const r = await api<{ imported: number; skipped: number }>(`/admin/music/sources/${s.id}/sync`, { method: 'POST' });
    showToast(`同步完成：新增 ${r.imported} 首，跳过 ${r.skipped} 条`);
  } catch (e: any) {
    showToast(e.message);
  } finally {
    syncing.value = null;
    loadSources();
    loadTracks();
  }
}

// ---------- 曲目 ----------
interface Track {
  id: string; sourceId: number; title: string; performer: string; duration: number; size: number;
  url: string; cover: string; postedAt: string; playCount: number;
}
const tracks = ref<Track[]>([]);
const playing = ref<string | null>(null);
async function loadTracks() {
  tracks.value = await api<Track[]>('/admin/music/tracks');
}
async function deleteTrack(t: Track) {
  if (!confirm(`删除「${t.title}」？`)) return;
  await api(`/admin/music/tracks/${t.id}/delete`, { method: 'POST' });
  loadTracks();
}
async function purge() {
  const r = await api<{ removed: number }>('/admin/music/purge', { method: 'POST' });
  showToast(`已清理 ${r.removed} 首过期曲目`);
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

onMounted(() => { loadTg(); loadSources(); loadTracks(); });
</script>

<template>
  <div>
    <div class="page-title">音乐频道</div>

    <!-- Telegram 账号 -->
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">Telegram 账号</div>
      <div class="muted" style="margin-bottom: 12px">
        音乐频道里的是<b>音频文件</b>，Telegram 网页预览不提供文件下载（而且这类频道大多关闭了预览），所以要用一个普通 Telegram 账号登录后读取。
        只读频道，不会发消息。登录一次长期有效；换手机号登录 Telegram 时别把这个会话踢掉。
      </div>

      <div v-if="tg?.error" class="muted" style="color: #ff6b6b; margin-bottom: 8px">连接异常：{{ tg.error }}</div>

      <div v-if="tg?.loggedIn" class="row" style="gap: 12px; align-items: center">
        <span class="tag ok">已登录</span>
        <span>{{ tg.user?.firstName }} <span class="muted">{{ tg.user?.username ? '@' + tg.user.username : '' }} · {{ tg.user?.phone ? '+' + tg.user.phone : '' }}</span></span>
        <button class="small ghost" :disabled="busy === 'logout'" @click="logoutTg">退出账号</button>
      </div>

      <div v-else class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <span class="tag off">未登录</span>
        <label class="muted">手机号 <input v-model="phone" placeholder="+8613800000000" style="width: 180px" :disabled="codeSent" /></label>
        <button class="small" :disabled="busy === 'code'" @click="sendCode">{{ busy === 'code' ? '发送中…' : codeSent ? '重新发码' : '发送验证码' }}</button>
        <template v-if="codeSent">
          <label class="muted">验证码 <input v-model="code" placeholder="5 位数字" style="width: 100px" @keydown.enter="signIn" /></label>
          <label v-if="needPassword" class="muted">两步验证密码 <input v-model="password" type="password" style="width: 160px" @keydown.enter="signIn" /></label>
          <button class="small" :disabled="busy === 'signin'" @click="signIn">{{ busy === 'signin' ? '登录中…' : '登录' }}</button>
          <button class="small ghost" @click="codeSent = false; needPassword = false">换号</button>
        </template>
      </div>

      <div class="muted" style="margin-top: 12px; font-size: 12px">
        当前 api_id：{{ tg?.apiId ?? '…' }}{{ tg?.customApi ? '（自己申请的）' : '（内置 Telegram Desktop 公共值，能用；被限流时到 my.telegram.org 申请自己的填入）' }}
        <a style="color: var(--accent); cursor: pointer; margin-left: 8px" @click="showApi = !showApi">{{ showApi ? '收起' : '修改' }}</a>
      </div>
      <div v-if="showApi" class="row" style="margin-top: 8px; gap: 12px; flex-wrap: wrap">
        <label class="muted">api_id <input v-model="apiForm.apiId" placeholder="数字" style="width: 120px" /></label>
        <label class="muted">api_hash <input v-model="apiForm.apiHash" placeholder="32 位十六进制" style="width: 300px" /></label>
        <button class="small" :disabled="busy === 'api'" @click="saveApi">保存（两项留空 = 用内置值）</button>
      </div>
    </div>

    <!-- 来源 -->
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">频道来源</div>
      <div class="muted" style="margin-bottom: 12px">
        填频道用户名或 t.me 链接 → 先点<b>「解析」</b>看标题、订阅数、最近的曲目对不对得上 → 再保存。保存后每 10 分钟同步一次，只同步<b>最近 3 天</b>的音频，文件转存到自己服务器，过期自动删除。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">频道 <input v-model="srcForm.channel" placeholder="wenan_DJ866 或 https://t.me/wenan_DJ866" style="width: 300px" @keydown.enter="doPreview" /></label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.enabled" type="checkbox" style="width: auto" /> 启用</label>
        <button class="small ghost" :disabled="previewing || !tg?.loggedIn" @click="doPreview">{{ previewing ? '解析中…' : '解析' }}</button>
        <button class="small" :disabled="!preview" @click="saveSource">{{ srcForm.id ? '保存修改' : '添加来源' }}</button>
        <button v-if="srcForm.id" class="small ghost" @click="srcForm = { channel: '', enabled: true }; preview = null">取消编辑</button>
        <span v-if="!tg?.loggedIn" class="muted" style="color: #ffb020">先登录 Telegram 账号才能解析</span>
      </div>

      <div v-if="preview" style="margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <div class="row" style="gap: 10px; align-items: baseline">
          <span style="font-size: 16px; font-weight: 600">{{ preview.title }}</span>
          <span class="muted">@{{ preview.channel }} · {{ preview.subscribers.toLocaleString() }} 订阅</span>
        </div>
        <div v-if="preview.about" class="muted" style="margin-top: 4px; white-space: pre-wrap; font-size: 12px">{{ preview.about }}</div>
        <div class="muted" style="margin: 8px 0">最近 {{ preview.scanned }} 条音频消息里解析到 {{ preview.audioCount }} 首，其中 3 天内 <b style="color: var(--accent)">{{ preview.recentCount }}</b> 首会被同步：</div>
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
                <button class="small" :disabled="syncing === s.id || !tg?.loggedIn" @click="syncNow(s)">{{ syncing === s.id ? '同步中（下载较慢）…' : '立即同步' }}</button>
                <button class="small ghost" @click="editSource(s)">编辑</button>
                <button class="small ghost" @click="removeSource(s)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 曲目 -->
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">已同步曲目（{{ tracks.length }}）</div>
        <button class="small ghost" @click="purge">清理过期</button>
        <button class="small ghost" @click="loadTracks">刷新</button>
        <span class="muted">用户端「消息 → 音乐」看到的就是这些；发布超过 3 天自动删除</span>
      </div>
      <table>
        <thead><tr><th></th><th style="min-width: 260px">曲目</th><th>时长</th><th>大小</th><th>发布时间</th><th>播放</th><th>操作</th></tr></thead>
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
          <tr v-if="tracks.length === 0"><td colspan="7" class="muted">暂无曲目（登录 Telegram、添加来源后点「立即同步」）</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
