<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const users = ref<any[]>([]);
const keyword = ref('');
const grantFor = ref<any>(null);
const amount = ref('');
const remark = ref('');
const toast = ref('');
const txFor = ref<any>(null);
const txs = ref<any[]>([]);
const txHasMore = ref(false);
const txLoading = ref(false);

const TX_TYPE_LABEL: Record<string, string> = {
  admin_grant: '后台发放',
  adjust: '后台扣减',
  gift_send: '送出礼物',
  gift_recv: '收到礼物',
  task_freeze: '约单托管',
  task_settle: '约单结算',
  task_refund: '约单退回',
  msg_fee: '发送消息',
  msg_income: '消息收入',
  call_fee: '视频通话',
  call_income: '通话收入',
  transfer_out: '转赠支出',
  transfer_in: '收到转赠',
};

async function openTxs(u: any) {
  txFor.value = u;
  txs.value = [];
  txHasMore.value = false;
  await loadTxs();
}

async function loadTxs() {
  if (!txFor.value || txLoading.value) return;
  txLoading.value = true;
  try {
    const last = txs.value[txs.value.length - 1];
    const list = await api<any[]>(
      `/admin/users/${txFor.value.id}/transactions${last ? `?beforeId=${last.id}` : ''}`,
    );
    txs.value = [...txs.value, ...list];
    txHasMore.value = list.length >= 30;
  } catch (e: any) {
    showToast(e.message);
  } finally {
    txLoading.value = false;
  }
}

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load() {
  users.value = await api<any[]>(`/admin/users${keyword.value ? `?keyword=${encodeURIComponent(keyword.value)}` : ''}`);
}
onMounted(load);

async function grant() {
  if (!grantFor.value || !amount.value) return;
  try {
    // 输入积分（可小数），接口按分
    const fen = Math.round(parseFloat(amount.value) * 100);
    await api(`/admin/users/${grantFor.value.id}/grant`, {
      method: 'POST',
      body: { amount: String(fen), remark: remark.value },
    });
    showToast('积分已发放');
    grantFor.value = null;
    amount.value = '';
    remark.value = '';
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggleBan(u: any) {
  await api(`/admin/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 0 ? 1 : 0 } });
  load();
}
</script>

<template>
  <div>
    <div class="page-title">用户管理</div>
    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <input v-model="keyword" placeholder="昵称 / 地址搜索" style="width: 260px" @keydown.enter="load" />
        <button class="small" @click="load">搜索</button>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>昵称</th><th>性别</th><th>年纪</th><th>地址</th><th>地陪</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.id }}</td>
            <td>{{ u.nickname }}</td>
            <td>{{ u.gender === 1 ? '男' : '女' }}</td>
            <td>{{ u.age }}</td>
            <td class="muted">{{ u.address.slice(0, 8) }}…{{ u.address.slice(-4) }}</td>
            <td>{{ u.isGuide ? '是' : '-' }}</td>
            <td><span class="tag" :class="u.status === 0 ? 'ok' : 'off'">{{ u.status === 0 ? '正常' : '封禁' }}</span></td>
            <td>
              <div class="row">
                <button class="small" @click="grantFor = u">发积分</button>
                <button class="small ghost" @click="openTxs(u)">积分明细</button>
                <button class="small ghost" @click="toggleBan(u)">{{ u.status === 0 ? '封禁' : '解封' }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="grantFor" class="card">
      <div class="page-title" style="font-size: 15px">给「{{ grantFor.nickname }}」发放积分（可小数，负数为扣减）</div>
      <div class="row">
        <input v-model="amount" placeholder="积分数量，如 100 或 0.5" style="width: 160px" />
        <input v-model="remark" placeholder="备注（可选）" style="width: 220px" />
        <button @click="grant">发放</button>
        <button class="ghost" @click="grantFor = null">取消</button>
      </div>
    </div>

    <div v-if="txFor" class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <div class="page-title" style="font-size: 15px; margin: 0">「{{ txFor.nickname }}」积分明细（单位：积分）</div>
        <button class="small ghost" @click="txFor = null">关闭</button>
      </div>
      <table>
        <thead>
          <tr><th>时间</th><th>类型</th><th>变动</th><th>变动后余额</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in txs" :key="t.id">
            <td class="muted">{{ new Date(t.createdAt).toLocaleString() }}</td>
            <td>{{ TX_TYPE_LABEL[t.type] ?? t.type }}</td>
            <td :style="{ color: Number(t.amount) >= 0 ? '#2e9e5b' : '#d64545' }">
              {{ Number(t.amount) >= 0 ? '+' : '' }}{{ (Number(t.amount) / 100).toFixed(2) }}
            </td>
            <td>{{ (Number(t.balanceAfter) / 100).toFixed(2) }}</td>
            <td class="muted">{{ t.remark }}</td>
          </tr>
          <tr v-if="!txs.length && !txLoading"><td colspan="5" class="muted">暂无记录</td></tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px">
        <button v-if="txHasMore" class="small ghost" :disabled="txLoading" @click="loadTxs">
          {{ txLoading ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
