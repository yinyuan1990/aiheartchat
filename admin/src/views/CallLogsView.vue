<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const list = ref<any[]>([]);
const loading = ref(false);
const hasMore = ref(true);
const detail = ref<any>(null);

const STATUS: Record<number, string> = { 0: '呼叫中', 1: '进行中', 2: '已结束', 3: '未接', 4: '拒绝', 5: '取消' };

async function load(more = false) {
  loading.value = true;
  try {
    const beforeId = more && list.value.length ? `?beforeId=${list.value[list.value.length - 1].id}` : '';
    const rows = await api<any[]>(`/admin/call-logs${beforeId}`);
    list.value = more ? [...list.value, ...rows] : rows;
    hasMore.value = rows.length >= 30;
  } finally {
    loading.value = false;
  }
}

async function openDetail(r: any) {
  detail.value = await api<any>(`/admin/call-logs/${r.callId}`);
}

function userName(uid: string) {
  const u = (detail.value?.users ?? []).find((x: any) => String(x.id) === String(uid));
  return u ? `${u.nickname}(${u.shortId ?? ''})` : uid;
}

/** 下载该通话的全部日志为文本文件（双端按上报顺序拼接） */
function download() {
  if (!detail.value) return;
  const r = detail.value.record;
  const head = [
    `callId: ${r.callId}`,
    `type: ${r.type === 2 ? '视频' : '语音'}  status: ${STATUS[r.status] ?? r.status}  duration: ${r.durationSec}s`,
    `caller: ${userName(r.callerId)}  callee: ${userName(r.calleeId)}`,
    `createdAt: ${r.createdAt}`,
    '='.repeat(60),
  ].join('\n');
  const body = detail.value.logs
    .map((l: any) => `\n---- [${l.platform}] ${userName(l.uid)} 上报于 ${new Date(l.createdAt).toLocaleString()} ----\n${l.content}`)
    .join('\n');
  const blob = new Blob([`${head}\n${body}`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `call_${r.callId}.log.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

onMounted(() => load());
</script>

<template>
  <div>
    <div class="page-title">通话日志（排查视频/语音问题）</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>时间</th><th>类型</th><th>主叫</th><th>被叫</th><th>状态</th><th>时长</th><th>日志</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td class="muted">{{ new Date(r.createdAt).toLocaleString() }}</td>
            <td>{{ r.type === 2 ? '视频' : '语音' }}</td>
            <td>{{ r.caller?.nickname }}<span class="muted">（{{ r.caller?.shortId }}）</span></td>
            <td>{{ r.callee?.nickname }}<span class="muted">（{{ r.callee?.shortId }}）</span></td>
            <td>{{ STATUS[r.status] ?? r.status }}</td>
            <td>{{ r.durationSec }}s</td>
            <td :class="{ muted: !r.logCount }">{{ r.logCount }} 批</td>
            <td><button class="small ghost" :disabled="!r.logCount" @click="openDetail(r)">查看</button></td>
          </tr>
          <tr v-if="!list.length && !loading"><td colspan="8" class="muted">暂无通话记录</td></tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 12px">
        <button v-if="hasMore" class="small ghost" :disabled="loading" @click="load(true)">加载更多</button>
      </div>
    </div>

    <div v-if="detail" class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <div class="page-title" style="font-size: 15px; margin: 0">
          {{ detail.record.type === 2 ? '视频' : '语音' }}通话
          {{ userName(detail.record.callerId) }} → {{ userName(detail.record.calleeId) }}
          （{{ STATUS[detail.record.status] ?? detail.record.status }} / {{ detail.record.durationSec }}s）
        </div>
        <div class="row" style="gap: 8px">
          <button class="small" @click="download">下载日志</button>
          <button class="small ghost" @click="detail = null">关闭</button>
        </div>
      </div>
      <div v-for="l in detail.logs" :key="l.id" style="margin-bottom: 14px">
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">
          [{{ l.platform }}] {{ userName(l.uid) }} · 上报于 {{ new Date(l.createdAt).toLocaleString() }}
        </div>
        <pre style="
          background: #0f0f12; color: #c8c8d0; padding: 10px 12px; border-radius: 8px;
          font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0;
        ">{{ l.content }}</pre>
      </div>
      <div v-if="!detail.logs.length" class="muted">该通话无客户端日志上报</div>
    </div>
  </div>
</template>
