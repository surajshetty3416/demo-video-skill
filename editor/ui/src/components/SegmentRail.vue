<template>
  <aside
    class="flex w-44 flex-none flex-col gap-3 overflow-y-auto border-r border-outline-gray-1 bg-surface-base p-3"
  >
    <div
      v-for="name in ui.order"
      :key="name"
      class="cursor-pointer"
      draggable="true"
      @click="engine.loadSegment(name)"
      @dragstart="dragFrom = name"
      @dragover.prevent="dragOver = name"
      @dragleave="dragOver = null"
      @drop.prevent="drop(name)"
    >
      <img
        :src="`/api/segment/${encodeURIComponent(name)}/frame/0`"
        class="pointer-events-none block w-full rounded-lg"
        :class="
          name === ui.seg
            ? 'ring-2 ring-outline-gray-7'
            : dragOver === name
              ? 'ring-2 ring-outline-gray-4'
              : 'ring-1 ring-outline-gray-2'
        "
        loading="lazy"
      />
      <div class="mt-1 flex items-baseline justify-between gap-1.5">
        <span
          class="truncate text-sm"
          :class="name === ui.seg ? 'font-medium text-ink-gray-9' : 'text-ink-gray-7'"
        >
          {{ name }}
          <span
            v-if="isDirty(name)"
            class="mb-px ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-surface-gray-7"
            title="has edits"
          ></span>
        </span>
        <span class="text-sm tabular-nums text-ink-gray-5">{{ segSeconds(name) }}</span>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref } from "vue";
import * as engine from "../editor/engine.js";
import { ui } from "../editor/engine.js";

const dragFrom = ref(null);
const dragOver = ref(null);

function drop(target) {
  dragOver.value = null;
  const from = dragFrom.value;
  if (!from || from === target) return;
  const arr = ui.order.filter((n) => n !== from);
  arr.splice(arr.indexOf(target), 0, from);
  engine.setOrder(arr);
}
function segSeconds(name) {
  ui.rev;
  if (name === ui.seg && engine.state.path)
    return `${(engine.state.path.bodyLen / (engine.state.meta.fps || 60)).toFixed(1)}s`;
  const info = ui.segments.find((s) => s.name === name);
  return info ? `${(info.playFrames / info.fps).toFixed(1)}s` : "";
}
function isDirty(name) {
  const info = ui.segments.find((s) => s.name === name);
  return (name === ui.seg && ui.dirty) || info?.hasEdits;
}
</script>
