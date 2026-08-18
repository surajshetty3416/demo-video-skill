<!-- Mirrors Builder's CollapsibleSection so the panel reads like its properties panel. -->
<template>
  <section>
    <div class="flex h-7 items-center justify-between">
      <h3
        class="flex min-w-0 items-baseline gap-1.5 truncate text-base text-ink-gray-9"
        :class="canToggle ? 'cursor-pointer' : ''"
        @click="toggle"
      >
        {{ title }}
        <span v-if="suffix" class="truncate text-xs tabular-nums text-ink-gray-5">{{ suffix }}</span>
      </h3>
      <slot name="action">
        <Button
          v-if="canToggle"
          variant="ghost"
          size="sm"
          :icon="collapsed ? IconChevronRight : IconChevronDown"
          :label="collapsed ? 'Expand' : 'Collapse'"
          @click="toggle"
        />
      </slot>
    </div>
    <div v-if="!collapsed" class="mb-4 mt-2 flex flex-col gap-3">
      <slot />
    </div>
  </section>
</template>

<script setup>
import { ref, useSlots } from "vue";
import { Button } from "frappe-ui";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconChevronDown from "~icons/lucide/chevron-down";

const props = defineProps({
  title: { type: String, required: true },
  suffix: { type: String, default: "" },
  collapsible: { type: Boolean, default: true },
  defaultCollapsed: { type: Boolean, default: false },
});

const slots = useSlots();
const canToggle = props.collapsible && !slots.action;
const collapsed = ref(props.defaultCollapsed && canToggle);

function toggle() {
  if (canToggle) collapsed.value = !collapsed.value;
}
</script>
