<template>
  <aside
    class="w-80 flex-none overflow-y-auto border-l border-outline-gray-1 bg-surface-base p-3"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="flex flex-col gap-3">
      <!-- selection -->
      <template v-if="ui.sel">
        <InspectorSection v-if="ui.sel.type === 'cam' && camBlock" title="Camera" :suffix="camRange" :collapsible="false">
          <InspectorRow label="Zoom" :suffix="zoomModel === 'custom' ? fmtZoom(camBlock.z) : ''" wide>
            <TabButtons :class="['w-full', STRETCH_TABS]" :options="zoomTabOpts" v-model="zoomModel" />
          </InspectorRow>
          <p class="text-p-xs text-ink-gray-5">Click the preview to set focus, scroll on it to zoom.</p>
        </InspectorSection>

        <InspectorSection v-else-if="ui.sel.type === 'still'" title="Hold" :collapsible="false">
          <InspectorRow label="Duration (s)">
            <FormControl class="w-full" type="number"
              :modelValue="holdSeconds"
              @update:modelValue="(v) => engine.setStillRepeat(ui.sel.entry, parseFloat(v) * fps)" />
          </InspectorRow>
          <p class="text-p-xs text-ink-gray-5">Drag the pill's right edge to retime.</p>
        </InspectorSection>

        <InspectorSection v-else-if="ui.sel.type === 'speed' && M.speed[ui.sel.idx]" title="Speed-up">
          <template #action>
            <Button variant="ghost" :icon="IconTrash" label="Delete" @click="engine.deleteSelected()" />
          </template>
          <InspectorRow label="Start (s)">
            <FormControl class="w-full" type="number" :modelValue="entrySeconds(M.speed[ui.sel.idx].from)"
              @update:modelValue="(v) => setSpeedTime('from', v)" />
          </InspectorRow>
          <InspectorRow label="End (s)">
            <FormControl class="w-full" type="number" :modelValue="entrySeconds(M.speed[ui.sel.idx].to)"
              @update:modelValue="(v) => setSpeedTime('to', v)" />
          </InspectorRow>
          <InspectorRow label="Speed (×)">
            <FormControl class="w-full" type="number" :modelValue="M.speed[ui.sel.idx].mult"
              @update:modelValue="(v) => engine.setSpeedField(ui.sel.idx, 'mult', parseFloat(v))" />
          </InspectorRow>
        </InspectorSection>

        <InspectorSection v-else-if="ui.sel.type === 'click' && M.clicks[ui.sel.idx]" title="Click pulse">
          <template #action>
            <Button variant="ghost" :icon="IconTrash" label="Delete" @click="engine.deleteSelected()" />
          </template>
          <InspectorRow label="Time (s)">
            <FormControl class="w-full" type="number" :modelValue="entrySeconds(M.clicks[ui.sel.idx].i)"
              @update:modelValue="(v) => setEventTime(v)" />
          </InspectorRow>
          <InspectorRow label="X (page px)">
            <FormControl class="w-full" type="number" :modelValue="M.clicks[ui.sel.idx].x"
              @update:modelValue="(v) => engine.setEventField(ui.sel, 'x', parseFloat(v))" />
          </InspectorRow>
          <InspectorRow label="Y (page px)">
            <FormControl class="w-full" type="number" :modelValue="M.clicks[ui.sel.idx].y"
              @update:modelValue="(v) => engine.setEventField(ui.sel, 'y', parseFloat(v))" />
          </InspectorRow>
        </InspectorSection>

        <InspectorSection v-else-if="ui.sel.type === 'key' && M.keys[ui.sel.idx]" title="Keycap hint">
          <template #action>
            <Button variant="ghost" :icon="IconTrash" label="Delete" @click="engine.deleteSelected()" />
          </template>
          <InspectorRow label="Time (s)">
            <FormControl class="w-full" type="number" :modelValue="entrySeconds(M.keys[ui.sel.idx].i)"
              @update:modelValue="(v) => setEventTime(v)" />
          </InspectorRow>
          <InspectorRow label="Text">
            <FormControl class="w-full" type="text" :modelValue="M.keys[ui.sel.idx].text"
              @update:modelValue="(v) => engine.setEventField(ui.sel, 'text', v)" />
          </InspectorRow>
        </InspectorSection>
      </template>

      <InspectorSection title="Style">
        <InspectorRow label="Background" :suffix="bgIdx === -1 ? 'Custom' : ''" wide>
          <div class="flex w-full flex-wrap items-center gap-1.5">
            <button
              v-for="(p, i) in BG_PRESETS"
              :key="p.name"
              class="h-7 w-10 rounded border border-outline-gray-2"
              :class="bgIdx === i ? 'ring-2 ring-outline-gray-7 ring-offset-1 ring-offset-surface-base' : ''"
              :title="p.name"
              :style="{ background: swatchCss(p) }"
              @click="engine.applyBgPreset(i)"
            ></button>
          </div>
        </InspectorRow>
        <SimpleCtl v-for="c in byCard('style')" :key="c.id" :c="c" />
      </InspectorSection>

      <InspectorSection title="Camera">
        <SimpleCtl v-for="c in byCard('camera')" :key="c.id" :c="c" />
      </InspectorSection>

      <InspectorSection title="Pacing">
        <InspectorRow label="Speed">
          <FormControl class="w-16 shrink-0" type="number" :modelValue="M.pace"
            @update:modelValue="(v) => isFinite(parseFloat(v)) && engine.setPace(parseFloat(v))" />
          <div class="min-w-0 flex-1">
            <Slider v-model="paceModel" :min="0.5" :max="8" :step="0.1" size="sm"
              @value-commit="engine.commitGesture()" />
          </div>
        </InspectorRow>
        <SimpleCtl v-for="c in byCard('pacing')" :key="c.id" :c="c" />
      </InspectorSection>

      <InspectorSection title="Cursor &amp; hints">
        <SimpleCtl
          v-for="c in byCard('cursor')"
          :key="c.id"
          :c="c"
          :disabled="c.id === 'keysize' && K.KEY_N === 0"
        />
      </InspectorSection>

      <InspectorSection title="Export">
        <SimpleCtl v-for="c in byCard('export')" :key="c.id" :c="c" />
      </InspectorSection>

      <InspectorSection title="Advanced" defaultCollapsed>
        <InspectorRow v-for="(g, i) in K.GRAD" :key="i" :label="`Gradient ${Math.round(g[0] * 100)}%`">
          <input
            type="color"
            class="h-7 w-10 cursor-pointer rounded border border-outline-gray-2 bg-transparent"
            :value="rgbHex(g[1])"
            @input="(e) => engine.setGradStop(i, e.target.value)"
          />
        </InspectorRow>
        <InspectorRow v-for="f in advFields" :key="f.key" :label="f.label">
          <FormControl class="w-full" type="number" :modelValue="K[f.key]"
            @update:modelValue="(v) => engine.setKnob(f.key, parseFloat(v), f.kind)" />
        </InspectorRow>
        <InspectorRow label="Trim in (entry)">
          <FormControl class="w-full" type="number" :modelValue="M.trim.in"
            @update:modelValue="(v) => engine.setTrim('in', parseFloat(v))" />
        </InspectorRow>
        <InspectorRow label="Trim out (entry)">
          <FormControl class="w-full" type="number" :modelValue="M.trim.out"
            @update:modelValue="(v) => engine.setTrim('out', parseFloat(v))" />
        </InspectorRow>
        <template v-if="camBlock">
          <InspectorRow label="Block zoom">
            <FormControl class="w-full" type="number" :modelValue="camBlock.z" :step="0.05"
              @update:modelValue="(v) => engine.setCamValue('z', parseFloat(v))" />
          </InspectorRow>
          <InspectorRow label="Block focus X">
            <FormControl class="w-full" type="number" :modelValue="camBlock.cx"
              @update:modelValue="(v) => engine.setCamValue('cx', parseFloat(v))" />
          </InspectorRow>
          <InspectorRow label="Block focus Y">
            <FormControl class="w-full" type="number" :modelValue="camBlock.cy"
              @update:modelValue="(v) => engine.setCamValue('cy', parseFloat(v))" />
          </InspectorRow>
        </template>
      </InspectorSection>
    </div>
  </aside>
