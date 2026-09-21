<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const props = defineProps<{ loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'toast', t: string): void }>();

// ---------- 设置：tab 名称 / 保留天数 ----------
const settings = ref({ titleM: '养眼图片', titleF: '养眼图片', daysM: 3, daysF: 3, hideTextM: true, hideTextF: false });
const savingSettings = ref(false);
async function loadSettings() {
  settings.value = await api('/admin/gallery/settings');
}
async function saveSettings() {
  savingSettings.value = true;
  try {
    settings.value = await api('/admin/gallery/settings', { method: 'PUT', body: settings.value });
    emit('toast', '已保存，tab 名称 / 保留天数 / 屏蔽文字即时生效');
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    savingSettings.value = false;
  }
}

// ---------- 来源（按受众） ----------
interface Source {
  id: number; channel: string; title: string; subscribers: number; audience: number; enabled: boolean; blockWords: string;
  lastMsgId: number; lastSyncAt: string | null; lastError: string; importedCount: number; syncing?: boolean;
}
interface Preview {
  channel: string; title: string; subscribers: number; about: string;
  scanned: number; photos: number; videos: number; posts: number;
  samples: { msgId: number; text: string; photos: number; videos: number; date: string }[];
}
const sources = ref<Source[]>([]);
const srcForm = ref<{ id?: number; channel: string; audience: number; enabled: boolean; blockWords: string }>({ channel: '', audience: 1, enabled: true, blockWords: '' });
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const syncing = ref<number | null>(null);

