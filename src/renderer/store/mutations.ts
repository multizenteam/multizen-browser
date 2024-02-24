import { IState } from "@renderer/interface/IStore";
import { MutationTree } from "vuex";
import set from "lodash/set";
import { v4 as uuid } from "uuid";
import { defaultHomePage, defaultUserAgent } from "@renderer/data/main";

const mutations: MutationTree<IState> = {
    addSession: async (s) => {
        const sessionId = uuid();
        s.sessions.push({
            tabs: [
                {
                    type: "settings",
                    id: uuid(),
                    title: "Session Settings",
                    session: sessionId,
                },
            ],
            id: sessionId,
            currentTabIndex: 0,
            settings: {
                homePage: defaultHomePage,
                userAgent: defaultUserAgent,
            },
        });
        s.currentSessionIndex = s.sessions.length - 1;
    },
    addTab: (s, { sessionIndex }: { sessionIndex: number }) => {
        s.sessions[sessionIndex].tabs.push({
            favicon: null,
            id: uuid(),
            url: s.sessions[sessionIndex].settings.homePage,
            title: "New Tab",
            session: s.sessions[sessionIndex].id,
        });
        s.sessions[sessionIndex].currentTabIndex =
            s.sessions[sessionIndex].tabs.length - 1;
    },

    removeTab: (
        s,
        { sessionIndex, tabIndex }: { sessionIndex: number; tabIndex: number },
    ) => {
        s.sessions[sessionIndex].tabs.splice(tabIndex, 1);
        if (s.sessions[sessionIndex].currentTabIndex > tabIndex) {
            s.sessions[sessionIndex].currentTabIndex -= 1;
        }
        if (
            s.sessions[sessionIndex].currentTabIndex >=
            s.sessions[sessionIndex].tabs.length
        ) {
            s.sessions[sessionIndex].currentTabIndex =
                s.sessions[sessionIndex].tabs.length - 1;
        }
    },

    removeSession: (s, sessionIndex: number) => {
        s.sessions.splice(sessionIndex, 1);
        if (s.currentSessionIndex >= s.sessions.length) {
            s.currentSessionIndex = s.sessions.length - 1;
        }
    },

    updateTab: (s, { sessionIndex, tabIndex, k, v }) => {
        set(s.sessions[sessionIndex].tabs[tabIndex], k, v);
    },

    updateSessionSetting: (s, { sessionIndex, k, v }) => {
        set(s.sessions[sessionIndex].settings, k, v);
    },

    setActiveTab: (
        s,
        { sessionIndex, tabIndex }: { sessionIndex: number; tabIndex: number },
    ) => {
        s.sessions[sessionIndex].currentTabIndex = tabIndex;
    },

    setActiveSession: (s, sessionIndex: number) => {
        s.currentSessionIndex = sessionIndex;
    },
};

export default mutations;
