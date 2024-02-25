import { IState } from "@renderer/interface/IStore";
import { GetterTree } from "vuex";

const getters: GetterTree<IState, unknown> = {
    currentSessionIndex: (s) => s.currentSessionIndex,
    currentSession: (s) => s.sessions[s.currentSessionIndex],
    currentTab: (s) =>
        s.sessions[s.currentSessionIndex].tabs[
            s.sessions[s.currentSessionIndex].currentTabIndex
        ],
    sessions: (s) => s.sessions,
};

export default getters;
