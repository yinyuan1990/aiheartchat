<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../api';

const props = defineProps<{ loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'toast', t: string): void }>();

interface SetRow {
  id: number; shortName: string; title: string; kind: 'static' | 'animated' | 'video'; count: number; thumb: string;
  enabled: boolean; sort: number; importedCount: number; stickers: number; lastSyncAt: string | null; lastError: string; syncing: boolean;
}
interface Brief { shortName: string; title: string; count: number; kind: string; official: boolean; added: boolean; cover: string }
interface Preview { shortName: string; title: string; count: number; kind: string; official: boolean; added: boolean; samples: { emoji: string; thumb: string }[] }
interface Item { id: string; format: string; url: string; thumb: string; w: number; h: number; emoji: string; size: number }

const sets = ref<SetRow[]>([]);
const input = ref('');
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const adding = ref(false);
const featured = ref<Brief[]>([]);
const featuredLoading = ref(false);
const openItems = ref<{ set: SetRow; items: Item[] } | null>(null);
let timer: any = null;

const KIND: Record<string, string> = { static: '静态', animated: '动态', video: '视频' };

async function load() {
  sets.value = await api<SetRow[]>('/admin/stickers/sets');
  const busy = sets.value.some((s) => s.syncing);
  if (busy && !timer) timer = setInterval(load, 4000);
  if (!busy && timer) { clearInterval(timer); timer = null; }
}
async function doPreview() {
  if (!input.value.trim()) return emit('toast', '请填写贴纸集链接或名称');
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await api<Preview>(`/admin/stickers/preview?name=${encodeURIComponent(input.value.trim())}`);
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    previewing.value = false;
  }
}
async function add(name: string) {
  adding.value = true;
  try {
    await api('/admin/stickers/sets', { method: 'POST', body: { name } });
    emit('toast', '已添加，正在后台下载转存（几十秒到几分钟）');
    preview.value = null;
    input.value = '';
    await load();
    featured.value = featured.value.map((b) => (b.shortName === name ? { ...b, added: true } : b));
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    adding.value = false;
  }
}
async function loadFeatured() {
  featuredLoading.value = true;
  try {
    featured.value = await api<Brief[]>('/admin/stickers/featured');
  } catch (e: any) {
    emit('toast', e.message);
  } finally {
    featuredLoading.value = false;
  }
}
async function toggle(s: SetRow) {
  await api(`/admin/stickers/sets/${s.id}`, { method: 'PUT', body: { enabled: !s.enabled } });
  load();
}
async function rename(s: SetRow) {
  const t = prompt('显示名称（面板里 tab 的提示文字）', s.title);
  if (t == null || !t.trim()) return;
  await api(`/admin/stickers/sets/${s.id}`, { method: 'PUT', body: { title: t.trim() } });
  load();
}
async function move(s: SetRow, dir: -1 | 1) {
  const ids = sets.value.map((x) => x.id);
  const i = ids.indexOf(s.id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api('/admin/stickers/reorder', { method: 'PUT', body: { ids } });
  load();
}
async function resync(s: SetRow) {
  try {
    await api(`/admin/stickers/sets/${s.id}/sync`, { method: 'POST' });
    emit('toast', '已开始重新同步（只补缺的）');
    load();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
async function remove(s: SetRow, purge: boolean) {
  const msg = purge
    ? `彻底删除「${s.title}」并删掉全部文件？用户已发出去的这套表情会变成裂图。`
    : `下架「${s.title}」？记录会删除，文件保留（已发出的表情仍能正常显示）。`;
  if (!confirm(msg)) return;
  try {
    await api(`/admin/stickers/sets/${s.id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
    emit('toast', purge ? '已彻底删除' : '已下架');
    load();
  } catch (e: any) {
    emit('toast', e.message);
  }
}
async function showItems(s: SetRow) {
  const items = await api<Item[]>(`/admin/stickers/sets/${s.id}/items`);
  openItems.value = { set: s, items };
}
function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
onMounted(() => { load(); if (props.loggedIn) loadFeatured(); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div>
    <div class="card">
      <div style="font-weight: 600; margin-bottom: 6px">表情包 · Telegram 贴纸集</div>
      <div class="muted" style="margin-bottom: 12px">
        聊天和评论里的表情面板内容。可以从下方「热门」里挑，或在 Telegram 里找到喜欢的贴纸集、粘贴 <b>t.me/addstickers/xxx</b> 链接 → <b>「解析」</b>看一眼内容 → 添加。
        整包下载转存到自己服务器（静态 WebP 原样、动态 TGS 转 Lottie、视频贴纸用 ffmpeg 转动态 WebP）。<b>最多 40 个</b>，面板 tab 按下面的顺序排。
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 12px; align-items: center">
        <label class="muted">贴纸集 <input v-model="input" placeholder="https://t.me/addstickers/xxx 或 xxx" style="width: 340px" @keydown.enter="doPreview" /></label>
        <button class="small ghost" :disabled="previewing || !props.loggedIn" @click="doPreview">{{ previewing ? '解析中…' : '解析' }}</button>
        <button class="small" :disabled="!preview || adding || preview.added" @click="add(preview!.shortName)">{{ preview?.added ? '已添加' : adding ? '添加中…' : '添加' }}</button>
        <span v-if="!props.loggedIn" class="muted" style="color: #ffb020">先登录 Telegram 账号</span>
      </div>

      <div v-if="preview" style="margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <div class="row" style="gap: 10px; align-items: baseline">
          <span style="font-size: 16px; font-weight: 600">{{ preview.title }}</span>
          <span class="muted">{{ preview.shortName }} · {{ preview.count }} 张 · {{ KIND[preview.kind] }}<span v-if="preview.official"> · 官方</span></span>
        </div>
        <div class="grid-stk" style="margin-top: 10px">
          <div v-for="(s, i) in preview.samples" :key="i" class="stk"><img :src="s.thumb" /><span class="muted">{{ s.emoji }}</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row" style="gap: 8px; margin-bottom: 10px; align-items: center">
        <span style="font-weight: 600">Telegram 热门贴纸集</span>
        <button class="small ghost" :disabled="featuredLoading || !props.loggedIn" @click="loadFeatured">{{ featuredLoading ? '加载中…' : '刷新' }}</button>
        <span class="muted" style="font-size: 12px">官方榜基本都是动态（TGS）包；视频类的包从 Telegram 里复制链接到上面解析添加</span>
      </div>
      <div v-if="featuredLoading" class="muted">从 Telegram 拉热门榜（要下载封面，十来秒）…</div>
      <div class="grid-set">
        <div v-for="b in featured" :key="b.shortName" class="setcard">
          <img v-if="b.cover" :src="b.cover" />
          <div v-else class="nocover muted">无封面</div>
          <div style="flex: 1; min-width: 0">
            <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ b.title }}</div>
            <div class="muted" style="font-size: 12px">{{ b.count }} 张 · {{ KIND[b.kind] }}<span v-if="b.official"> · 官方</span></div>
            <div class="row" style="gap: 6px; margin-top: 6px">
              <button class="small ghost" @click="input = b.shortName; doPreview()">预览</button>
              <button class="small" :disabled="b.added || adding" @click="add(b.shortName)">{{ b.added ? '已添加' : '添加' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 10px">已收的表情包（{{ sets.length }}）</div>
      <table v-if="sets.length">
        <thead><tr><th></th><th>名称</th><th>类型</th><th>张数</th><th>状态</th><th>上次同步</th><th>错误</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sets" :key="s.id">
            <td><img v-if="s.thumb" :src="s.thumb" style="width: 40px; height: 40px; object-fit: contain" /></td>
            <td>
              <div>{{ s.title }}</div>
              <a :href="`https://t.me/addstickers/${s.shortName}`" target="_blank" class="muted" style="font-size: 12px">{{ s.shortName }}</a>
            </td>
            <td class="muted">{{ KIND[s.kind] }}</td>
            <td>
              <span :style="s.stickers < s.count ? 'color:#ffb020' : ''">{{ s.stickers }}</span><span class="muted"> / {{ s.count }}</span>
              <span v-if="s.syncing" class="muted"> 同步中…</span>
            </td>
            <td><span class="tag" :class="s.enabled ? 'ok' : 'off'">{{ s.enabled ? '启用' : '停用' }}</span></td>
            <td class="muted">{{ s.lastSyncAt ? fmt(s.lastSyncAt) : '—' }}</td>
            <td class="muted" style="max-width: 220px; color: #ff6b6b; font-size: 12px">{{ s.lastError }}</td>
            <td>
              <div class="row" style="flex-wrap: wrap; gap: 4px">
                <button class="small ghost" @click="move(s, -1)">↑</button>
                <button class="small ghost" @click="move(s, 1)">↓</button>
                <button class="small ghost" @click="showItems(s)">查看</button>
                <button class="small ghost" @click="rename(s)">改名</button>
                <button class="small ghost" @click="toggle(s)">{{ s.enabled ? '停用' : '启用' }}</button>
                <button class="small ghost" :disabled="s.syncing || !props.loggedIn" @click="resync(s)">重新同步</button>
                <button class="small ghost" @click="remove(s, false)">下架</button>
                <button class="small ghost" style="color: #ff6b6b" @click="remove(s, true)">彻底删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted">还没有表情包，从上面挑几个添加</div>
    </div>

    <div v-if="openItems" class="modal-mask" @click.self="openItems = null">
      <div class="modal" style="max-width: 720px">
        <div class="row" style="justify-content: space-between; margin-bottom: 10px">
          <b>{{ openItems.set.title }} <span class="muted">（{{ openItems.items.length }} 张）</span></b>
          <button class="small ghost" @click="openItems = null">关闭</button>
        </div>
        <div class="grid-stk" style="max-height: 60vh; overflow: auto">
          <div v-for="it in openItems.items" :key="it.id" class="stk" :title="`${it.format} · ${Math.round(it.size / 1024)}KB`">
            <img :src="it.format === 'lottie' ? (it.thumb || '') : it.url" />
            <span class="muted">{{ it.emoji }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-stk { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
.stk { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 12px; }
.stk img { width: 64px; height: 64px; object-fit: contain; background: rgba(0,0,0,0.04); border-radius: 8px; }
.grid-set { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.setcard { display: flex; gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; align-items: center; }
.setcard img, .nocover { width: 64px; height: 64px; object-fit: contain; border-radius: 8px; background: rgba(0,0,0,0.04); flex-shrink: 0; }
.nocover { display: flex; align-items: center; justify-content: center; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: var(--card, #fff); border-radius: 12px; padding: 16px; width: 92vw; }
</style>
