import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/auth-profiles", component: () => import("./views/AuthProfiles.vue") },
    { path: "/", component: () => import("./views/MonitorList.vue") },
    {
      path: "/monitors/:id",
      component: () => import("./views/MonitorDetail.vue"),
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
createApp(App).use(router).mount("#app");
