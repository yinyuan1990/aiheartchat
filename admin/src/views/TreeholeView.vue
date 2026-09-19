<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, getToken } from '../api';

interface Post {
  id: string;
  /** 0=用户投稿 1=后台录入 2=Telegram 同步 */
  source: number;
  content: string;
  images: string[];
  viewCount: number;
  commentCount: number;
  /** 0=显示 1=隐藏 */
  status: number;
  createdAt: string;
  author: { id: string; nickname: string; shortId: string | null } | null;
}

interface Comment {
  id: string;
  content: string;
  status: number;
  createdAt: string;
  user: { id: string; nickname: string; shortId: string | null; avatar: string } | null;
}

const posts = ref<Post[]>([]);
const filter = ref<'' | '0' | '1'>('');
const hasMore = ref(false);
const toast = ref('');

const draft = ref('');
const draftImages = ref<string[]>([]);
const editing = ref<Post | null>(null);
const editContent = ref('');
const editImages = ref<string[]>([]);
const uploading = ref(false);

// ---------- Telegram 频道自动同步 ----------
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
  if (!srcForm.value.channel.trim()) return showToast('请填写频道用户名');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api(`/admin/treehole/sources/preview?channel=${encodeURIComponent(srcForm.value.channel)}`);
  } catch (e: any) {
    showToast(e.message);
  } finally {
    previewing.value = false;
  }
}
async function saveSource() {
  try {
    await api('/admin/treehole/sources', { method: 'POST', body: srcForm.value });
    srcForm.value = { channel: '', enabled: true, minViews: 0, stripLinks: true, blockWords: '' };
    preview.value = null;
    showToast('已保存，每 10 分钟自动同步一次');
    loadSources();
  } catch (e: any) {
    showToast(e.message);
  }
}
function editSource(s: Source) {
  srcForm.value = { id: s.id, channel: s.channel, enabled: s.enabled, minViews: s.minViews, stripLinks: s.stripLinks, blockWords: s.blockWords };
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
    showToast(`同步完成：新增 ${r.imported} 条，跳过 ${r.skipped} 条`);
    loadSources();
    load();
  } catch (e: any) {
    showToast(e.message);
    loadSources();
  } finally {
    syncing.value = null;
  }
}

// ---------- 配图上传（后台 token） ----------
async function uploadImages(e: Event, target: 'draft' | 'edit') {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  const arr = target === 'draft' ? draftImages : editImages;
  if (!files.length) return;
  uploading.value = true;
  try {
    for (const f of files.slice(0, 9 - arr.value.length)) {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch('/api/upload/admin-image', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.msg || '上传失败');
      arr.value = [...arr.value, json.data.url];
    }
  } catch (err: any) {
    showToast(err.message);
  } finally {
    uploading.value = false;
  }
}
function removeImage(target: 'draft' | 'edit', url: string) {
  const arr = target === 'draft' ? draftImages : editImages;
  arr.value = arr.value.filter((u) => u !== url);
}

const expanded = ref<string | null>(null);
const comments = ref<Comment[]>([]);

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load(more = false) {
  const before = more && posts.value.length ? `&beforeId=${posts.value[posts.value.length - 1].id}` : '';
  const list = await api<Post[]>(`/admin/treehole?status=${filter.value}${before}`);
  posts.value = more ? [...posts.value, ...list] : list;
  hasMore.value = list.length >= 50;
}
onMounted(() => { load(); loadSources(); });

