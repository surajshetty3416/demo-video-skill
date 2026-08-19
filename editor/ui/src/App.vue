<template>
  <div class="flex h-full flex-col bg-surface-base text-ink-gray-8">
    <header
      class="flex h-10 flex-none items-center gap-2 border-b border-outline-gray-1 bg-surface-base px-3"
    >
      <span class="text-base font-medium text-ink-gray-9">Demo Editor</span>
      <span class="text-sm text-ink-gray-5">{{ segTitle }}</span>
      <div class="flex-1"></div>
      <span v-if="ui.saveLabel" class="text-xs text-ink-gray-5">{{ ui.saveLabel }}</span>
      <Tooltip text="Undo (⌘Z)">
        <Button variant="ghost" :disabled="!ui.canUndo" :icon="IconUndo" label="Undo" @click="engine.undo()" />
      </Tooltip>
      <Tooltip text="Redo (⇧⌘Z)">
        <Button variant="ghost" :disabled="!ui.canRedo" :icon="IconRedo" label="Redo" @click="engine.redo()" />
      </Tooltip>
      <Tooltip :text="theme === 'dark' ? 'Light theme' : 'Dark theme'">
        <Button
          variant="ghost"
          :icon="theme === 'dark' ? IconSun : IconMoon"
          label="Toggle theme"
          @click="toggleTheme"
        />
      </Tooltip>
      <Tooltip text="Shortcuts (⌘?)">
        <Button variant="ghost" :icon="IconHelp" label="Shortcuts" @click="ui.shortcuts = true" />
      </Tooltip>
      <Button label="Save" @click="engine.saveSegment()" />
      <Dropdown :options="renderOptions" :offset="6">
        <Button variant="solid" label="Render" :icon-right="IconChevronDown" />
      </Dropdown>
    </header>

    <main class="flex min-h-0 flex-1">
      <SegmentRail />
      <PreviewPane />
      <InspectorPane />
    </main>

    <TimelinePane />
    <RenderPanel />
    <PromptDialog />
    <KeyboardShortcutsModal v-model:open="ui.shortcuts" />
    <ToastProvider />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
  Button, Dropdown, KeyboardShortcutsModal, Tooltip, ToastProvider, toast,
} from "frappe-ui";
import IconUndo from "~icons/lucide/undo-2";
import IconRedo from "~icons/lucide/redo-2";
import IconSun from "~icons/lucide/sun";
import IconMoon from "~icons/lucide/moon";
import IconHelp from "~icons/lucide/circle-help";
import IconChevronDown from "~icons/lucide/chevron-down";
import * as engine from "./editor/engine.js";
import { ui } from "./editor/engine.js";
import { registerShortcuts } from "./editor/shortcuts.js";
import SegmentRail from "./components/SegmentRail.vue";
import PreviewPane from "./components/PreviewPane.vue";
import InspectorPane from "./components/InspectorPane.vue";
import TimelinePane from "./components/TimelinePane.vue";
import RenderPanel from "./components/RenderPanel.vue";
import PromptDialog from "./components/PromptDialog.vue";

registerShortcuts();

const segTitle = computed(() => (ui.seg ? engine.segLabel(ui.seg) : ""));

const theme = ref(document.documentElement.getAttribute("data-theme") || "light");
function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  localStorage.setItem("demo-editor-theme", theme.value);
  document.documentElement.setAttribute("data-theme", theme.value);
  engine.themeChanged();
}

const renderOptions = [
  { label: "Render segment", onClick: renderSegment },
  { label: "Render all + concat", onClick: renderAll },
];
async function renderSegment() {
  if (await engine.startRender([ui.seg], false)) toast.info(`Rendering ${segTitle.value}…`);
}
async function renderAll() {
  if (await engine.startRender(ui.order, true)) toast.info("Rendering all segments…");
}

watch(
  () => ui.render.status,
  (s, old) => {
    if (old !== "running") return;
    if (s === "done") toast.success("Render complete");
    if (s === "error") toast.error("Render failed, see the log");
  },
);

onMounted(() => engine.init());
</script>
