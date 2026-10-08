<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import ListPager from '../components/ListPager.vue';

const users = ref<any[]>([]);
const keyword = ref('');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const CATS = [
  { key: 'normal', label: '正常' },
  { key: 'male', label: '男' },
  { key: 'female', label: '女' },
  { key: 'guide', label: '地陪' },
  { key: 'hidden', label: '已隐藏' },
  { key: 'banned', label: '已封禁' },
  { key: 'bot', label: '机器人 / 系统' },
  { key: 'all', label: '全部' },
];
const cat = ref('normal');
const counts = ref<Record<string, number>>({});
const grantFor = ref<any>(null);
const amount = ref('');
const remark = ref('');
const toast = ref('');
const txFor = ref<any>(null);
const txs = ref<any[]>([]);
const txHasMore = ref(false);
const txLoading = ref(false);

const TX_TYPE_LABEL: Record<string, string> = {
  admin_grant: '后台发放',
  adjust: '后台扣减',
  gift_send: '送出礼物',
  gift_recv: '收到礼物',
  task_freeze: '约单托管',
  task_settle: '约单结算',
  task_refund: '约单退回',
  msg_fee: '发送消息',
  msg_income: '消息收入',
  call_fee: '视频通话',
  call_income: '通话收入',
  transfer_out: '转赠支出',
  transfer_in: '收到转赠',
};

async function openTxs(u: any) {
  txFor.value = u;
  txs.value = [];
  txHasMore.value = false;
  await loadTxs();
}

async function loadTxs() {
  if (!txFor.value || txLoading.value) return;
  txLoading.value = true;
  try {
    const last = txs.value[txs.value.length - 1];
    const list = await api<any[]>(
      `/admin/users/${txFor.value.id}/transactions${last ? `?beforeId=${last.id}` : ''}`,
    );
    txs.value = [...txs.value, ...list];
    txHasMore.value = list.length >= 30;
  } catch (e: any) {
    showToast(e.message);
  } finally {
    txLoading.value = false;
  }
}

function showToast(t: string) {
  toast.value = t;
  setTimeout(() => (toast.value = ''), 1800);
}

const defaultChannelLimit = ref(5);
const limitFor = ref<any>(null);
const limitInput = ref('');

async function load() {
  const qs = new URLSearchParams({ cat: cat.value, page: String(page.value), size: String(size.value) });
  if (keyword.value.trim()) qs.set('keyword', keyword.value.trim());
  const r = await api<{ list: any[]; total: number; counts: Record<string, number> }>(`/admin/users?${qs}`);
  // 封禁 / 解封后当前分类少了一条，页码可能越界：退回最后一页
  if (!r.list.length && r.total > 0 && page.value > 1) {
    page.value = Math.ceil(r.total / size.value);
    return load();
  }
  users.value = r.list;
  total.value = r.total;
  counts.value = r.counts;
}
function search() {
  page.value = 1;
  load();
}
function pickCat(k: string) {
  cat.value = k;
  search();
}
function onPage(p: number, s: number) {
  page.value = p;
  size.value = s;
  load();
}
onMounted(async () => {
  load();
  defaultChannelLimit.value = (await api<{ defaultLimit: number }>('/admin/channels/config')).defaultLimit;
  walletMode.value = (await api<{ mode: WalletMode }>('/admin/chain-wallet/config')).mode;
});

// 链上钱包入口（自托管网页钱包，私钥只在用户手机上；这里只控制 App 里显不显示入口）
type WalletMode = 'off' | 'per_user' | 'all';
const WALLET_MODES: WalletMode[] = ['off', 'per_user', 'all'];
const WALLET_MODE_LABEL: Record<WalletMode, string> = { off: '全部关闭', per_user: '按用户开启', all: '全部开放' };
const walletMode = ref<WalletMode>('per_user');

