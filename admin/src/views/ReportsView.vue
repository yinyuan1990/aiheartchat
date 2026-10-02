<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

/** 举报：用户在聊天里长按别人的消息举报。内容是举报当时的快照，原消息被删了也能看 */
interface Brief { id: string; nickname: string; avatar: string; status: number }
interface Report {
  id: string; targetType: string; targetId: string; reason: string;
  status: number; result: string; createdAt: string;
  reporter: Brief | null; target: Brief | null;
  message: { type: string; content: string; convType: number | null; groupId: string | null; deleted: boolean } | null;
}

const list = ref<Report[]>([]);
const status = ref<'0' | '1' | ''>('0');
const more = ref(false);

const RESULT: Record<string, string> = { ignore: '已忽略', delete: '已删消息', ban: '已删消息并封号' };
const TYPE: Record<string, string> = { text: '文字', image: '图片', video: '视频', audio: '语音', sticker: '表情', location: '位置', gift: '礼物', call: '通话' };

async function load(append = false) {
  const before = append && list.value.length ? `&beforeId=${list.value[list.value.length - 1].id}` : '';
  const rows = await api<Report[]>(`/admin/reports?status=${status.value}${before}`);
  list.value = append ? [...list.value, ...rows] : rows;
  more.value = rows.length >= 30;
}
async function handle(r: Report, action: 'ignore' | 'delete' | 'ban') {
  const tips = { ignore: '忽略这条举报？', delete: '删除被举报的消息（双方都看不到）？', ban: `删除消息并封禁「${r.target?.nickname}」？` };
  if (!confirm(tips[action])) return;
  await api(`/admin/reports/${r.id}/handle`, { method: 'POST', body: { action } });
  await load();
}

function isMedia(r: Report, t: string) {
  return r.message?.type === t && /^https?:\/\//.test(r.message.content);
}
function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

onMounted(() => load());
</script>

<template>
  <div>
    <div class="page-title">举报</div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <select v-model="status" style="width: 140px" @change="load()">
          <option value="0">待处理</option>
          <option value="1">已处理</option>
          <option value="">全部</option>
        </select>
        <button class="small ghost" @click="load()">刷新</button>
        <span class="muted">用户长按聊天消息 → 举报。删除消息 = 为所有人删除；封号后对方无法登录发消息（可在用户管理里解封）</span>
      </div>
      <table>
        <thead><tr><th>时间</th><th>举报人</th><th>被举报人</th><th style="min-width: 260px">消息内容</th><th>原因</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td class="muted">{{ fmt(r.createdAt) }}</td>
            <td style="font-size: 12px">{{ r.reporter?.nickname ?? '—' }}<br /><span class="muted">ID {{ r.reporter?.id }}</span></td>
            <td style="font-size: 12px">
              {{ r.target?.nickname ?? '—' }}<br /><span class="muted">ID {{ r.target?.id }}</span>
              <div v-if="r.target?.status === 1" style="color: var(--accent)">已封禁</div>
            </td>
            <td>
              <template v-if="r.message">
                <div class="muted" style="font-size: 12px">
                  {{ TYPE[r.message.type] ?? r.message.type }} · {{ r.message.convType === 1 ? '单聊' : '群聊 ' + (r.message.groupId ?? '') }}
                  <span v-if="r.message.deleted" style="color: var(--accent)"> · 原消息已删除</span>
                </div>
                <img v-if="isMedia(r, 'image')" :src="r.message.content" style="max-width: 200px; max-height: 160px; border-radius: 6px" />
                <video v-else-if="isMedia(r, 'video')" :src="r.message.content" controls style="max-width: 240px; max-height: 160px" />
                <audio v-else-if="isMedia(r, 'audio')" :src="r.message.content" controls />
                <div v-else style="white-space: pre-wrap; word-break: break-all; max-width: 360px">{{ r.message.content || '（空）' }}</div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td style="max-width: 200px; white-space: pre-wrap">{{ r.reason }}</td>
            <td :style="r.status === 0 ? 'color: var(--accent)' : ''">{{ r.status === 0 ? '待处理' : RESULT[r.result] ?? '已处理' }}</td>
            <td>
              <div v-if="r.status === 0" class="row">
                <button class="small ghost" @click="handle(r, 'ignore')">忽略</button>
                <button class="small ghost" @click="handle(r, 'delete')">删消息</button>
                <button class="small ghost" @click="handle(r, 'ban')">删消息并封号</button>
              </div>
            </td>
          </tr>
          <tr v-if="list.length === 0"><td colspan="7" class="muted">没有举报</td></tr>
        </tbody>
      </table>
      <div v-if="more" style="margin-top: 12px"><button class="small ghost" @click="load(true)">加载更多</button></div>
    </div>
  </div>
</template>