async function create() {
  if (!draft.value.trim() && draftImages.value.length === 0) {
    showToast('请输入内容或配图');
    return;
  }
  try {
    await api('/admin/treehole', { method: 'POST', body: { content: draft.value, images: draftImages.value } });
    draft.value = '';
    draftImages.value = [];
    showToast('已发布');
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

function startEdit(p: Post) {
  editing.value = p;
  editContent.value = p.content;
  editImages.value = [...(p.images ?? [])];
}

async function saveEdit() {
  if (!editing.value) return;
  try {
    await api(`/admin/treehole/${editing.value.id}`, { method: 'POST', body: { content: editContent.value, images: editImages.value } });
    editing.value = null;
    showToast('已保存');
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggle(p: Post) {
  await api(`/admin/treehole/${p.id}/status`, { method: 'POST', body: { status: p.status === 0 ? 1 : 0 } });
  load();
}

async function showComments(p: Post) {
  if (expanded.value === p.id) {
    expanded.value = null;
    return;
  }
  expanded.value = p.id;
  comments.value = await api<Comment[]>(`/admin/treehole/${p.id}/comments`);
}

async function deleteComment(c: Comment) {
  await api(`/admin/treehole/comments/${c.id}/delete`, { method: 'POST' });
  if (expanded.value) comments.value = await api<Comment[]>(`/admin/treehole/${expanded.value}/comments`);
  load();
}

function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div>
    <div class="page-title">私密树洞</div>

    <!-- Telegram 频道自动同步 -->
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">Telegram 频道自动同步</div>
      <div class="muted" style="margin-bottom: 12px">
        不用是管理员、不用 Bot：只要频道是<b>公开频道</b>（有 t.me/xxx 这样的用户名），服务器每 10 分钟抓一次网页预览，把新帖子的<b>文字 + 图片</b>匿名同步进树洞（图片转存到自己的服务器）。
        私有群组 / 没有用户名的频道抓不到。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">频道 <input v-model="srcForm.channel" placeholder="xxx 或 https://t.me/xxx" style="width: 220px" /></label>
        <label class="muted">阅读数 ≥ <input v-model.number="srcForm.minViews" type="number" min="0" style="width: 80px" /></label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.stripLinks" type="checkbox" style="width: auto" /> 去掉含 @ / 链接的行</label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px"><input v-model="srcForm.enabled" type="checkbox" style="width: auto" /> 启用</label>
        <label class="muted">屏蔽词 <input v-model="srcForm.blockWords" placeholder="逗号分隔，含则跳过" style="width: 200px" /></label>
        <button class="small ghost" :disabled="previewing" @click="doPreview">{{ previewing ? '抓取中…' : '预览' }}</button>
        <button class="small" @click="saveSource">{{ srcForm.id ? '保存修改' : '添加来源' }}</button>
        <button v-if="srcForm.id" class="small ghost" @click="srcForm = { channel: '', enabled: true, minViews: 0, stripLinks: true, blockWords: '' }">取消编辑</button>
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
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">手动录入一条</div>
      <div class="muted" style="margin-bottom: 10px">以「私密树洞」官方身份匿名发布，玩家在大厅「私密树洞」tab 可见并评论。支持换行，可配最多 9 张图。</div>
      <textarea v-model="draft" rows="6" placeholder="输入树洞内容…" style="width: 100%; max-width: 720px; line-height: 1.6"></textarea>
      <div class="row" style="margin-top: 8px; gap: 6px; flex-wrap: wrap">
        <div v-for="u in draftImages" :key="u" style="position: relative">
          <img :src="u" style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px" />
          <span @click="removeImage('draft', u)" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; background: #000; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer">×</span>
        </div>
        <label v-if="draftImages.length < 9" class="muted" style="width: 72px; height: 72px; border: 1px dashed var(--line); border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 22px">
          {{ uploading ? '…' : '+' }}<input type="file" accept="image/*" multiple hidden @change="uploadImages($event, 'draft')" />
        </label>
      </div>
      <div class="row" style="margin-top: 10px">
        <button @click="create">发布</button>
        <span class="muted">{{ draft.length }} / 3000</span>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <div style="font-weight: 600">帖子列表</div>
        <select v-model="filter" @change="load()">
          <option value="">全部</option>
          <option value="0">显示中</option>
          <option value="1">已隐藏</option>
        </select>
        <span class="muted">用户投稿匿名展示，后台可见投稿人；违规内容点「隐藏」即下架</span>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>来源</th><th style="min-width: 320px">内容</th><th>阅读</th><th>评论</th><th>时间</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <template v-for="p in posts" :key="p.id">
            <tr>
              <td>{{ p.id }}</td>
              <td>
                <span v-if="p.source === 1" class="tag ok">后台</span>
                <span v-else-if="p.source === 2" class="tag ok" style="background: rgba(90,169,255,0.15); color: #5aa9ff">TG 同步</span>
                <span v-else class="tag warn" :title="p.author ? `${p.author.nickname}（${p.author.shortId ?? p.author.id}）` : ''">
                  投稿 · {{ p.author?.nickname ?? '未知' }}
                </span>
              </td>
              <td class="muted" style="max-width: 520px; white-space: pre-wrap; line-height: 1.5">
                <div v-if="p.images?.length" class="row" style="gap: 4px; margin-bottom: 6px">
                  <img v-for="u in p.images.slice(0, 4)" :key="u" :src="u" style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px" />
                  <span v-if="p.images.length > 4" class="muted">+{{ p.images.length - 4 }}</span>
                </div>
                {{ p.content.length > 160 ? p.content.slice(0, 160) + '…' : p.content }}
              </td>
              <td>{{ p.viewCount }}</td>
              <td>{{ p.commentCount }}</td>
              <td class="muted">{{ fmt(p.createdAt) }}</td>
              <td><span class="tag" :class="p.status === 0 ? 'ok' : 'off'">{{ p.status === 0 ? '显示' : '隐藏' }}</span></td>
              <td>
                <div class="row">
                  <button v-if="p.source !== 0" class="small ghost" @click="startEdit(p)">编辑</button>
                  <button class="small ghost" @click="toggle(p)">{{ p.status === 0 ? '隐藏' : '恢复' }}</button>
                  <button class="small ghost" @click="showComments(p)">{{ expanded === p.id ? '收起' : '评论' }}</button>
                </div>
              </td>
            </tr>
            <tr v-if="expanded === p.id">
              <td colspan="8" style="background: rgba(255,255,255,0.02)">
                <div v-if="comments.length === 0" class="muted">暂无评论</div>
                <div v-for="c in comments" :key="c.id" class="row" style="padding: 6px 0; align-items: flex-start">
                  <img v-if="c.user?.avatar" :src="c.user.avatar" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover" />
                  <div v-else style="width: 28px; height: 28px; border-radius: 50%; background: #2a2a30"></div>
                  <div style="flex: 1">
                    <div class="muted">
                      {{ c.user?.nickname ?? '用户' }} <span style="opacity: 0.6">({{ c.user?.shortId ?? c.user?.id }})</span> · {{ fmt(c.createdAt) }}
                      <span v-if="c.status === 1" class="tag off" style="margin-left: 6px">已删</span>
                    </div>
                    <div style="white-space: pre-wrap; line-height: 1.5" :style="c.status === 1 ? 'text-decoration: line-through; opacity: 0.5' : ''">{{ c.content }}</div>
                  </div>
                  <button v-if="c.status === 0" class="small ghost" @click="deleteComment(c)">删除</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="posts.length === 0"><td colspan="8" class="muted">暂无内容</td></tr>
        </tbody>
      </table>
      <div v-if="hasMore" class="row" style="margin-top: 12px; justify-content: center">
        <button class="small ghost" @click="load(true)">加载更多</button>
      </div>
    </div>

    <div v-if="editing" class="card">
      <div class="page-title" style="font-size: 15px">编辑 #{{ editing.id }}</div>
      <textarea v-model="editContent" rows="8" style="width: 100%; max-width: 720px; line-height: 1.6"></textarea>
      <div class="row" style="margin-top: 8px; gap: 6px; flex-wrap: wrap">
        <div v-for="u in editImages" :key="u" style="position: relative">
          <img :src="u" style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px" />
          <span @click="removeImage('edit', u)" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; background: #000; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer">×</span>
        </div>
        <label v-if="editImages.length < 9" class="muted" style="width: 72px; height: 72px; border: 1px dashed var(--line); border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 22px">
          {{ uploading ? '…' : '+' }}<input type="file" accept="image/*" multiple hidden @change="uploadImages($event, 'edit')" />
        </label>
      </div>
      <div class="row" style="margin-top: 12px">
        <button @click="saveEdit">保存</button>
        <button class="ghost" @click="editing = null">取消</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
