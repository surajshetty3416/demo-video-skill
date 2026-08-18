import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";

const saved = localStorage.getItem("demo-editor-theme");
document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");
createApp(App).mount("#app");
