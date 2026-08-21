<template>
  <Dialog
    :modelValue="!!ui.prompt"
    @update:modelValue="(v) => !v && cancel()"
    :options="{ title: ui.prompt?.title || '', size: 'sm' }"
  >
    <template #body-content>
      <p v-if="ui.prompt?.message" class="text-p-base text-ink-gray-7">
        {{ ui.prompt.message }}
      </p>
      <FormControl
        v-if="!ui.prompt?.confirm"
        :type="ui.prompt?.type || 'text'"
        :label="ui.prompt?.label || ''"
        v-model="value"
        @keydown.enter="confirm"
      />
      <div class="mt-4 flex justify-end gap-2">
        <Button label="Cancel" @click="cancel" />
        <Button
          variant="solid"
          :theme="ui.prompt?.danger ? 'red' : 'gray'"
          :label="ui.prompt?.okLabel || 'Confirm'"
          @click="confirm"
        />
      </div>
    </template>
  </Dialog>
</template>

<script setup>
import { ref, watch } from "vue";
import { Button, Dialog, FormControl } from "frappe-ui";
import { resolvePrompt, ui } from "../editor/engine.js";

const value = ref("");

watch(
  () => ui.prompt,
  (p) => {
    if (p) value.value = p.value ?? "";
  },
);

function confirm() {
  resolvePrompt(ui.prompt?.confirm ? "ok" : String(value.value));
}
function cancel() {
  resolvePrompt(null);
}
</script>
