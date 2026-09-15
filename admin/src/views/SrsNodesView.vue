<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';

interface Node {
  id: number;
  name: string;
  ip: string;
  apiPort: number;
  priority: number;
  maxConnections: number;
  enabled: boolean;
  isDefault: boolean;
  remark: string;
  /** 当前连接数（通话人数 + 语音房人数） */
  current: number;
  updatedAt: string;
}

const nodes = ref<Node[]>([]);
const envFallback = ref<{ srsServer: string; srsApi: string }>({ srsServer: '', srsApi: '' });
const toast = ref('');
let timer: number | undefined;

const blank = () => ({ name: '', ip: '', apiPort: 1985, priority: 100, maxConnections: 40, enabled: true, remark: '' });
const form = ref<any>(blank());
const editing = ref<Node | null>(null);

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

async function load() {
  const r = await api<{ envFallback: any; nodes: Node[] }>('/admin/srs-nodes');
  nodes.value = r.nodes;
  envFallback.value = r.envFallback;
}
onMounted(() => {
  load();
  // 负载 10 秒刷一次
  timer = window.setInterval(load, 10_000);
});
onUnmounted(() => timer && clearInterval(timer));

async function save() {
  try {
    if (editing.value) {
      await api(`/admin/srs-nodes/${editing.value.id}`, { method: 'POST', body: form.value });
      showToast('已保存');
    } else {
      await api('/admin/srs-nodes', { method: 'POST', body: form.value });
      showToast('已添加');
    }
    cancel();
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

function startEdit(n: Node) {
  editing.value = n;
  form.value = { name: n.name, ip: n.ip, apiPort: n.apiPort, priority: n.priority, maxConnections: n.maxConnections, enabled: n.enabled, remark: n.remark };
}

function cancel() {
  editing.value = null;
  form.value = blank();
}

async function toggle(n: Node) {
  await api(`/admin/srs-nodes/${n.id}`, { method: 'POST', body: { enabled: !n.enabled } });
  load();
}

async function setDefault(n: Node) {
  await api(`/admin/srs-nodes/${n.id}/default`, { method: 'POST' });
  showToast(`默认节点已设为 ${n.ip}`);
  load();
}

async function remove(n: Node) {
  if (!confirm(`删除节点 ${n.ip}？\n进行中的通话不受影响，之后不再分配到该节点。`)) return;
  try {
    await api(`/admin/srs-nodes/${n.id}/delete`, { method: 'POST' });
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

function ratio(n: Node) {
  return Math.min(100, Math.round((n.current / Math.max(1, n.maxConnections)) * 100));
}
</script>

<template>
  <div>
    <div class="page-title">SRS 节点</div>

    <div class="card">
      <div class="muted" style="line-height: 1.8">
        通话 / 语音房发起时按 <b>优先级</b>（越小越优先）顺序选第一个 <b>当前连接数 &lt; 最大连接数</b> 的节点；全部满了取负载率最低的。<br />
        连接数 = 该节点上通话中的人数（每路通话 2 人）+ 语音房在房人数。所有节点安装路径、端口一致，只有 IP 不同。<br />
        <b>默认节点</b>：部署工具新装节点时以它为复制源（源码、配置、systemd、nginx 规则）。第一个节点下线后把默认换到别的节点即可。<br />
        <span v-if="envFallback.srsServer">表为空时兜底用环境变量：SRS_SERVER={{ envFallback.srsServer }}，SRS_API={{ envFallback.srsApi }}</span>
      </div>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 12px">{{ editing ? `编辑节点 #${editing.id}` : '添加节点' }}</div>
      <div class="row" style="flex-wrap: wrap; gap: 10px">
        <input v-model="form.name" placeholder="名称（如 香港CN2）" style="width: 160px" />
        <input v-model="form.ip" placeholder="公网 IP" style="width: 160px" />
        <input v-model.number="form.apiPort" type="number" placeholder="API 端口" style="width: 100px" title="HTTP API / WHIP / WHEP 端口，默认 1985" />
        <input v-model.number="form.priority" type="number" placeholder="优先级" style="width: 90px" title="越小越优先" />
        <input v-model.number="form.maxConnections" type="number" placeholder="最大连接数" style="width: 110px" />
        <label class="row" style="gap: 4px"><input type="checkbox" v-model="form.enabled" style="width: auto" /> 启用</label>
        <input v-model="form.remark" placeholder="备注" style="width: 220px" />
        <button @click="save">{{ editing ? '保存' : '添加' }}</button>
        <button v-if="editing" class="ghost" @click="cancel">取消</button>
      </div>
      <div class="muted" style="margin-top: 8px">新节点建议先按“优先级 200、最大连接数 40、启用”加入观察，稳定后再把优先级调到老节点之前。</div>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 12px">节点列表（每 10 秒刷新负载）</div>
      <table>
        <thead>
          <tr><th>ID</th><th>名称</th><th>IP</th><th>端口</th><th>优先级</th><th style="min-width: 180px">连接数 / 上限</th><th>状态</th><th>默认</th><th>备注</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="n in nodes" :key="n.id">
            <td>{{ n.id }}</td>
            <td>{{ n.name || '-' }}</td>
            <td style="font-family: Consolas, monospace">{{ n.ip }}</td>
            <td>{{ n.apiPort }}</td>
            <td>{{ n.priority }}</td>
            <td>
              <div class="row" style="gap: 8px">
                <div style="flex: 1; height: 8px; background: #26262c; border-radius: 4px; overflow: hidden">
                  <div :style="{ width: ratio(n) + '%', height: '100%', background: ratio(n) >= 100 ? 'var(--accent)' : ratio(n) >= 80 ? 'var(--warn)' : 'var(--success)' }"></div>
                </div>
                <span style="min-width: 70px; text-align: right">{{ n.current }} / {{ n.maxConnections }}</span>
              </div>
            </td>
            <td><span class="tag" :class="n.enabled ? 'ok' : 'off'">{{ n.enabled ? '启用' : '停用' }}</span></td>
            <td>
              <span v-if="n.isDefault" class="tag warn">默认</span>
              <button v-else class="small ghost" @click="setDefault(n)">设为默认</button>
            </td>
            <td class="muted" style="max-width: 200px">{{ n.remark }}</td>
            <td>
              <div class="row">
                <button class="small ghost" @click="startEdit(n)">编辑</button>
                <button class="small ghost" @click="toggle(n)">{{ n.enabled ? '停用' : '启用' }}</button>
                <button class="small ghost" @click="remove(n)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="nodes.length === 0"><td colspan="10" class="muted">暂无节点（当前用环境变量 SRS_SERVER 兜底）</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
