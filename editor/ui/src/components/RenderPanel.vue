<template>
  <div
    v-if="ui.render.open"
    class="fixed bottom-48 right-3 z-40 w-96 rounded-lg border border-outline-gray-2 bg-surface-base shadow-xl"
  >
    <div class="flex items-center justify-between border-b border-outline-gray-1 px-3 py-2">
      <span class="text-base font-medium text-ink-gray-9">{{ ui.render.title }}</span>
      <Button variant="ghost" :icon="IconX" label="Close" @click="ui.render.open = false" />
    </div>
    <div class="px-3 py-2">
      <Progress v-if="ui.render.progress !== null" :value="ui.render.progress" size="sm" />
      <pre
        ref="log"
        class="mt-2 max-h-44 select-text overflow-y-auto whitespace-pre-wrap font-mono text-2xs leading-relaxed text-ink-gray-6"
        >{{ ui.render.lines.slice(-40).join("\n") }}</pre
      >
    </div>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";
import { Button, Progress } from "frappe-ui";
import IconX from "~icons/lucide/x";
import { ui } from "../editor/engine.js";

const log = ref(null);
watch(
  () => ui.render.lines.length,
  () => nextTick(() => log.value && (log.value.scrollTop = log.value.scrollHeight)),
);
</script>