</template>

<script setup>
import { computed, defineComponent, h } from "vue";
import { Button, FormControl, Slider, TabButtons } from "frappe-ui";
import IconTrash from "~icons/lucide/trash-2";
import * as engine from "../editor/engine.js";
import { ui, BG_PRESETS, SIMPLE, ZOOM_STOPS, rgbHex } from "../editor/engine.js";
import InspectorSection from "./InspectorSection.vue";
import InspectorRow from "./InspectorRow.vue";

// frappe-ui TabButtons hugs its content; Builder stretches segments to fill
// the control column (mirrors builder's utils/tabButtons.ts).
const STRETCH_TABS =
  "[&>div]:w-full [&_[data-slot=tab-button]]:flex-1 [&_[data-slot=tab-button]>span]:w-full";

const fps = computed(() => {
  ui.rev;
  return engine.state.meta?.fps || 60;
});
const K = computed(() => {
  ui.rev;
  return engine.state.knobs || engine.KNOB_DEFAULTS;
});
const M = computed(() => {
  ui.rev;
  const m = engine.state.meta;
  return {
    frames: m?.frames || [],
    speed: m?.speed || [],
    clicks: m?.clicks || [],
    keys: m?.keys || [],
    trim: m?.trim || { in: 0, out: 0 },
    pace: m?.pace || 1,
  };
});
const camBlock = computed(() => {
  ui.rev;
  return ui.sel?.type === "cam" ? engine.blockContaining(ui.sel.entry) : null;
});
const camRange = computed(() => {
  const b = camBlock.value;
  if (!b) return "";
  return `${entrySeconds(b.i0)}–${entrySeconds(Math.min(b.i1 + 1, M.value.frames.length - 1))}s`;
});
const holdSeconds = computed(
  () => +((M.value.frames[ui.sel?.entry]?.repeat ?? 1) / fps.value).toFixed(1),
);
const bgIdx = computed(() => {
  ui.rev;
  return engine.state.knobs ? engine.bgPresetIndex() : 0;
});
const paceModel = computed({
  get: () => [M.value.pace],
  set: ([v]) => {
    engine.beginGesture();
    engine.setPace(v);
  },
});
const fmtZoom = (z) => `${z.toFixed(2)}×`;
const zoomTabOpts = ZOOM_STOPS.map(([label], i) => ({ label, value: i }));
const zoomModel = computed({
  get: () => {
    ui.rev;
    const b = camBlock.value;
    if (!b) return "custom";
    const i = ZOOM_STOPS.findIndex(([, v]) => Math.abs(v - b.z) < 0.001);
    return i === -1 ? "custom" : i;
  },
  set: (i) => {
    if (typeof i === "number") engine.setCamZoomStop(ZOOM_STOPS[i][1]);
  },
});

