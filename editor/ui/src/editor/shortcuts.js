"use strict";
/* App keyboard shortcuts via frappe-ui's useShortcut registry, which also
   feeds KeyboardShortcutsModal (⌘? / the "?" button). Must be called from a
   component setup() — App.vue does. Input/dialog focus guards come from the
   composable's defaults. */
import { useShortcut } from "frappe-ui";
import * as engine from "./engine.js";
import { state, ui } from "./engine.js";

const fps = () => state.meta?.fps || 60;
const toggleHelp = () => { ui.shortcuts = !ui.shortcuts; };

export function registerShortcuts() {
  useShortcut([
    { key: " ", description: "Play / pause", group: "Playback",
      handler: () => engine.togglePlay() },
    // shift variants first: matching is first-wins and "ArrowRight" counts as a
    // shift-produced key, so the plain config would swallow Shift+Arrow
    { key: "ArrowRight", shift: true, description: "Jump one second", group: "Playback",
      handler: () => engine.stepFrame(fps()) },
    { key: "ArrowLeft", shift: true, description: "Jump one second", group: "Playback",
      handler: () => engine.stepFrame(-fps()) },
    { key: "ArrowRight", description: "Step one frame", group: "Playback",
      handler: () => engine.stepFrame(1) },
    { key: "ArrowLeft", description: "Step one frame", group: "Playback",
      handler: () => engine.stepFrame(-1) },

    { key: "z", ctrl: true, description: "Undo", group: "Editing",
      handler: () => engine.undo() },
    { key: "z", ctrl: true, shift: true, description: "Redo", group: "Editing",
      handler: () => engine.redo() },
    { key: "i", description: "Trim start at playhead", group: "Editing",
      handler: () => engine.trimAtPlayhead("in") },
    { key: "o", description: "Trim end at playhead", group: "Editing",
      handler: () => engine.trimAtPlayhead("out") },
    { key: "s", description: "Split camera block at playhead", group: "Editing",
      handler: () => engine.splitAtPlayhead() },
    { key: "Delete", description: "Delete selection", group: "Editing",
      handler: () => engine.deleteSelected() },
    { key: "Backspace", description: "Delete selection", group: "Editing",
      handler: () => engine.deleteSelected() },

    { key: "s", ctrl: true, description: "Save segment", group: "General",
      handler: () => engine.saveSegment() },
    { key: "?", ctrl: true, description: "Keyboard shortcuts", group: "General",
      allowInDialog: true, handler: toggleHelp },
    { key: "/", ctrl: true, description: "Keyboard shortcuts", group: "General",
      allowInDialog: true, handler: toggleHelp },
  ]);
}
