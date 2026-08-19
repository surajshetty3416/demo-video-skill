<template>
  <div
    v-if="ui.render.open"
    class="fixed bottom-48 right-3 z-40 w-96 rounded-lg border border-outline-gray-2 bg-surface-base shadow-xl"
  >
    <div class="flex items-center justify-between px-4 pb-1 pt-3">
      <div class="flex items-center gap-2">
        <IconLoader v-if="running" class="h-4 w-4 animate-spin text-ink-gray-6" />
        <IconCheck v-else-if="done" class="h-4 w-4 text-ink-gray-9" />
        <IconAlert v-else class="h-4 w-4 text-ink-gray-9" />
        <span class="text-base font-medium text-ink-gray-9">{{ title }}</span>
      </div>
      <Button variant="ghost" :icon="IconX" label="Close" @click="ui.render.open = false" />
    </div>

    <div class="px-4 pb-3">
      <template v-if="running">
        <div class="mt-2 flex items-center justify-between text-xs text-ink-gray-6">
          <span>{{ stageLabel }}</span>
          <span class="tabular-nums">{{ ui.render.progress }}%</span>
        </div>
        <Progress class="mt-1.5" :value="ui.render.progress" size="sm" :label="false" />
        <div v-if="ui.render.segments.length > 1" class="mt-2 space-y-1">
          <div
            v-for="s in ui.render.segments"
            :key="s.name"
            class="flex items-center justify-between text-xs"
          >
            <span :class="s.state === 'pending' ? 'text-ink-gray-4' : 'text-ink-gray-7'">
              {{ s.name === "combine" ? "Combine into one video" : disp(s.name) }}
            </span>
            <IconCheck v-if="s.state === 'done'" class="h-3.5 w-3.5 text-ink-gray-7" />
            <span v-else-if="s.state === 'running'" class="tabular-nums text-ink-gray-5">
              {{ s.total ? Math.round((s.frames / s.total) * 100) + "%" : "…" }}
            </span>
          </div>
        </div>
      </template>

      <template v-else-if="done">
        <div class="mt-2 space-y-1">
          <div
            v-for="o in ui.render.outputs"
            :key="o.url"
            class="flex items-center justify-between rounded bg-surface-gray-1 py-1.5 pl-2.5 pr-1.5"
          >
            <span class="text-xs text-ink-gray-8">{{ disp(o.label) }}</span>
            <div class="flex items-center gap-2">
              <span class="text-xs tabular-nums text-ink-gray-5">{{ fmtSize(o.bytes) }}</span>
              <Button size="sm" label="Open" @click="open(o.url)" />
            </div>
          </div>
        </div>
      </template>

      <p v-else class="mt-2 text-xs text-ink-gray-7">{{ ui.render.error }}</p>

      <button
        class="mt-2.5 flex items-center gap-1 text-xs text-ink-gray-5 hover:text-ink-gray-7"
        @click="details = !details"
      >
        <IconChevron class="h-3 w-3 transition-transform" :class="details ? 'rotate-90' : ''" />
        Details
      </button>
      <pre
        v-if="details"
        ref="log"
        class="mt-1.5 max-h-40 select-text overflow-y-auto whitespace-pre-wrap rounded bg-surface-gray-1 p-2 font-mono text-2xs leading-relaxed text-ink-gray-6"
        >{{ ui.render.lines.slice(-60).join("\n") }}</pre
      >
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { Button, Progress } from "frappe-ui";
import IconX from "~icons/lucide/x";
import IconCheck from "~icons/lucide/check";
import IconLoader from "~icons/lucide/loader-2";
import IconAlert from "~icons/lucide/alert-circle";
import IconChevron from "~icons/lucide/chevron-right";
import { segLabel, ui } from "../editor/engine.js";

// server rows carry segment dir names; show the user label when one exists
const disp = (n) => (ui.segments.some((s) => s.name === n) ? segLabel(n) : n);

const details = ref(false);
const log = ref(null);

const running = computed(() => ui.render.status === "running");
const done = computed(() => ui.render.status === "done");
const title = computed(() =>
  running.value ? "Rendering" : done.value ? "Render complete" : "Render failed"
);
const stageLabel = computed(() => {
  const cur = ui.render.segments.find((s) => s.state === "running");
  if (!cur) return "Starting…";
  return cur.name === "combine" ? "Combining into one video…" : `Rendering ${cur.name}…`;
});

function fmtSize(b) {
  return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
}
function open(url) {
  window.open(url, "_blank");
}

watch(
  () => ui.render.lines.length,
  () => nextTick(() => log.value && (log.value.scrollTop = log.value.scrollHeight)),
);
watch(running, (r) => { if (r) details.value = false; });
</script>