function entrySeconds(i) {
  const s = engine.state.eStarts;
  if (!s) return 0;
  const pf = i >= s.length ? engine.state.eTotal : s[clampIdx(i)];
  return +(pf / fps.value).toFixed(1);
}
const clampIdx = (i) => Math.max(0, Math.min(i, engine.state.eStarts.length - 1));
const toEntry = (v) => engine.entryAtPf(Math.round(parseFloat(v) * fps.value));
function setSpeedTime(field, v) {
  if (isFinite(parseFloat(v))) engine.setSpeedField(ui.sel.idx, field, toEntry(v));
}
function setEventTime(v) {
  if (isFinite(parseFloat(v))) engine.setEventField(ui.sel, "i", toEntry(v));
}

const byCard = (card) => SIMPLE.filter((c) => c.card === card);
const swatchCss = (p) => `linear-gradient(135deg, ${p.grad.map(([, c]) => rgbHex(c)).join(", ")})`;

const advFields = [
  { key: "MARGIN", label: "Margin", kind: "visual" },
  { key: "RAD", label: "Corner radius", kind: "visual" },
  { key: "SHADOW_ALPHA", label: "Shadow alpha", kind: "visual" },
  { key: "SHADOW_BLUR", label: "Shadow blur", kind: "visual" },
  { key: "CURSOR_CSS_H", label: "Cursor px", kind: "visual" },
  { key: "KEY_H", label: "Keycap height", kind: "visual" },
  { key: "KEY_INSET", label: "Keycap inset", kind: "visual" },
  { key: "KEY_N", label: "Keycap frames", kind: "visual" },
  { key: "ZOOM_EMA", label: "Zoom EMA", kind: "path" },
  { key: "PAN_EMA", label: "Pan EMA", kind: "path" },
  { key: "END_EXTRA", label: "End extra (frames)", kind: "path" },
  { key: "CRF", label: "CRF", kind: "plain" },
];

// text-entry focus opens a coalesced history gesture; blur commits it
function onFocusIn(ev) {
  if (ev.target.matches?.("input:not([type=button]):not([type=radio]), textarea")) engine.beginGesture();
}
function onFocusOut(ev) {
  if (ev.target.matches?.("input:not([type=button]):not([type=radio]), textarea")) engine.commitGesture();
}

const SimpleCtl = defineComponent({
  props: { c: { type: Object, required: true }, disabled: Boolean },
  setup(props) {
    const model = computed({
      get: () => {
        ui.rev;
        if (!engine.state.knobs) return 0;
        const i = engine.matchSimple(props.c);
        return i === -1 ? "custom" : i;
      },
      set: (i) => {
        if (typeof i === "number") engine.applySimple(props.c, props.c.opts[i][1]);
      },
    });
    return () =>
      h(
        InspectorRow,
        {
          label: props.c.label,
          suffix: model.value === "custom" ? "Custom" : "",
          wide: !!props.c.wide,
          class: props.disabled ? "pointer-events-none opacity-45" : "",
        },
        () =>
          h(TabButtons, {
            class: ["w-full", STRETCH_TABS],
            options: props.c.opts.map(([label], i) => ({ label, value: i })),
            modelValue: model.value,
            "onUpdate:modelValue": (v) => (model.value = v),
          }),
      );
  },
});
</script>
