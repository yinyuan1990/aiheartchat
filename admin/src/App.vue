<script setup lang="ts">
import { ref } from 'vue';
import { api, getToken, setToken } from './api';
import GiftsView from './views/GiftsView.vue';
import CallConfigView from './views/CallConfigView.vue';
import UsersView from './views/UsersView.vue';
import GuideReviewView from './views/GuideReviewView.vue';
import DisputesView from './views/DisputesView.vue';
import ModulesView from './views/ModulesView.vue';
import LedgerView from './views/LedgerView.vue';
import CallLogsView from './views/CallLogsView.vue';

const logged = ref(!!getToken());
const username = ref('');
const password = ref('');
const error = ref('');
const tab = ref('gifts');

const tabs = [
  { key: 'gifts', label: '礼物管理' },
  { key: 'call', label: '通话参数' },
  { key: 'users', label: '用户管理' },
  { key: 'ledger', label: '平台账本' },
  { key: 'calllogs', label: '通话日志' },
  { key: 'guide', label: '地陪审核' },
  { key: 'disputes', label: '约单仲裁' },
  { key: 'modules', label: '大厅 / 小游戏' },
];

async function login() {
  error.value = '';
  try {
    const r = await api<{ token: string }>('/admin/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    });
    setToken(r.token);
    logged.value = true;
  } catch (e: any) {
    error.value = e.message;
  }
}

function logout() {
  setToken(null);
  logged.value = false;
}
</script>

<template>
  <div v-if="!logged" class="login-wrap">
    <div class="login-box">
      <h2>心之音管理后台</h2>
      <input v-model="username" placeholder="账号" @keydown.enter="login" />
      <input v-model="password" type="password" placeholder="密码" @keydown.enter="login" />
      <p v-if="error" class="muted" style="color: var(--accent); margin-bottom: 12px">{{ error }}</p>
      <button @click="login">登录</button>
    </div>
  </div>

  <div v-else class="layout">
    <div class="sidebar">
      <div class="logo">心之音后台</div>
      <div
        v-for="t in tabs"
        :key="t.key"
        class="item"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
      </div>
      <div class="item" style="margin-top: 24px" @click="logout">退出登录</div>
    </div>
    <div class="main">
      <GiftsView v-if="tab === 'gifts'" />
      <CallConfigView v-if="tab === 'call'" />
      <UsersView v-if="tab === 'users'" />
      <LedgerView v-if="tab === 'ledger'" />
      <CallLogsView v-if="tab === 'calllogs'" />
      <GuideReviewView v-if="tab === 'guide'" />
      <DisputesView v-if="tab === 'disputes'" />
      <ModulesView v-if="tab === 'modules'" />
    </div>
  </div>
</template>
