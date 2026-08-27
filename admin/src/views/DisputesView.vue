<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const orders = ref<any[]>([]);
const toast = ref('');

async function load() {
  orders.value = await api<any[]>('/admin/disputes');
}
onMounted(load);

async function arbitrate(id: string, settleToTaker: boolean) {
  if (!confirm(settleToTaker ? '确定判给接单人（结算报酬）？' : '确定退回发单人？')) return;
  await api(`/admin/disputes/${id}/arbitrate`, { method: 'POST', body: { settleToTaker } });
  toast.value = '已仲裁';
  setTimeout(() => (toast.value = ''), 1500);
  load();
}
</script>

<template>
  <div>
    <div class="page-title">约单仲裁（进行中/争议）</div>
    <div class="card">
      <p v-if="orders.length === 0" class="muted">暂无需要仲裁的约单</p>
      <table v-else>
        <thead>
          <tr><th>ID</th><th>标题</th><th>发单人</th><th>接单人</th><th>报酬</th><th>见面时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id">
            <td>{{ o.id }}</td>
            <td>{{ o.title }}</td>
            <td>{{ o.ownerId }}</td>
            <td>{{ o.takerId ?? '-' }}</td>
            <td>{{ o.reward }} 积分</td>
            <td class="muted">{{ new Date(o.meetAt).toLocaleString('zh-CN') }}</td>
            <td>
              <div class="row">
                <button class="small" @click="arbitrate(o.id, true)">判给接单人</button>
                <button class="small ghost" @click="arbitrate(o.id, false)">退回发单人</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
