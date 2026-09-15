<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

interface Post {
  id: string;
  /** 0=用户投稿 1=后台录入 */
  source: number;
  content: string;
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
const editing = ref<Post | null>(null);
const editContent = ref('');

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
onMounted(load);

async function create() {
  if (!draft.value.trim()) {
    showToast('请输入内容');
    return;
  }
  try {
    await api('/admin/treehole', { method: 'POST', body: { content: draft.value } });
    draft.value = '';
    showToast('已发布');
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

function startEdit(p: Post) {
  editing.value = p;
  editContent.value = p.content;
}

async function saveEdit() {
  if (!editing.value) return;
  try {
    await api(`/admin/treehole/${editing.value.id}`, { method: 'POST', body: { content: editContent.value } });
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

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">手动录入一条</div>
      <div class="muted" style="margin-bottom: 10px">以「私密树洞」官方身份匿名发布，玩家在大厅「私密树洞」tab 可见并评论。支持换行。</div>
      <textarea v-model="draft" rows="6" placeholder="输入树洞内容…" style="width: 100%; max-width: 720px; line-height: 1.6"></textarea>
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
                <span v-else class="tag warn" :title="p.author ? `${p.author.nickname}（${p.author.shortId ?? p.author.id}）` : ''">
                  投稿 · {{ p.author?.nickname ?? '未知' }}
                </span>
              </td>
              <td class="muted" style="max-width: 520px; white-space: pre-wrap; line-height: 1.5">{{ p.content.length > 160 ? p.content.slice(0, 160) + '…' : p.content }}</td>
              <td>{{ p.viewCount }}</td>
              <td>{{ p.commentCount }}</td>
              <td class="muted">{{ fmt(p.createdAt) }}</td>
              <td><span class="tag" :class="p.status === 0 ? 'ok' : 'off'">{{ p.status === 0 ? '显示' : '隐藏' }}</span></td>
              <td>
                <div class="row">
                  <button v-if="p.source === 1" class="small ghost" @click="startEdit(p)">编辑</button>
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
      <div class="row" style="margin-top: 12px">
        <button @click="saveEdit">保存</button>
        <button class="ghost" @click="editing = null">取消</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