function normalize(raw: string) {
  return raw.trim().replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
}
async function loadSources() {
  sources.value = await api<Source[]>('/admin/gallery/sources');
}
async function doPreview() {
  if (!srcForm.value.channel.trim()) return emit('toast', '请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api<Preview>(`/admin/gallery/sources/preview?channel=${encodeURIComponent(srcForm.value.channel)}`);
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  if (!preview.value || preview.value.channel.toLowerCase() !== normalize(srcForm.value.channel).toLowerCase()) {
    return emit('toast', '请先点「解析」核对频道标题和内容，再保存');
  }
  if (srcForm.value.id) {
    const old = sources.value.find((s) => s.id === srcForm.value.id);
    if (old && (old.channel.toLowerCase() !== preview.value.channel.toLowerCase() || old.audience !== srcForm.value.audience)
      && !confirm(`换成 @${preview.value.channel}「${preview.value.title}」？旧频道已同步的图片/视频会全部删除`)) return;
  }
  try {
    await api('/admin/gallery/sources', { method: 'POST', body: srcForm.value });
    srcForm.value = { channel: '', audience: srcForm.value.audience, enabled: true, blockWords: '' };
    preview.value = null;
    emit('toast', '已保存，每 10 分钟自动同步一次；可点「立即同步」');
    loadSources();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
function editSource(s: Source) {
  srcForm.value = { id: s.id, channel: s.channel, audience: s.audience, enabled: s.enabled, blockWords: s.blockWords ?? '' };
  preview.value = null;
}
async function removeSource(s: Source) {
  if (!confirm(`删除来源 @${s.channel}？已同步的图片/视频会一起删除`)) return;
  await api(`/admin/gallery/sources/${s.id}`, { method: 'DELETE' });
  loadSources();
  loadPosts();
}
async function syncNow(s: Source) {
  syncing.value = s.id;
  try {
    const r = await api<{ started: boolean }>(`/admin/gallery/sources/${s.id}/sync`, { method: 'POST' });
    emit('toast', r.started ? '已开始后台同步，下载图片/视频需要一会…' : '已有同步任务在跑，等它结束');
    const before = s.importedCount;
    for (let i = 0; i < 240; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      await loadSources();
      const cur = sources.value.find((x) => x.id === s.id);
      if (cur && !cur.syncing) {
        emit('toast', cur.lastError ? `同步出错：${cur.lastError}` : `同步完成：新增 ${cur.importedCount - before} 条`);
        loadPosts();
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

// ---------- 已同步帖子 ----------
interface Post {
  id: string; audience: number; text: string; viewCount: number; postedAt: string;
  media: { type: 'image' | 'video'; url: string; cover?: string; duration?: number }[];
}
const posts = ref<Post[]>([]);
const postFilter = ref<'' | '1' | '2'>('');
async function loadPosts() {
  posts.value = await api<Post[]>(`/admin/gallery/posts${postFilter.value ? `?audience=${postFilter.value}` : ''}`);
}
async function deletePost(p: Post) {
  if (!confirm('删除这条（连图片/视频文件）？')) return;
  await api(`/admin/gallery/posts/${p.id}/delete`, { method: 'POST' });
  loadPosts();
}
async function purge() {
  const r = await api<{ removed: number }>('/admin/gallery/purge', { method: 'POST' });
  emit('toast', `已清理 ${r.removed} 条过期内容`);
  loadPosts();
}

function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const aud = (a: number) => (a === 2 ? '女用户看' : '男用户看');
onMounted(() => { loadSettings(); loadSources(); loadPosts(); });
</script>

<template>
  <div>
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">养眼图片 · 设置</div>
      <div class="muted" style="margin-bottom: 12px">
        大厅里的一个 tab，<b>男用户看「男用户看」来源的内容，女用户看「女用户看」来源的内容</b>；tab 名称、保留天数、是否屏蔽文字都按男/女分开设。频道里的图片 / 视频（相册合成一条）转存到自己服务器，
        超过保留天数的连文件删除。用户端最新的在最底部（像聊天记录），往上滑加载更早的。
        <br />「屏蔽文字」勾上后用户端只看图 / 视频，不显示频道文案（下发时去掉，不改库，随时可切回）；默认男频屏蔽、女频不屏蔽。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px 24px; align-items: center">
        <span class="tag ok">男用户</span>
        <label class="muted">tab 名 <input v-model="settings.titleM" maxlength="12" style="width: 130px" /></label>
        <label class="muted">保留天数 <input v-model.number="settings.daysM" type="number" min="1" max="60" style="width: 70px" /></label>
        <label class="muted" style="display: inline-flex; align-items: center; gap: 6px"><input v-model="settings.hideTextM" type="checkbox" /> 屏蔽文字</label>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px 24px; align-items: center; margin-top: 10px">
        <span class="tag warn">女用户</span>
        <label class="muted">tab 名 <input v-model="settings.titleF" maxlength="12" style="width: 130px" /></label>
        <label class="muted">保留天数 <input v-model.number="settings.daysF" type="number" min="1" max="60" style="width: 70px" /></label>
        <label class="muted" style="display: inline-flex; align-items: center; gap: 6px"><input v-model="settings.hideTextF" type="checkbox" /> 屏蔽文字</label>
        <button class="small" :disabled="savingSettings" @click="saveSettings">保存设置</button>
      </div>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">养眼图片 · 频道来源</div>
      <div class="muted" style="margin-bottom: 12px">
        填频道 → 选受众 → 先点<b>「解析」</b>看标题、订阅数、最近的图片/视频数量对不对得上 → 再保存。同一受众可以有多个来源（内容混排）。
        <br />文案里的广告会自动过滤（带链接 / @ 的行、VPN / 防走丢 / 广告联系 / 投稿 / 👉 / 加群 / 下载 等），只删文字不删图；频道有自己的套路就填「屏蔽词」补充。<b>换频道 = 旧频道内容连文件全部清掉</b>，新频道从头同步。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">频道 <input v-model="srcForm.channel" placeholder="xxx 或 https://t.me/xxx" style="width: 260px" @keydown.enter="doPreview" /></label>
        <label class="muted">受众
          <select v-model.number="srcForm.audience" style="width: 120px">
            <option :value="1">男用户看</option>
            <option :value="2">女用户看</option>
          </select>
        </label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.enabled" type="checkbox" style="width: auto" /> 启用</label>
        <label class="muted">屏蔽词 <input v-model="srcForm.blockWords" placeholder="逗号分隔，含则整行删（补充内置广告过滤）" style="width: 260px" /></label>
        <button class="small ghost" :disabled="previewing || !props.loggedIn" @click="doPreview">{{ previewing ? '解析中…' : '解析' }}</button>
        <button class="small" :disabled="!preview" @click="saveSource">{{ srcForm.id ? '保存修改' : '添加来源' }}</button>
        <button v-if="srcForm.id" class="small ghost" @click="srcForm = { channel: '', audience: 1, enabled: true, blockWords: '' }; preview = null">取消编辑</button>
        <span v-if="!props.loggedIn" class="muted" style="color: #ffb020">先登录 Telegram 账号才能解析</span>
      </div>

      <div v-if="preview" style="margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <div class="row" style="gap: 10px; align-items: baseline">
          <span style="font-size: 16px; font-weight: 600">{{ preview.title }}</span>
          <span class="muted">@{{ preview.channel }} · {{ preview.subscribers.toLocaleString() }} 订阅</span>
        </div>
        <div v-if="preview.about" class="muted" style="margin-top: 4px; white-space: pre-wrap; font-size: 12px">{{ preview.about }}</div>
        <div class="muted" style="margin: 8px 0">最近 {{ preview.scanned }} 条消息：<b style="color: var(--accent)">{{ preview.photos }}</b> 张图片、<b style="color: var(--accent)">{{ preview.videos }}</b> 个视频，合 {{ preview.posts }} 条帖子（相册算一条）。最新几条：</div>
        <div v-if="preview.posts === 0" class="muted">这个频道最近没有图片/视频</div>
        <div v-for="s in preview.samples" :key="s.msgId" class="row" style="padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px">
          <span style="flex: 1; white-space: pre-wrap">{{ s.text || '（无文字）' }}</span>
          <span class="muted" style="flex-shrink: 0">{{ s.photos }} 图 {{ s.videos }} 视频 · {{ fmt(s.date) }} · #{{ s.msgId }}</span>
        </div>
      </div>

      <table v-if="sources.length" style="margin-top: 14px">
        <thead><tr><th>受众</th><th>频道</th><th>标题</th><th>订阅</th><th>状态</th><th>已导入</th><th>上次同步</th><th>错误</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sources" :key="s.id">
            <td><span class="tag" :class="s.audience === 2 ? 'warn' : 'ok'">{{ aud(s.audience) }}</span></td>
            <td><a :href="`https://t.me/${s.channel}`" target="_blank" style="color: var(--accent)">@{{ s.channel }}</a></td>
            <td style="max-width: 220px">{{ s.title }}</td>
            <td class="muted">{{ s.subscribers.toLocaleString() }}</td>
            <td><span class="tag" :class="s.enabled ? 'ok' : 'off'">{{ s.enabled ? '启用' : '停用' }}</span></td>
            <td>{{ s.importedCount }} <span class="muted">(至 #{{ s.lastMsgId }})</span></td>
            <td class="muted">{{ s.lastSyncAt ? fmt(s.lastSyncAt) : '—' }}</td>
            <td class="muted" style="max-width: 200px; color: #ff6b6b">{{ s.lastError }}</td>
            <td>
              <div class="row">
                <button class="small" :disabled="syncing === s.id || s.syncing || !props.loggedIn" @click="syncNow(s)">{{ syncing === s.id || s.syncing ? '同步中…' : '立即同步' }}</button>
                <button class="small ghost" @click="editSource(s)">编辑</button>
                <button class="small ghost" @click="removeSource(s)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted" style="margin-top: 10px">还没有来源</div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">已同步内容（{{ posts.length }}）</div>
        <select v-model="postFilter" @change="loadPosts()">
          <option value="">全部</option>
          <option value="1">男用户看</option>
          <option value="2">女用户看</option>
        </select>
        <button class="small ghost" @click="purge">清理过期</button>
        <button class="small ghost" @click="loadPosts">刷新</button>
      </div>
      <table>
        <thead><tr><th>受众</th><th style="min-width: 260px">媒体</th><th style="min-width: 200px">文字</th><th>阅读</th><th>发布时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="p in posts" :key="p.id">
            <td><span class="tag" :class="p.audience === 2 ? 'warn' : 'ok'">{{ aud(p.audience) }}</span></td>
            <td>
              <div class="row" style="gap: 4px; flex-wrap: wrap">
                <div v-for="(m, i) in p.media.slice(0, 6)" :key="i" style="position: relative">
                  <img :src="m.type === 'video' ? (m.cover || '') : m.url" style="width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: #2a2a30" />
                  <span v-if="m.type === 'video'" style="position: absolute; left: 4px; top: 4px; font-size: 10px; background: rgba(0,0,0,0.6); color: #fff; padding: 0 4px; border-radius: 4px">▶ {{ m.duration ? Math.floor(m.duration / 60) + ':' + String(m.duration % 60).padStart(2, '0') : '视频' }}</span>
                </div>
                <span v-if="p.media.length > 6" class="muted">+{{ p.media.length - 6 }}</span>
              </div>
            </td>
            <td class="muted" style="max-width: 320px; white-space: pre-wrap; font-size: 12px">{{ p.text.length > 120 ? p.text.slice(0, 120) + '…' : p.text }}</td>
            <td class="muted">{{ p.viewCount }}</td>
            <td class="muted">{{ fmt(p.postedAt) }}</td>
            <td><button class="small ghost" @click="deletePost(p)">删除</button></td>
          </tr>
          <tr v-if="posts.length === 0"><td colspan="6" class="muted">暂无内容（登录 Telegram、添加来源后点「立即同步」）</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
