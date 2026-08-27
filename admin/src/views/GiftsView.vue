<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, getToken } from '../api';

interface Gift {
  id?: number;
  name: string;
  icon: string;
  price: string;
  sort: number;
  enabled: boolean;
}

const gifts = ref<Gift[]>([]);
const editing = ref<Gift | null>(null);
const toast = ref('');

function showToast(text: string) {
  toast.value = text;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load() {
  gifts.value = await api<Gift[]>('/admin/gifts');
}
onMounted(load);

function startAdd() {
  editing.value = { name: '', icon: '', price: '1', sort: gifts.value.length + 1, enabled: true };
}

function startEdit(g: Gift) {
  // 界面按积分编辑，存储按分
  editing.value = { ...g, price: (Number(g.price) / 100).toString() };
}

async function save() {
  if (!editing.value) return;
  const g = editing.value;
  if (!g.name || !g.icon || !g.price) {
    showToast('请填写完整');
    return;
  }
  try {
    await api('/admin/gifts', {
      method: 'POST',
      body: { ...g, price: String(Math.round(parseFloat(String(g.price)) * 100)) },
    });
    editing.value = null;
    showToast('已保存');
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggleEnabled(g: Gift) {
  await api('/admin/gifts', { method: 'POST', body: { ...g, price: String(g.price), enabled: !g.enabled } });
  load();
}

/** 上传礼物图片（复用注册头像的免登录上传接口不合适，走登录 image 接口需用户 token；此处直接走 avatar 接口） */
async function uploadIcon(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || !editing.value) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload/avatar', { method: 'POST', body: form });
  const json = await res.json();
  if (json.code === 0) {
    editing.value.icon = json.data.url;
  } else {
    showToast(json.msg);
  }
}
</script>

<template>
  <div>
    <div class="page-title">礼物管理</div>
    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <span class="muted">共 {{ gifts.length }} 个礼物（1 积分 = 1 元）</span>
        <span style="flex: 1"></span>
        <button class="small" @click="startAdd">新增礼物</button>
      </div>
      <table>
        <thead>
          <tr><th>图标</th><th>名称</th><th>积分</th><th>排序</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="g in gifts" :key="g.id">
            <td><img :src="g.icon" style="width: 36px; height: 36px" /></td>
            <td>{{ g.name }}</td>
            <td>{{ (Number(g.price) / 100).toString() }} 积分</td>
            <td>{{ g.sort }}</td>
            <td><span class="tag" :class="g.enabled ? 'ok' : 'off'">{{ g.enabled ? '上架' : '下架' }}</span></td>
            <td>
              <div class="row">
                <button class="small ghost" @click="startEdit(g)">编辑</button>
                <button class="small ghost" @click="toggleEnabled(g)">{{ g.enabled ? '下架' : '上架' }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="editing" class="card">
      <div class="page-title" style="font-size: 15px">{{ editing.id ? '编辑礼物' : '新增礼物' }}</div>
      <div class="row" style="flex-wrap: wrap; gap: 14px">
        <input v-model="editing.name" placeholder="名称" style="width: 140px" />
        <input v-model="editing.price" placeholder="积分价格" style="width: 120px" />
        <input v-model.number="editing.sort" type="number" placeholder="排序" style="width: 90px" />
        <input v-model="editing.icon" placeholder="图标 URL（或右侧上传）" style="width: 280px" />
        <label class="ghost" style="cursor: pointer">
          <input type="file" accept="image/*" hidden @change="uploadIcon" />
          <button class="small ghost" type="button" @click.prevent="($event.currentTarget as HTMLElement).parentElement?.querySelector('input')?.click()">上传图片</button>
        </label>
        <img v-if="editing.icon" :src="editing.icon" style="width: 36px; height: 36px" />
      </div>
      <div class="row" style="margin-top: 14px">
        <button @click="save">保存</button>
        <button class="ghost" @click="editing = null">取消</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
