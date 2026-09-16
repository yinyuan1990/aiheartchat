<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';

interface Ver {
  platform: 'android' | 'ios';
  latest: string;
  minVersion: string;
  force: boolean;
  url: string;
  channel: string;
  notes: string;
  updatedAt?: string | null;
}

const rows = reactive<Record<'android' | 'ios', Ver>>({
  android: { platform: 'android', latest: '1.0', minVersion: '', force: false, url: '', channel: 'apk', notes: '' },
  ios: { platform: 'ios', latest: '1.0', minVersion: '', force: false, url: '', channel: 'testflight', notes: '' },
});
const toast = ref('');
const testVer = ref('1.0');
const testResult = ref<Record<string, any>>({});

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 2200);
}

async function load() {
  const list = await api<Ver[]>('/admin/app-version');
  for (const v of list) Object.assign(rows[v.platform], v);
}

async function save(p: 'android' | 'ios') {
  const r = rows[p];
  if (!r.latest.trim()) return showToast('请填写最新版本号');
  if (p === 'ios' && !/^https?:\/\//.test(r.url)) return showToast('iOS 需要填写 TestFlight 或 App Store 链接');
  await api(`/admin/app-version/${p}`, { method: 'PUT', body: { ...r } });
  showToast(`${p === 'ios' ? 'iOS' : 'Android'} 已保存，App 下次启动生效`);
  await load();
}

async function simulate(p: 'android' | 'ios') {
  testResult.value[p] = await api(`/app/version?platform=${p}&version=${encodeURIComponent(testVer.value)}`);
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-title">App 版本 / 强制更新</div>
    <p class="muted" style="margin-bottom: 16px">
      客户端启动时上报自己的版本号：低于「最新版本」弹出更新提示；勾了「全部强制」或版本低于「最低可用版本」时弹框不可关闭，只能点去更新。
      iOS 前期填 TestFlight 公开链接（渠道选 TestFlight），上架后把链接换成 App Store 地址、渠道改为 App Store 即可，客户端不用改代码。
      官网下载区也读这里的地址。
    </p>

    <div v-for="p in (['android', 'ios'] as const)" :key="p" class="card" style="margin-bottom: 18px">
      <div class="row" style="align-items: center; margin-bottom: 14px">
        <strong style="font-size: 16px">{{ p === 'ios' ? 'iOS' : 'Android' }}</strong>
        <span class="muted" style="margin-left: 12px; font-size: 12px" v-if="rows[p].updatedAt">上次保存 {{ new Date(rows[p].updatedAt!).toLocaleString() }}</span>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px">
        <label class="muted">最新版本 <input v-model="rows[p].latest" placeholder="1.0.1" style="width: 110px" /></label>
        <label class="muted">最低可用版本 <input v-model="rows[p].minVersion" placeholder="留空=不按版本强制" style="width: 160px" /></label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px">
          <input v-model="rows[p].force" type="checkbox" style="width: auto" /> 全部强制（所有旧版本必须更新）
        </label>
        <label v-if="p === 'ios'" class="muted">
          渠道
          <select v-model="rows[p].channel">
            <option value="testflight">TestFlight（前期）</option>
            <option value="appstore">App Store（上架后）</option>
          </select>
        </label>
      </div>
      <div class="row" style="margin-top: 12px">
        <label class="muted" style="flex: 1; display: flex; align-items: center; gap: 8px">
          {{ p === 'ios' ? '跳转链接' : 'APK 地址' }}
          <input
            v-model="rows[p].url"
            :placeholder="p === 'ios' ? 'https://testflight.apple.com/join/xxxx 或 https://apps.apple.com/cn/app/idxxxx' : 'https://yyheart.com/app/peiwan.apk'"
            style="flex: 1"
          />
        </label>
      </div>
      <div class="row" style="margin-top: 12px">
        <label class="muted" style="flex: 1; display: flex; align-items: flex-start; gap: 8px">
          更新说明
          <textarea v-model="rows[p].notes" rows="3" placeholder="本次更新：&#10;1. 修复视频通话偶发黑屏&#10;2. 新增私密树洞" style="flex: 1; resize: vertical"></textarea>
        </label>
      </div>
      <div class="row" style="margin-top: 14px; gap: 10px; align-items: center">
        <button @click="save(p)">保存</button>
        <span class="muted" style="margin-left: 16px">模拟旧客户端版本 <input v-model="testVer" style="width: 80px" /></span>
        <button class="small ghost" @click="simulate(p)">测试检查结果</button>
        <code v-if="testResult[p]" class="muted" style="font-size: 12px">
          hasUpdate={{ testResult[p].hasUpdate }} force={{ testResult[p].force }} → {{ testResult[p].url || '(无链接)' }}
        </code>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
