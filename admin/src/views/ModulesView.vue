<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

interface AppModule {
  id?: number;
  name: string;
  icon: string;
  desc: string;
  cover: string;
  type: 'native' | 'h5' | 'game';
  entry: string;
  /** 小游戏屏幕方向：portrait 竖屏 / landscape 横屏（App 游戏页按此旋转） */
  orientation: 'portrait' | 'landscape';
  sort: number;
  enabled: boolean;
  visibleGender: number;
}

const modules = ref<AppModule[]>([]);
const editing = ref<AppModule | null>(null);
const toast = ref('');
const uploading = ref(false);

const banners = computed(() => modules.value.filter((m) => m.type !== 'game'));
const games = computed(() => modules.value.filter((m) => m.type === 'game'));
const isGame = computed(() => editing.value?.type === 'game');

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load() {
  modules.value = await api<AppModule[]>('/admin/modules');
}
onMounted(load);

function startAdd(type: AppModule['type']) {
  const list = type === 'game' ? games.value : banners.value;
  editing.value = { name: '', icon: '', desc: '', cover: '', type, entry: '', orientation: 'portrait', sort: list.length + 1, enabled: true, visibleGender: 0 };
}

async function save() {
  const m = editing.value;
  if (!m) return;
  if (!m.name || !m.entry) {
    showToast(isGame.value ? '请填写游戏名称与链接地址' : '请填写名称与入口');
    return;
  }
  if (isGame.value && !m.icon) {
    showToast('请上传游戏图标');
    return;
  }
  try {
    await api('/admin/modules', { method: 'POST', body: m });
    editing.value = null;
    showToast('已保存');
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggle(m: AppModule) {
  await api('/admin/modules', { method: 'POST', body: { ...m, enabled: !m.enabled } });
  load();
}

/** 图标/封面上传（图片，走免登录的 avatar 上传接口，与礼物图标一致） */
async function uploadImage(e: Event, field: 'icon' | 'cover') {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !editing.value) return;
  uploading.value = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload/avatar', { method: 'POST', body: form });
    const json = await res.json();
    if (json.code === 0) editing.value[field] = json.data.url;
    else showToast(json.msg || '上传失败');
  } catch {
    showToast('上传失败');
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

function pickFile(e: Event) {
  (e.currentTarget as HTMLElement).parentElement?.querySelector('input')?.click();
}

function genderText(g: number) {
  return g === 0 ? '全部' : g === 1 ? '仅男' : '仅女';
}
</script>

<template>
  <div>
    <div class="page-title">项目大厅管理</div>

    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <div>
          <div style="font-weight: 600">横幅项目</div>
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            每个项目一张横幅卡。type=native 为客户端内置页（入口填路由标识，如 guide）；type=h5 填完整网址
          </div>
        </div>
        <span style="flex: 1"></span>
        <button class="small" @click="startAdd('h5')">新增项目</button>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>名称</th><th>类型</th><th>入口</th><th>可见性别</th><th>排序</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in banners" :key="m.id">
            <td>{{ m.id }}</td>
            <td>{{ m.name }}</td>
            <td>{{ m.type }}</td>
            <td class="muted">{{ m.entry }}</td>
            <td>{{ genderText(m.visibleGender) }}</td>
            <td>{{ m.sort }}</td>
            <td><span class="tag" :class="m.enabled ? 'ok' : 'off'">{{ m.enabled ? '上架' : '下架' }}</span></td>
            <td>
              <div class="row">
                <button class="small ghost" @click="editing = { ...m }">编辑</button>
                <button class="small ghost" @click="toggle(m)">{{ m.enabled ? '下架' : '上架' }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="banners.length === 0"><td colspan="8" class="muted">暂无项目</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <div>
          <div style="font-weight: 600">小游戏</div>
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            大厅以宫格展示：图标 + 名称 + 说明。点击后 App 内原生全屏 WebView 打开链接（按「竖屏/横屏」自动旋转，仅游戏页生效），网页端新标签打开。
            链接支持占位符 <code>{token}</code>、<code>{uid}</code>（打开时替换为当前用户登录态/ID，仅自有游戏使用）
          </div>
        </div>
        <span style="flex: 1"></span>
        <button class="small" @click="startAdd('game')">新增小游戏</button>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>图标</th><th>名称</th><th>说明</th><th>链接地址</th><th>屏幕</th><th>可见性别</th><th>排序</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in games" :key="m.id">
            <td>{{ m.id }}</td>
            <td><img v-if="m.icon" :src="m.icon" style="width: 40px; height: 40px; border-radius: 10px; object-fit: cover" /></td>
            <td>{{ m.name }}</td>
            <td class="muted" style="max-width: 220px">{{ m.desc }}</td>
            <td class="muted" style="max-width: 260px; word-break: break-all">{{ m.entry }}</td>
            <td>{{ m.orientation === 'landscape' ? '横屏' : '竖屏' }}</td>
            <td>{{ genderText(m.visibleGender) }}</td>
            <td>{{ m.sort }}</td>
            <td><span class="tag" :class="m.enabled ? 'ok' : 'off'">{{ m.enabled ? '上架' : '下架' }}</span></td>
            <td>
              <div class="row">
                <button class="small ghost" @click="editing = { ...m }">编辑</button>
                <button class="small ghost" @click="toggle(m)">{{ m.enabled ? '下架' : '上架' }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="games.length === 0"><td colspan="10" class="muted">暂无小游戏</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="editing" class="card">
      <div class="page-title" style="font-size: 15px">
        {{ editing.id ? '编辑' : '新增' }}{{ isGame ? '小游戏' : '项目' }}
      </div>

      <!-- 小游戏：图标 + 名称 + 链接 + 说明 -->
      <template v-if="isGame">
        <div class="row" style="flex-wrap: wrap; gap: 14px; align-items: center">
          <img v-if="editing.icon" :src="editing.icon" style="width: 56px; height: 56px; border-radius: 12px; object-fit: cover" />
          <div v-else style="width: 56px; height: 56px; border-radius: 12px; background: #2a2a30"></div>
          <label style="cursor: pointer">
            <input type="file" accept="image/*" hidden @change="uploadImage($event, 'icon')" />
            <button class="small ghost" type="button" :disabled="uploading" @click.prevent="pickFile">
              {{ uploading ? '上传中…' : '上传图标' }}
            </button>
          </label>
          <input v-model="editing.icon" placeholder="或直接填图标 URL" style="width: 280px" />
        </div>
        <div class="row" style="flex-wrap: wrap; gap: 14px; margin-top: 14px">
          <input v-model="editing.name" placeholder="游戏名称" style="width: 160px" maxlength="30" />
          <input v-model="editing.entry" placeholder="链接地址（https://…）" style="width: 360px" />
          <select v-model="editing.orientation" title="App 打开游戏页时按此方向旋转屏幕">
            <option value="portrait">竖屏游戏</option>
            <option value="landscape">横屏游戏</option>
          </select>
          <select v-model.number="editing.visibleGender">
            <option :value="0">全部可见</option>
            <option :value="1">仅男</option>
            <option :value="2">仅女</option>
          </select>
          <input v-model.number="editing.sort" type="number" placeholder="排序" style="width: 90px" />
        </div>
        <div class="row" style="margin-top: 14px">
          <input v-model="editing.desc" placeholder="游戏说明（一句话，宫格下方展示）" style="width: 560px" maxlength="100" />
        </div>
      </template>

      <!-- 横幅项目 -->
      <template v-else>
        <div class="row" style="flex-wrap: wrap; gap: 14px">
          <input v-model="editing.name" placeholder="项目名称" style="width: 140px" maxlength="30" />
          <input v-model="editing.desc" placeholder="项目简介（横幅副标题）" style="width: 240px" maxlength="100" />
          <input v-model="editing.cover" placeholder="封面图 URL（空则用渐变）" style="width: 240px" />
          <label style="cursor: pointer">
            <input type="file" accept="image/*" hidden @change="uploadImage($event, 'cover')" />
            <button class="small ghost" type="button" :disabled="uploading" @click.prevent="pickFile">
              {{ uploading ? '上传中…' : '上传封面' }}
            </button>
          </label>
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
      </template>

      <div class="row" style="margin-top: 14px">
        <button @click="save">保存</button>
        <button class="ghost" @click="editing = null">取消</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
