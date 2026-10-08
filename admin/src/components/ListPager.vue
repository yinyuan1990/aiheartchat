<script setup lang="ts">
import { computed } from 'vue';

/** 列表分页：上一页 / 页码 / 下一页 + 每页条数 */
const props = defineProps<{ total: number; page: number; size: number }>();
const emit = defineEmits<{ (e: 'change', page: number, size: number): void }>();
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)));
const nums = computed(() => {
  const set = new Set([1, pages.value, props.page - 1, props.page, props.page + 1]);
  return [...set].filter((n) => n >= 1 && n <= pages.value).sort((a, b) => a - b);
});
function go(p: number) {
  if (p >= 1 && p <= pages.value && p !== props.page) emit('change', p, props.size);
}
</script>

<template>
  <div class="pager">
    <span class="muted">共 {{ total }} 个 · 第 {{ page }} / {{ pages }} 页</span>
    <button class="small ghost" :disabled="page <= 1" data-testid="pager-prev" @click="go(page - 1)">上一页</button>
    <template v-for="(n, i) in nums" :key="n">
      <span v-if="i > 0 && n - nums[i - 1] > 1" class="muted">…</span>
      <button class="small" :class="{ ghost: n !== page }" @click="go(n)">{{ n }}</button>
    </template>
    <button class="small ghost" :disabled="page >= pages" data-testid="pager-next" @click="go(page + 1)">下一页</button>
    <select :value="size" @change="emit('change', 1, Number(($event.target as HTMLSelectElement).value))">
      <option :value="20">20 / 页</option>
      <option :value="50">50 / 页</option>
      <option :value="100">100 / 页</option>
    </select>
  </div>
</template>
