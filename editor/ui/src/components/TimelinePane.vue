<template>
  <footer
    class="relative flex flex-none border-t border-outline-gray-1 bg-surface-base"
    :style="{ height: footerH + 'px' }"
  >
    <div
      class="absolute -top-1 left-0 z-10 h-2 w-full cursor-row-resize"
      @pointerdown="startResize"
    ></div>
    <div class="relative w-40 flex-none border-r border-outline-gray-1">
      <div class="flex items-center gap-2 px-3" :style="{ height: transportH + 'px' }">
        <Button
          variant="ghost"
          :icon="ui.playing ? IconPause : IconPlay"
          :label="ui.playing ? 'Pause' : 'Play'"
          @click="engine.togglePlay()"
        />
        <span class="whitespace-nowrap text-sm tabular-nums">
          <span class="text-ink-gray-8">{{ ui.timeCur }}</span>
          <span class="text-ink-gray-5"> / {{ ui.timeTotal }}</span>
        </span>
      </div>
      <div
        v-for="t in gutterRows"
        :key="t.label"
        class="absolute left-0 flex w-full items-center justify-between px-3 text-xs text-ink-gray-6"
        :style="{ top: t.top + 'px', height: t.h + 'px' }"
      >
        {{ t.label }}
        <button
          v-if="t.label === 'Events'"
          class="flex h-4.5 w-4.5 items-center justify-center rounded text-ink-gray-5 hover:bg-surface-gray-2 hover:text-ink-gray-8"
          title="Add caption at playhead"
          @click="engine.addCaptionAtPlayhead()"
        >
          <IconPlus class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <ContextMenu :options="ui.ctxOptions">
      <div
        ref="wrap"
        class="h-full min-w-0 flex-1"
        @contextmenu="engine.buildContextMenu"
      >
        <canvas
          ref="canvas"
          class="block h-full w-full"
          @pointerdown="engine.tlPointerDown"
          @pointermove="engine.tlPointerMove"
          @pointerup="engine.tlPointerUp"
          @wheel="engine.tlWheel"
        ></canvas>
      </div>
    </ContextMenu>
  </footer>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { Button, ContextMenu } from "frappe-ui";
import IconPlay from "~icons/lucide/play";
import IconPause from "~icons/lucide/pause";
import IconPlus from "~icons/lucide/plus";
import * as engine from "../editor/engine.js";
import { TL, TL_TRACKS, TL_MIN_H, TL_MAX_H, ui } from "../editor/engine.js";

const wrap = ref(null);
const canvas = ref(null);

const stored = parseInt(localStorage.getItem("tlHeight"), 10);
const footerH = ref(
  Math.min(TL_MAX_H, Math.max(TL_MIN_H, stored || TL_MIN_H))
);
watch(footerH, (h) => engine.setTimelineHeight(h), { flush: "sync" });
engine.setTimelineHeight(footerH.value);

// depend on footerH so the gutter re-reads TL after the sync relayout above
const gutterRows = computed(() =>
  (footerH.value, TL_TRACKS.map((t) => ({ label: t.label, top: t.row[0], h: t.row[1] })))
);
const transportH = computed(() => (footerH.value, TL.CAM[0]));

function startResize(e) {
  e.preventDefault();
  const startY = e.clientY, startH = footerH.value;
  const move = (ev) => {
    footerH.value = Math.min(TL_MAX_H, Math.max(TL_MIN_H, startH + (startY - ev.clientY)));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    localStorage.setItem("tlHeight", String(footerH.value));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

onMounted(() => {
  engine.registerCanvases({ timeline: canvas.value, timelineWrap: wrap.value });
});
</script>
