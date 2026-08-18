<template>
  <section class="flex min-w-0 flex-1 flex-col">
    <div
      ref="wrap"
      class="relative flex min-h-0 flex-1 items-center justify-center bg-surface-gray-1"
    >
      <canvas
        ref="canvas"
        class="rounded-lg ring-1 ring-outline-gray-2"
        @pointerdown="engine.previewPointerDown"
        @wheel.prevent="engine.previewWheel"
      ></canvas>
      <div
        v-if="ui.sel && ui.sel.type === 'cam'"
        class="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-outline-gray-2 bg-surface-base/90 px-3 py-1 text-xs text-ink-gray-6"
      >
        click sets focus · scroll sets zoom
      </div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, ref } from "vue";
import * as engine from "../editor/engine.js";
import { ui } from "../editor/engine.js";

const wrap = ref(null);
const canvas = ref(null);

onMounted(() => {
  engine.registerCanvases({ preview: canvas.value, previewWrap: wrap.value });
});
</script>
