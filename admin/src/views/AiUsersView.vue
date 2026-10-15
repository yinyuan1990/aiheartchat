<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import ListPager from '../components/ListPager.vue';

/** Arm AI（Windows 桌面程序，用户自己的钱包在 Cursor 里按条付费）的用户；数据在 Arm indexer，这里经心之音后端转发 */
interface AiUser {
  id: string; address: string; createdAt: string; seenAt: string | null; online: boolean; exchanges: boolean;
}

const list = ref<AiUser[]>([]);
const total = ref(0);
const page = ref(1);
const size = ref(20);
const q = ref('');
const busy = ref<string | null>(null);
const error = ref('');
const copied = ref<string | null>(null);

async function load() {
  error.value = '';
  try {
    const r = await api<{ list: AiUser[]; total: number }>(`/admin/ai/users?q=${encodeURIComponent(q.value.trim())}&page=${page.value}&size=${size.value}`);
    list.value = r.list;
    total.value = r.total;
  } catch (e: any) {
    error.value = e.message;
  }
}
function search() {
  page.value = 1;
  load();
}
function onPage(p: number, s: number) {
  page.value = p;
  size.value = s;
  load();
}
async function toggleExchanges(u: AiUser) {
  busy.value = u.id;
  try {
    const r = await api<{ pushed: boolean }>(`/admin/ai/users/${u.id}/exchanges`, { method: 'POST', body: { show: !u.exchanges } });
    u.exchanges = !u.exchanges;
    if (!r.pushed) alert('已保存。这个用户的 Arm AI 现在没开，下次打开时生效');
  } catch (e: any) {
    alert(e.message);
  } finally {
    busy.value = null;
  }
}
async function copy(u: AiUser) {
  await navigator.clipboard.writeText(u.address);
  copied.value = u.id;
  setTimeout(() => (copied.value = null), 1200);
}
function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-title">Arm AI 用户</div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px">
        <input v-model="q" placeholder="搜钱包地址（可输一部分）" style="width: 260px" @keydown.enter="search" />
        <button class="small ghost" @click="search">搜索 / 刷新</button>
        <span class="muted">「显示币安 / OKX」打开后，这个用户的 Arm AI 才出现「充值」页（一键下载交易所安装包 + 买 USDC 步骤），默认不显示。程序开着的话马上生效</span>
      </div>
      <p v-if="error" style="color: var(--accent)">{{ error }}</p>
      <table>
        <thead><tr><th>ID</th><th style="min-width: 380px">钱包地址（Base）</th><th>注册时间</th><th>最近在线</th><th>显示币安 / OKX</th></tr></thead>
        <tbody>
          <tr v-for="u in list" :key="u.id">
            <td class="muted">{{ u.id }}</td>
            <td>
              <div class="row">
                <span style="font-family: monospace">{{ u.address }}</span>
                <button class="small ghost" @click="copy(u)">{{ copied === u.id ? '已复制' : '复制' }}</button>
                <a class="muted" style="font-size: 12px" :href="`https://basescan.org/address/${u.address}`" target="_blank" rel="noopener">链上</a>
              </div>
            </td>
            <td class="muted">{{ fmt(u.createdAt) }}</td>
            <td><span v-if="u.online" class="tag ok">在线</span><span v-else class="muted">{{ fmt(u.seenAt) }}</span></td>
            <td>
              <label class="row" style="cursor: pointer">
                <input type="checkbox" :checked="u.exchanges" :disabled="busy === u.id" :data-testid="`ai-exchanges-${u.id}`" @click.prevent="toggleExchanges(u)" />
                <span :class="['tag', u.exchanges ? 'ok' : 'off']">{{ u.exchanges ? '显示' : '不显示' }}</span>
              </label>
            </td>
          </tr>
          <tr v-if="list.length === 0 && !error"><td colspan="5" class="muted">还没有用户</td></tr>
        </tbody>
      </table>
      <ListPager :total="total" :page="page" :size="size" @change="onPage" />
    </div>
  </div>
</template>
