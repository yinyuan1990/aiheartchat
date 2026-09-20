<script setup lang="ts">
import { ref } from 'vue';
import TgAccountCard, { type TgStatus } from './tg/TgAccountCard.vue';
import TgTreeholeSources from './tg/TgTreeholeSources.vue';
import TgMusicSources from './tg/TgMusicSources.vue';
import TgGallerySources from './tg/TgGallerySources.vue';
import TgStickerSets from './tg/TgStickerSets.vue';

/** 所有 Telegram 来源集中在这一页：账号 → 养眼图片 / 音乐 / 树洞 / 表情包 */
const loggedIn = ref(false);
const section = ref<'gallery' | 'music' | 'treehole' | 'stickers'>('gallery');
const toast = ref('');
function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 2400);
}
function onStatus(s: TgStatus) {
  loggedIn.value = s.loggedIn;
}
</script>

<template>
  <div>
    <div class="page-title">Telegram 来源</div>
    <TgAccountCard @status="onStatus" @toast="showToast" />

    <div class="row" style="margin: 4px 0 12px; gap: 8px">
      <button class="small" :class="section === 'gallery' ? '' : 'ghost'" @click="section = 'gallery'">养眼图片</button>
      <button class="small" :class="section === 'music' ? '' : 'ghost'" @click="section = 'music'">音乐</button>
      <button class="small" :class="section === 'treehole' ? '' : 'ghost'" @click="section = 'treehole'">私密树洞</button>
      <button class="small" :class="section === 'stickers' ? '' : 'ghost'" @click="section = 'stickers'">表情包</button>
    </div>

    <TgGallerySources v-if="section === 'gallery'" :logged-in="loggedIn" @toast="showToast" />
    <TgMusicSources v-if="section === 'music'" :logged-in="loggedIn" @toast="showToast" />
    <TgTreeholeSources v-if="section === 'treehole'" @toast="showToast" />
    <TgStickerSets v-if="section === 'stickers'" :logged-in="loggedIn" @toast="showToast" />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
