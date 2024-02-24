import { createStore } from "vuex";
import sessions from "./modules/sessions";
import createPersistedState from "vuex-persistedstate";
import { IState } from "@renderer/interface/IStore";

export default createStore<IState>({
    modules: {
        sessions,
    },
    strict: process.env.NODE_ENV !== "production",
    plugins: [
        createPersistedState({
            key: "multizen-browser-storage",
        }),
    ],
});
