<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, getToken, setToken } from './api';
import GiftsView from './views/GiftsView.vue';
import CallConfigView from './views/CallConfigView.vue';
import UsersView from './views/UsersView.vue';
import GuideReviewView from './views/GuideReviewView.vue';
import DisputesView from './views/DisputesView.vue';
import ModulesView from './views/ModulesView.vue';
import LedgerView from './views/LedgerView.vue';
import CallLogsView from './views/CallLogsView.vue';
import TreeholeView from './views/TreeholeView.vue';
import MusicView from './views/MusicView.vue';
import TelegramView from './views/TelegramView.vue';
import PublishView from './views/PublishView.vue';
import SrsNodesView from './views/SrsNodesView.vue';
import AppVersionView from './views/AppVersionView.vue';
import ChannelsView from './views/ChannelsView.vue';
import BotsView from './views/BotsView.vue';
import ReportsView from './views/ReportsView.vue';
import GroupsView from './views/GroupsView.vue';

const logged = ref(!!getToken());
const username = ref('');
const password = ref('');
const error = ref('');

const menu = [
  {
    key: 'user', label: '用户与审核',
    items: [
      { key: 'users', label: '用户管理' },
      { key: 'guide', label: '地陪审核' },
      { key: 'reports', label: '举报' },
      { key: 'disputes', label: '约单仲裁' },
    ],
  },
  {
    key: 'social', label: '社交与内容',
    items: [
      { key: 'channels', label: '频道' },
      { key: 'groups', label: '群管理' },
      { key: 'bots', label: '机器人' },
      { key: 'treehole', label: '私密树洞' },
      { key: 'music', label: '音乐频道' },
    ],
  },
  {
    key: 'callgift', label: '通话与礼物',
    items: [
      { key: 'call', label: '通话参数' },
      { key: 'calllogs', label: '通话日志' },
      { key: 'gifts', label: '礼物管理' },
    ],
  },
  { key: 'finance', label: '财务', items: [{ key: 'ledger', label: '平台账本' }] },
  {
    key: 'ops', label: '运营推广',
    items: [
      { key: 'publish', label: '内容分发（推广）' },
      { key: 'telegram', label: 'Telegram 来源' },
      { key: 'modules', label: '大厅 / 小游戏' },
    ],
  },
  {
    key: 'system', label: '系统',
    items: [
      { key: 'srs', label: 'SRS 节点' },
      { key: 'appver', label: 'App 版本 / 强制更新' },
    ],
  },
];
const allItems = menu.flatMap((g) => g.items);
const TAB_KEY = 'admin_tab';
const COLLAPSED_KEY = 'admin_menu_collapsed';

/** 当前页记在地址 #key 里（刷新 / 后退都认），localStorage 兜底 */
function initialTab() {
  const fromHash = location.hash.replace(/^#\/?/, '');
  if (allItems.some((i) => i.key === fromHash)) return fromHash;
  const saved = localStorage.getItem(TAB_KEY) ?? '';
  return allItems.some((i) => i.key === saved) ? saved : allItems[0].key;
}
const tab = ref(initialTab());
const currentGroup = computed(() => menu.find((g) => g.items.some((i) => i.key === tab.value)));
const currentLabel = computed(() => allItems.find((i) => i.key === tab.value)?.label ?? '');

function loadCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const collapsed = ref<string[]>(loadCollapsed());
function isOpen(key: string) {
  return !collapsed.value.includes(key) || currentGroup.value?.key === key;
}
function toggleGroup(key: string) {
  collapsed.value = isOpen(key) ? [...collapsed.value, key] : collapsed.value.filter((k) => k !== key);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed.value));
}

const drawer = ref(false);
function go(key: string) {
  drawer.value = false;
  location.hash = key;
  tab.value = key;
}
watch(tab, (key) => {
  localStorage.setItem(TAB_KEY, key);
  if (location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
  window.scrollTo(0, 0);
}, { immediate: true });

function onHash() {
  const key = location.hash.replace(/^#\/?/, '');
  if (allItems.some((i) => i.key === key)) tab.value = key;
}
onMounted(() => window.addEventListener('hashchange', onHash));
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));

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
    <div class="topbar">
      <button class="small ghost" data-testid="menu-toggle" @click="drawer = !drawer">菜单</button>
      <span class="topbar-title">{{ currentGroup?.label }} · {{ currentLabel }}</span>
    </div>
    <div v-if="drawer" class="sidebar-mask" @click="drawer = false"></div>
    <div class="sidebar" :class="{ open: drawer }">
      <div class="logo">心之音后台</div>
      <div v-for="g in menu" :key="g.key" class="menu-group">
        <div class="group-title" :class="{ current: currentGroup?.key === g.key }" @click="toggleGroup(g.key)">
          <span>{{ g.label }}</span>
          <span class="chevron" :class="{ open: isOpen(g.key) }">›</span>
        </div>
        <template v-if="isOpen(g.key)">
          <div
            v-for="t in g.items"
            :key="t.key"
            class="item sub"
            :class="{ active: tab === t.key }"
            :data-testid="`menu-${t.key}`"
            @click="go(t.key)"
          >
            {{ t.label }}
          </div>
        </template>
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
      <TelegramView v-if="tab === 'telegram'" />
      <PublishView v-if="tab === 'publish'" />
      <ChannelsView v-if="tab === 'channels'" />
      <GroupsView v-if="tab === 'groups'" />
      <BotsView v-if="tab === 'bots'" />
      <ReportsView v-if="tab === 'reports'" />
      <TreeholeView v-if="tab === 'treehole'" />
      <MusicView v-if="tab === 'music'" />
      <SrsNodesView v-if="tab === 'srs'" />
      <AppVersionView v-if="tab === 'appver'" />
    </div>
  </div>
</template>
