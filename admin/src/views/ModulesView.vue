<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const modules = ref<any[]>([]);
const editing = ref<any>(null);
const toast = ref('');

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load() {
  modules.value = await api<any[]>('/admin/modules');
}
onMounted(load);

function startAdd() {
  editing.value = { name: '', icon: '', desc: '', cover: '', type: 'h5', entry: '', sort: modules.value.length + 1, enabled: true, visibleGender: 0 };
}

async function save() {
  const m = editing.value;
  if (!m.name || !m.entry) {
    showToast('请填写名称与入口');
    return;
  }
  await api('/admin/modules', { method: 'POST', body: m });
  editing.value = null;
  showToast('已保存');
  load();
}

async function toggle(m: any) {
  await api('/admin/modules', { method: 'POST', body: { ...m, enabled: !m.enabled } });
  load();
}
</script>

<template>
  <div>
    <div class="page-title">项目大厅管理（游戏等新项目由此接入，每个项目一张横幅卡）</div>
    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <span class="muted">type=native 为客户端内置页；type=h5 填完整网址，客户端内嵌打开并注入登录 token</span>
        <span style="flex: 1"></span>
        <button class="small" @click="startAdd">新增模块</button>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>名称</th><th>类型</th><th>入口</th><th>可见性别</th><th>排序</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in modules" :key="m.id">
            <td>{{ m.id }}</td>
            <td>{{ m.name }}</td>
            <td>{{ m.type }}</td>
            <td class="muted">{{ m.entry }}</td>
            <td>{{ m.visibleGender === 0 ? '全部' : m.visibleGender === 1 ? '仅男' : '仅女' }}</td>
            <td>{{ m.sort }}</td>
            <td><span class="tag" :class="m.enabled ? 'ok' : 'off'">{{ m.enabled ? '上架' : '下架' }}</span></td>
            <td>
              <div class="row">
                <button class="small ghost" @click="editing = { ...m }">编辑</button>
                <button class="small ghost" @click="toggle(m)">{{ m.enabled ? '下架' : '上架' }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="editing" class="card">
      <div class="page-title" style="font-size: 15px">{{ editing.id ? '编辑模块' : '新增模块' }}</div>
      <div class="row" style="flex-wrap: wrap; gap: 14px">
        <input v-model="editing.name" placeholder="项目名称" style="width: 140px" />
        <input v-model="editing.desc" placeholder="项目简介（横幅副标题）" style="width: 240px" />
        <input v-model="editing.cover" placeholder="封面图 URL（空则用渐变）" style="width: 240px" />
        <select v-model="editing.type">
          <option value="native">native</option>
          <option value="h5">h5</option>
        </select>
        <input v-model="editing.entry" placeholder="入口（路由标识或 H5 网址）" style="width: 280px" />
        <select v-model.number="editing.visibleGender">
          <option :value="0">全部可见</option>
          <option :value="1">仅男</option>
          <option :value="2">仅女</option>
        </select>
        <input v-model.number="editing.sort" type="number" placeholder="排序" style="width: 90px" />
      </div>
      <div class="row" style="margin-top: 14px">
        <button @click="save">保存</button>
        <button class="ghost" @click="editing = null">取消</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
