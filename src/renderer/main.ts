import { createApp } from "vue";
import "font-awesome/css/font-awesome.min.css";
import store from "./store/index";
import App from "./App.vue";

createApp(App).use(store).mount("#app");
