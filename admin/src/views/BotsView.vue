<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

/** 机器人：用户自己创建，第三方程序用 Telegram 兼容的 Bot API 收发消息；后台可封禁 / 删除 */
interface Bot {
  id: string; username: string; name: string; avatar: string; description: string;
  privacy: boolean; commands: { command: string; description: string }[]; webhookUrl: string;
  status: number; createdAt: string;
  owner: { id: string; nickname: string; shortId: string } | null;
  pendingUpdates: number; chats: number; lastError: string; lastErrorAt: string | null;
}

const list = ref<Bot[]>([]);
const q = ref('');

async function load() {
  list.value = await api<Bot[]>(`/admin/bots${q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ''}`);
}
async function toggleBan(b: Bot) {
  const ban = b.status === 0;
  if (!confirm(ban ? `封禁机器人 @${b.username}？token 立即失效，发不了消息` : `解封机器人 @${b.username}？`)) return;
  await api(`/admin/bots/${b.id}/status`, { method: 'POST', body: { banned: ban } });
  await load();
}
async function remove(b: Bot) {
  if (!confirm(`彻底删除机器人 @${b.username}？会退出所有群 / 频道，不能恢复`)) return;
  await api(`/admin/bots/${b.id}/delete`, { method: 'POST' });
  await load();
}

function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-title">机器人</div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <div style="font-weight: 600">全部机器人（{{ list.length }}）</div>
        <input v-model="q" placeholder="搜用户名" style="width: 200px" @keydown.enter="load" />
        <button class="small ghost" @click="load">搜索 / 刷新</button>
        <span class="muted">所有用户都能创建机器人（每人最多 20 个），第三方程序用 Telegram 兼容的 Bot API（/api/bot&lt;token&gt;/方法名）收发消息。封禁后 token 失效</span>
      </div>
      <table>
        <thead><tr><th></th><th style="min-width: 200px">机器人</th><th>创建者</th><th>接收方式</th><th>所在群/频道</th><th>待取消息</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in list" :key="b.id">
            <td>
              <img v-if="b.avatar" :src="b.avatar" style="width: 40px; height: 40px; border-radius: 20px; object-fit: cover" />
              <div v-else style="width: 40px; height: 40px; border-radius: 20px; background: #2a2a30"></div>
            </td>
            <td>
              <div>{{ b.name }} <span class="muted">@{{ b.username }}</span></div>
              <div class="muted" style="font-size: 12px; max-width: 320px; white-space: pre-wrap">{{ b.description || '（无简介）' }}</div>
              <div v-if="b.commands.length" class="muted" style="font-size: 12px">{{ b.commands.map((c) => '/' + c.command).join(' ') }}</div>
            </td>
            <td class="muted" style="font-size: 12px">{{ b.owner?.nickname }}<br />ID {{ b.owner?.shortId }}</td>
            <td class="muted" style="font-size: 12px; max-width: 240px; word-break: break-all">
              {{ b.webhookUrl ? 'Webhook ' + b.webhookUrl : 'getUpdates 轮询' }}
              <div v-if="b.lastError" style="color: var(--accent)">{{ fmt(b.lastErrorAt) }} {{ b.lastError }}</div>
            </td>
            <td>{{ b.chats }}</td>
            <td>{{ b.pendingUpdates }}</td>
            <td class="muted">{{ fmt(b.createdAt) }}</td>
            <td :style="b.status !== 0 ? 'color: var(--accent)' : ''">{{ b.status === 0 ? '正常' : '已封禁' }}</td>
            <td>
              <div class="row">
                <button class="small ghost" @click="toggleBan(b)">{{ b.status === 0 ? '封禁' : '解封' }}</button>
                <button class="small ghost" @click="remove(b)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="list.length === 0"><td colspan="9" class="muted">还没有机器人</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