async function saveWalletMode(mode: WalletMode) {
  try {
    walletMode.value = (await api<{ mode: WalletMode }>('/admin/chain-wallet/config', { method: 'POST', body: { mode } })).mode;
    showToast(`钱包入口：${WALLET_MODE_LABEL[walletMode.value]}`);
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggleWallet(u: any) {
  try {
    const r = await api<{ walletEnabled: boolean }>(`/admin/users/${u.id}/wallet`, { method: 'POST', body: { enabled: !u.walletEnabled } });
    u.walletEnabled = r.walletEnabled;
    showToast(`「${u.nickname}」钱包已${r.walletEnabled ? '开启' : '关闭'}`);
  } catch (e: any) {
    showToast(e.message);
  }
}

function openLimit(u: any) {
  limitFor.value = u;
  limitInput.value = u.channelLimit == null ? '' : String(u.channelLimit);
}

async function saveLimit() {
  if (!limitFor.value) return;
  const raw = limitInput.value.trim();
  const n = raw === '' ? null : Number(raw);
  if (n !== null && (!Number.isInteger(n) || n < 0 || n > 1000)) return showToast('请填写 0 ~ 1000 的整数，留空为跟随默认');
  try {
    await api(`/admin/users/${limitFor.value.id}/channel-limit`, { method: 'POST', body: { limit: n } });
    limitFor.value.channelLimit = n;
    showToast(n === null ? `已恢复跟随默认（${defaultChannelLimit.value} 个）` : `已设为最多 ${n} 个频道`);
    limitFor.value = null;
  } catch (e: any) {
    showToast(e.message);
  }
}

async function grant() {
  if (!grantFor.value || !amount.value) return;
  try {
    // 输入积分（可小数），接口按分
    const fen = Math.round(parseFloat(amount.value) * 100);
    await api(`/admin/users/${grantFor.value.id}/grant`, {
      method: 'POST',
      body: { amount: String(fen), remark: remark.value },
    });
    showToast('积分已发放');
    grantFor.value = null;
    amount.value = '';
    remark.value = '';
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggleBan(u: any) {
  if (u.status === 0 && !confirm(`封禁「${u.nickname}」？封禁后不能登录、发消息`)) return;
  try {
    await api(`/admin/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 0 ? 1 : 0 } });
    showToast(`「${u.nickname}」已${u.status === 0 ? '封禁' : '解封'}`);
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

async function toggleHidden(u: any) {
  const hidden = !u.hidden;
  if (hidden && !confirm(`隐藏「${u.nickname}」？\n\n隐藏后 TA 不出现在 App 的遇见、找地陪、找人、搜索用户和动态广场里；已有的聊天、群、关注不受影响，TA 自己照常使用。随时可以取消隐藏。`)) return;
  try {
    await api(`/admin/users/${u.id}/hidden`, { method: 'POST', body: { hidden } });
    showToast(`「${u.nickname}」已${hidden ? '隐藏' : '取消隐藏'}`);
    load();
  } catch (e: any) {
    showToast(e.message);
  }
}

// 「操作」下拉：菜单挂在 body 上用 fixed 定位，免得被表格的横向滚动裁掉
const menuFor = ref<any>(null);
const menuPos = ref({ top: 0, left: 0 });
const MENU_W = 150;
const MENU_H = 5 * 36 + 8;
function openMenu(u: any, e: MouseEvent) {
  if (menuFor.value?.id === u.id) return closeMenu();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const top = r.bottom + 4 + MENU_H > window.innerHeight ? Math.max(8, r.top - 4 - MENU_H) : r.bottom + 4;
  menuPos.value = { top, left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)) };
  menuFor.value = u;
}
function closeMenu() {
  menuFor.value = null;
}
function reveal(sel: string) {
  nextTick(() => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function act(kind: 'grant' | 'txs' | 'limit' | 'hide' | 'ban') {
  const u = menuFor.value;
  closeMenu();
  if (!u) return;
  if (kind === 'grant') { grantFor.value = u; reveal('[data-panel="grant"]'); }
  else if (kind === 'txs') { openTxs(u); reveal('[data-panel="txs"]'); }
  else if (kind === 'limit') { openLimit(u); reveal('[data-panel="limit"]'); }
  else if (kind === 'hide') toggleHidden(u);
  else toggleBan(u);
}
onMounted(() => {
  window.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
});
onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
});
</script>

<template>
  <div>
    <div class="page-title">用户管理</div>
    <div class="card">
      <div class="row" style="margin-bottom: 14px">
        <input v-model="keyword" placeholder="昵称 / 地址 / 6 位 ID 搜索" style="width: 260px" data-testid="user-search" @keydown.enter="search" />
        <button class="small" @click="search">搜索</button>
        <span class="muted" style="margin-left: auto">链上钱包入口</span>
        <button
          v-for="m in WALLET_MODES"
          :key="m"
          class="small"
          :class="{ ghost: walletMode !== m }"
          @click="saveWalletMode(m)"
        >
          {{ WALLET_MODE_LABEL[m] }}
        </button>
      </div>
      <div class="muted" style="margin: -6px 0 12px">
        钱包是自托管的（私钥只在用户手机上），这里只控制 App 里显不显示钱包入口；关掉入口冻结不了用户的钱。「按用户开启」时看下表「钱包」列。
      </div>
      <div class="cat-tabs">
        <button v-for="c in CATS" :key="c.key" :class="{ ghost: cat !== c.key }" :data-testid="`user-cat-${c.key}`" @click="pickCat(c.key)">
          {{ c.label }}<span class="n">{{ counts[c.key] ?? 0 }}</span>
        </button>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>6 位 ID</th><th>昵称</th><th>性别</th><th>年纪</th><th>地址</th><th>地陪</th><th>频道</th><th>钱包</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.id }}</td>
            <td style="font-family: monospace">{{ u.shortId || '—' }}</td>
            <td>{{ u.nickname }}</td>
            <td>{{ u.isBot ? '机器人' : u.gender === 1 ? '男' : u.gender === 2 ? '女' : '—' }}</td>
            <td>{{ u.age }}</td>
            <td class="muted">{{ u.address.slice(0, 8) }}…{{ u.address.slice(-4) }}</td>
            <td>{{ u.isGuide ? '是' : '-' }}</td>
            <td :title="u.channelLimit == null ? '跟随全局默认' : '单独设置'">
              {{ u.ownedChannels ?? 0 }} / {{ u.channelLimit ?? defaultChannelLimit }}
              <span v-if="u.channelLimit != null" class="tag ok" style="margin-left: 4px">单独</span>
            </td>
            <td :title="walletMode === 'per_user' ? '' : `全局为「${WALLET_MODE_LABEL[walletMode]}」，单人设置暂不生效`">
              <button class="small" :class="{ ghost: !u.walletEnabled }" @click="toggleWallet(u)">{{ u.walletEnabled ? '已开' : '关' }}</button>
            </td>
            <td style="white-space: nowrap">
              <span class="tag" :class="u.status === 0 ? 'ok' : 'off'">{{ u.status === 0 ? '正常' : '封禁' }}</span>
              <span v-if="u.hidden" class="tag warn" style="margin-left: 4px" title="App 的遇见 / 找人 / 搜索 / 动态广场里不显示">已隐藏</span>
            </td>
            <td>
              <button class="small ghost" :class="{ 'menu-open': menuFor?.id === u.id }" :data-testid="`user-ops-${u.id}`" style="white-space: nowrap" @click.stop="openMenu(u, $event)">操作 ▾</button>
            </td>
          </tr>
          <tr v-if="users.length === 0"><td colspan="11" class="muted">没有符合条件的用户</td></tr>
        </tbody>
      </table>
      <ListPager :total="total" :page="page" :size="size" @change="onPage" />
    </div>

    <Teleport to="body">
      <div v-if="menuFor" class="dropdown-menu" :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px`, width: `${MENU_W}px` }" data-testid="user-ops-menu" @click.stop>
        <div class="dropdown-item" @click="act('grant')">发积分</div>
        <div class="dropdown-item" @click="act('txs')">积分明细</div>
        <div class="dropdown-item" @click="act('limit')">频道额度</div>
        <div class="dropdown-item" data-testid="user-op-hide" @click="act('hide')">{{ menuFor.hidden ? '取消隐藏' : '隐藏' }}</div>
        <div class="dropdown-item danger" data-testid="user-op-ban" @click="act('ban')">{{ menuFor.status === 0 ? '封禁' : '解封' }}</div>
      </div>
    </Teleport>

    <div v-if="grantFor" class="card" data-panel="grant">
      <div class="page-title" style="font-size: 15px">给「{{ grantFor.nickname }}」发放积分（可小数，负数为扣减）</div>
      <div class="row">
        <input v-model="amount" placeholder="积分数量，如 100 或 0.5" style="width: 160px" />
        <input v-model="remark" placeholder="备注（可选）" style="width: 220px" />
        <button @click="grant">发放</button>
        <button class="ghost" @click="grantFor = null">取消</button>
      </div>
    </div>

    <div v-if="limitFor" class="card" data-panel="limit">
      <div class="page-title" style="font-size: 15px">
        「{{ limitFor.nickname }}」最多能创建几个频道（已建 {{ limitFor.ownedChannels ?? 0 }} 个）
      </div>
      <div class="row">
        <input v-model="limitInput" type="number" min="0" max="1000" :placeholder="`留空 = 跟随默认 ${defaultChannelLimit} 个`" style="width: 200px" @keydown.enter="saveLimit" />
        <button @click="saveLimit">保存</button>
        <button class="ghost" @click="limitInput = ''">恢复默认</button>
        <button class="ghost" @click="limitFor = null">取消</button>
        <span class="muted">填 0 = 不能再创建；已建的频道不受影响</span>
      </div>
    </div>

    <div v-if="txFor" class="card" data-panel="txs">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <div class="page-title" style="font-size: 15px; margin: 0">「{{ txFor.nickname }}」积分明细（单位：积分）</div>
        <button class="small ghost" @click="txFor = null">关闭</button>
      </div>
      <table>
        <thead>
          <tr><th>时间</th><th>类型</th><th>变动</th><th>变动后余额</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in txs" :key="t.id">
            <td class="muted">{{ new Date(t.createdAt).toLocaleString() }}</td>
            <td>{{ TX_TYPE_LABEL[t.type] ?? t.type }}</td>
            <td :style="{ color: Number(t.amount) >= 0 ? '#2e9e5b' : '#d64545' }">
              {{ Number(t.amount) >= 0 ? '+' : '' }}{{ (Number(t.amount) / 100).toFixed(2) }}
            </td>
            <td>{{ (Number(t.balanceAfter) / 100).toFixed(2) }}</td>
            <td class="muted">{{ t.remark }}</td>
          </tr>
          <tr v-if="!txs.length && !txLoading"><td colspan="5" class="muted">暂无记录</td></tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px">
        <button v-if="txHasMore" class="small ghost" :disabled="txLoading" @click="loadTxs">
          {{ txLoading ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
