<!-- Builder InlineInput row: muted label left, control right. `wide` stacks the
     control full-width below the label for controls that need the whole column. -->
<template>
  <div :class="wide ? 'flex flex-col gap-1.5' : 'flex items-center justify-between gap-2'">
    <label
      class="flex min-w-0 items-baseline truncate text-xs leading-5 text-ink-gray-6"
      :class="wide ? '' : 'w-1/3 min-w-[88px] shrink-0'"
      :title="label"
    >
      <span class="truncate">{{ label }}</span>
      <span v-if="suffix" class="ml-1 shrink-0 tabular-nums text-ink-gray-5">· {{ suffix }}</span>
    </label>
    <div class="flex min-w-0 w-full items-center justify-end gap-2">
      <slot />
    </div>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  suffix: { type: String, default: "" },
  wide: { type: Boolean, default: false },
});
</script>
