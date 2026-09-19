<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';

export interface TgStatus {
  apiId: number;
  customApi: boolean;
  loggedIn: boolean;
  user: { id: string; firstName: string; username: string; phone: string } | null;
  pendingPhone: string;
  error: string;
}

const emit = defineEmits<{ (e: 'status', s: TgStatus): void; (e: 'toast', t: string): void }>();

const tg = ref<TgStatus | null>(null);
const apiForm = ref({ apiId: '', apiHash: '' });
const showApi = ref(false);
const phone = ref('');
const code = ref('');
const password = ref('');
const needPassword = ref(false);
const codeSent = ref(false);
const busy = ref('');

function setStatus(s: TgStatus) {
  tg.value = s;
  emit('status', s);
}
async function load() {
  try {
    setStatus(await api<TgStatus>('/admin/telegram/status'));
    if (tg.value?.pendingPhone && !codeSent.value) { phone.value = tg.value.pendingPhone; codeSent.value = true; }
  } catch (e: any) {
    emit('toast', e.message);
  }
}
async function saveApi() {
  busy.value = 'api';
  try {
    setStatus(await api<TgStatus>('/admin/telegram/api', { method: 'PUT', body: apiForm.value }));
    emit('toast', '已保存');
    showApi.value = false;
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    busy.value = '';
  }
}
async function sendCode() {
  busy.value = 'code';
  try {
    const r = await api<{ viaApp: boolean }>('/admin/telegram/send-code', { method: 'POST', body: { phone: phone.value } });
    codeSent.value = true;
    needPassword.value = false;
    emit('toast', r.viaApp ? '验证码已发到你已登录的 Telegram App 里' : '验证码已通过短信发送');
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    busy.value = '';
  }
}
async function signIn() {
  busy.value = 'signin';
  try {
    const r = await api<any>('/admin/telegram/sign-in', { method: 'POST', body: { code: code.value, password: password.value || undefined } });
    if (r.needPassword) {
      needPassword.value = true;
      emit('toast', '该账号开了两步验证，请输入密码');
      return;
    }
    setStatus(r);
    codeSent.value = false;
    code.value = ''; password.value = ''; needPassword.value = false;
    emit('toast', 'Telegram 已登录');
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    busy.value = '';
  }
}
async function logoutTg() {
  if (!confirm('退出 Telegram 账号后音乐 / 养眼图片同步会停止，确定？')) return;
  busy.value = 'logout';
  try {
    setStatus(await api<TgStatus>('/admin/telegram/logout', { method: 'POST' }));
    codeSent.value = false;
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    busy.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="card">
    <div style="font-weight: 600; margin-bottom: 6px">Telegram 账号</div>
    <div class="muted" style="margin-bottom: 12px">
      音乐、养眼图片这类频道要读<b>文件</b>（音频 / 图片 / 视频），Telegram 网页预览给不了，而且很多频道关闭了预览，所以用一个普通 Telegram 账号登录后读取。
      只读不发消息，登录一次长期有效；<b>别在手机 Telegram「设置 → 设备」里把 yyheart-server 会话踢掉</b>，踢掉同步就停。
    </div>

    <div v-if="tg?.error" class="muted" style="color: #ff6b6b; margin-bottom: 8px">连接异常：{{ tg.error }}</div>

    <div v-if="tg?.loggedIn" class="row" style="gap: 12px; align-items: center">
      <span class="tag ok">已登录</span>
      <span>{{ tg.user?.firstName }} <span class="muted">{{ tg.user?.username ? '@' + tg.user.username : '' }} · {{ tg.user?.phone ? '+' + tg.user.phone : '' }}</span></span>
      <button class="small ghost" :disabled="busy === 'logout'" @click="logoutTg">退出账号</button>
    </div>

    <div v-else class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
      <span class="tag off">未登录</span>
      <label class="muted">手机号 <input v-model="phone" placeholder="+8613800000000" style="width: 180px" :disabled="codeSent" /></label>
      <button class="small" :disabled="busy === 'code'" @click="sendCode">{{ busy === 'code' ? '发送中…' : codeSent ? '重新发码' : '发送验证码' }}</button>
      <template v-if="codeSent">
        <label class="muted">验证码 <input v-model="code" placeholder="5 位数字" style="width: 100px" @keydown.enter="signIn" /></label>
        <label v-if="needPassword" class="muted">两步验证密码 <input v-model="password" type="password" style="width: 160px" @keydown.enter="signIn" /></label>
        <button class="small" :disabled="busy === 'signin'" @click="signIn">{{ busy === 'signin' ? '登录中…' : '登录' }}</button>
        <button class="small ghost" @click="codeSent = false; needPassword = false">换号</button>
      </template>
    </div>

    <div class="muted" style="margin-top: 12px; font-size: 12px">
      当前 api_id：{{ tg?.apiId ?? '…' }}{{ tg?.customApi ? '（自己申请的）' : '（内置 Telegram Desktop 公共值，能用；被限流时到 my.telegram.org 申请自己的填入）' }}
      <a style="color: var(--accent); cursor: pointer; margin-left: 8px" @click="showApi = !showApi">{{ showApi ? '收起' : '修改' }}</a>
    </div>
    <div v-if="showApi" class="row" style="margin-top: 8px; gap: 12px; flex-wrap: wrap">
      <label class="muted">api_id <input v-model="apiForm.apiId" placeholder="数字" style="width: 120px" /></label>
      <label class="muted">api_hash <input v-model="apiForm.apiHash" placeholder="32 位十六进制" style="width: 300px" /></label>
      <button class="small" :disabled="busy === 'api'" @click="saveApi">保存（两项留空 = 用内置值）</button>
    </div>
  </div>
</template>
