<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const width = ref(640);
const height = ref(480);
const fps = ref(25);
const bitrate = ref(800);
const voiceRoomMax = ref(3);
const msgPrice = ref('0.1');
const videoBasePrice = ref('0.02');
const platformX = ref(2);
const momentNeedRealname = ref(false);
const toast = ref('');

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 2000);
}

onMounted(async () => {
  try {
    const c = await api<any>('/admin/call-config');
    width.value = c.width ?? 640;
    height.value = c.height ?? 480;
    fps.value = c.fps ?? 25;
    bitrate.value = c.bitrate ?? 800;
    voiceRoomMax.value = c.voiceRoomMax ?? 3;
  } catch {}
  try {
    const p = await api<any>('/admin/price-config');
    msgPrice.value = (p.msgPriceFen / 100).toString();
    videoBasePrice.value = (p.videoBaseFenPerMin / 100).toString();
    platformX.value = p.videoPlatformX ?? 2;
    momentNeedRealname.value = !!p.momentNeedRealname;
  } catch {}
});

async function save() {
  await api('/admin/call-config', {
    method: 'PUT',
    body: {
      width: width.value,
      height: height.value,
      fps: fps.value,
      bitrate: bitrate.value,
      voiceRoomMax: Math.max(1, Math.round(voiceRoomMax.value || 3)),
    },
  });
  showToast('已保存，App 下次呼叫/进房生效');
}

async function savePrices() {
  await api('/admin/price-config', {
    method: 'PUT',
    body: {
      msgPriceFen: Math.round(parseFloat(msgPrice.value || '0') * 100),
      videoBaseFenPerMin: Math.round(parseFloat(videoBasePrice.value || '0') * 100),
      videoPlatformX: Math.max(1, Math.round(platformX.value || 2)),
      momentNeedRealname: momentNeedRealname.value,
    },
  });
  showToast('计费已保存，即时生效');
}

async function resetFemalePrices() {
  const baseFen = Math.round(parseFloat(videoBasePrice.value || '0') * 100);
  if (!confirm(`将全平台所有女生的视频价格重置为 成本 x5 = ${((baseFen * 5) / 100).toFixed(2)} 积分/分钟，确定？`)) return;
  const r = await api<any>('/admin/price-config/reset-female', { method: 'POST', body: { times: 5 } });
  showToast(`已重置 ${r.affected} 位女生价格为 ${(r.priceFen / 100).toFixed(2)} 积分/分钟`);
}

const presets = [
  { label: '480P 流畅', width: 640, height: 480, fps: 25, bitrate: 800 },
  { label: '540P 标准', width: 960, height: 540, fps: 25, bitrate: 1200 },
  { label: '720P 高清', width: 1280, height: 720, fps: 30, bitrate: 2000 },
];

function applyPreset(p: (typeof presets)[0]) {
  width.value = p.width;
  height.value = p.height;
  fps.value = p.fps;
  bitrate.value = p.bitrate;
}
</script>

<template>
  <div>
    <div class="page-title">通话参数（一对一音视频）</div>
    <div class="card">
      <div class="row" style="margin-bottom: 16px">
        <button v-for="p in presets" :key="p.label" class="small ghost" @click="applyPreset(p)">{{ p.label }}</button>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 14px">
        <label class="muted">宽 <input v-model.number="width" type="number" style="width: 100px" /></label>
        <label class="muted">高 <input v-model.number="height" type="number" style="width: 100px" /></label>
        <label class="muted">帧率 <input v-model.number="fps" type="number" style="width: 80px" /></label>
        <label class="muted">码率(kbps) <input v-model.number="bitrate" type="number" style="width: 100px" /></label>
        <label class="muted">语音房人数上限 <input v-model.number="voiceRoomMax" type="number" min="1" max="50" style="width: 80px" /> 人</label>
      </div>
      <div style="margin-top: 16px">
        <button @click="save">保存生效</button>
      </div>
      <p class="muted" style="margin-top: 12px">默认 640x480 @ 25fps 800kbps；修改后 App 端发起新通话时自动拉取新参数。语音房上限默认 3 人，保存后新进房请求即时生效（已在房内的人不受影响）。</p>
    </div>

    <div class="page-title" style="margin-top: 24px">计费配置（单位：积分，1 积分 = 1 元，支持小数）</div>
    <div class="card">
      <div class="row" style="flex-wrap: wrap; gap: 18px">
        <label class="muted">男发一条消息 <input v-model="msgPrice" style="width: 90px" /> 积分/条</label>
        <label class="muted">视频流量成本价 <input v-model="videoBasePrice" style="width: 90px" /> 积分/分钟</label>
        <label class="muted">平台倍率 x <input v-model.number="platformX" type="number" min="1" style="width: 70px" /></label>
        <label class="muted" style="display: flex; align-items: center; gap: 6px">
          <input v-model="momentNeedRealname" type="checkbox" style="width: auto" />
          女生须实名认证才能发布动态
        </label>
      </div>
      <div style="margin-top: 16px; display: flex; gap: 10px">
        <button @click="savePrices">保存计费</button>
        <button class="ghost" @click="resetFemalePrices">重置全平台女生价格（成本 x5）</button>
      </div>
      <p class="muted" style="margin-top: 12px">
        成本价 = 640x480@800kbps 双向流量费（约 0.012 积分/分钟）。平台每分钟抽成 = 成本 x 倍率（默认 x2，即平台赚 1 倍流量费）；
        女生自定价必须高于平台抽成，女方收入 = 价格 - 抽成。女生未自定价时默认价 = 成本 x5。
        消息计费仅对 男→女 的文字/图片/视频消息生效，收入归女方。
      </p>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
