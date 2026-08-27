<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const applies = ref<any[]>([]);
const toast = ref('');

async function load() {
  applies.value = await api<any[]>('/admin/guide-applies?status=0');
}
onMounted(load);

async function review(id: string, pass: boolean) {
  const reason = pass ? '' : prompt('拒绝原因（可留空）') ?? '';
  await api(`/admin/guide-applies/${id}/review`, { method: 'POST', body: { pass, reason } });
  toast.value = pass ? '已通过' : '已拒绝';
  setTimeout(() => (toast.value = ''), 1500);
  load();
}
</script>

<template>
  <div>
    <div class="page-title">地陪认证审核</div>
    <div class="card">
      <p v-if="applies.length === 0" class="muted">暂无待审核申请</p>
      <table v-else>
        <thead>
          <tr><th>用户ID</th><th>真实姓名</th><th>身份证号</th><th>介绍</th><th>提交时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in applies" :key="a.id">
            <td>{{ a.userId }}</td>
            <td>{{ a.realName }}</td>
            <td class="muted">{{ a.idCardNo }}</td>
            <td style="max-width: 320px">{{ a.intro }}</td>
            <td class="muted">{{ new Date(a.createdAt).toLocaleString('zh-CN') }}</td>
            <td>
              <div class="row">
                <button class="small" @click="review(a.id, true)">通过</button>
                <button class="small ghost" @click="review(a.id, false)">拒绝</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
