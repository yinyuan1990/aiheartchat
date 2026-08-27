<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const from = ref('');
const to = ref('');
const summary = ref<any>(null);
const females = ref<any[]>([]);
const detailFor = ref<any>(null);
const details = ref<any[]>([]);
const loading = ref(false);

function fen(v: any) {
  return (Number(v ?? 0) / 100).toFixed(2);
}

function setRange(days: number) {
  const end = new Date();
  const start = new Date(Date.now() - (days - 1) * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  from.value = fmt(start);
  to.value = fmt(end);
  load();
}

function query() {
  const q: string[] = [];
  if (from.value) q.push(`from=${from.value}`);
  if (to.value) q.push(`to=${to.value}`);
  return q.length ? `?${q.join('&')}` : '';
}

async function load() {
  loading.value = true;
  detailFor.value = null;
  try {
    [summary.value, females.value] = await Promise.all([
      api<any>(`/admin/ledger/summary${query()}`),
      api<any[]>(`/admin/ledger/females${query()}`),
    ]);
  } finally {
    loading.value = false;
  }
}

async function openDetail(f: any) {
  detailFor.value = f;
  details.value = await api<any[]>(`/admin/ledger/females/${f.female.id}${query()}`);
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-title">平台账本（视频通话抽成对账）</div>

    <div class="card">
      <div class="row" style="flex-wrap: wrap; gap: 10px">
        <button class="small ghost" @click="setRange(1)">今天</button>
        <button class="small ghost" @click="setRange(7)">近 7 天</button>
        <button class="small ghost" @click="setRange(30)">近 30 天</button>
        <label class="muted">从 <input v-model="from" type="date" /></label>
        <label class="muted">到 <input v-model="to" type="date" /></label>
        <button class="small" @click="load">查询</button>
        <button class="small ghost" @click="from = ''; to = ''; load()">全部</button>
      </div>

      <div v-if="summary" class="row" style="gap: 28px; margin-top: 16px; flex-wrap: wrap">
        <div>
          <div class="muted" style="font-size: 12px">视频总收费（男方实付）</div>
          <div style="font-size: 22px; font-weight: 700">{{ fen(summary.grossFen) }} 积分</div>
        </div>
        <div>
          <div class="muted" style="font-size: 12px">女生分成合计</div>
          <div style="font-size: 22px; font-weight: 700; color: #2e9e5b">{{ fen(summary.femaleFen) }} 积分</div>
        </div>
        <div>
          <div class="muted" style="font-size: 12px">平台抽成合计</div>
          <div style="font-size: 22px; font-weight: 700; color: var(--accent, #d64545)">{{ fen(summary.platformFen) }} 积分</div>
        </div>
        <div>
          <div class="muted" style="font-size: 12px">通话</div>
          <div style="font-size: 22px; font-weight: 700">{{ summary.count }} 笔 / {{ summary.minutes }} 分钟</div>
        </div>
      </div>
      <p class="muted" style="margin-top: 12px; margin-bottom: 0">
        每笔视频通话：男方实付 = 女生分成 + 平台抽成（4 倍成本价 × 分钟数，男方余额不足时平台优先）。
        消息、礼物收入平台不抽成，全额归女方，表中一并列出便于对账结算。
      </p>
    </div>

    <div class="card">
      <div class="page-title" style="font-size: 15px">按女生对账</div>
      <table>
        <thead>
          <tr>
            <th>女生</th><th>ID</th><th>视频笔数/分钟</th><th>总收费</th><th>女生分成</th><th>平台抽成</th>
            <th>消息收入</th><th>礼物收入</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in females" :key="f.female.id">
            <td>{{ f.female.nickname }}</td>
            <td class="muted">{{ f.female.shortId }}</td>
            <td>{{ f.count }} 笔 / {{ f.minutes }} 分钟</td>
            <td>{{ fen(f.grossFen) }}</td>
            <td style="color: #2e9e5b">{{ fen(f.femaleFen) }}</td>
            <td style="color: var(--accent, #d64545)">{{ fen(f.platformFen) }}</td>
            <td>{{ fen(f.msgIncomeFen) }}</td>
            <td>{{ fen(f.giftIncomeFen) }}</td>
            <td><button class="small ghost" @click="openDetail(f)">逐笔明细</button></td>
          </tr>
          <tr v-if="!females.length && !loading"><td colspan="9" class="muted">该时间段暂无视频计费记录</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="detailFor" class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <div class="page-title" style="font-size: 15px; margin: 0">
          「{{ detailFor.female.nickname }}」逐笔视频账单（单位：积分）
        </div>
        <button class="small ghost" @click="detailFor = null">关闭</button>
      </div>
      <table>
        <thead>
          <tr><th>时间</th><th>男方</th><th>分钟</th><th>男方实付</th><th>女生分成</th><th>平台抽成</th></tr>
        </thead>
        <tbody>
          <tr v-for="d in details" :key="d.id">
            <td class="muted">{{ new Date(d.createdAt).toLocaleString() }}</td>
            <td>{{ d.male.nickname }}<span class="muted">（{{ d.male.shortId }}）</span></td>
            <td>{{ d.minutes }}</td>
            <td>{{ fen(d.grossFen) }}</td>
            <td style="color: #2e9e5b">{{ fen(d.femaleFen) }}</td>
            <td style="color: var(--accent, #d64545)">{{ fen(d.platformFen) }}</td>
          </tr>
          <tr v-if="!details.length"><td colspan="6" class="muted">暂无记录</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
