import mutations from "@renderer/store/mutations";
import getters from "@renderer/store/getters";
import { defaultHomePage, defaultUserAgent } from "@renderer/data/main";
import { v4 as uuid } from "uuid";

const sessionId = uuid();

export default {
    namespaced: true,
    state: {
        currentSessionIndex: 0,
        sessions: [
            {
                tabs: [
                    {
                        type: "settings",
                        favicon: null,
                        id: uuid(),
                        title: "Session Settings",
                        session: sessionId,
                    },
                ],
                settings: {
                    homePage: defaultHomePage,
                    userAgent: defaultUserAgent,
                },
                id: sessionId,
                currentTabIndex: 0,
            },
        ],
    },

    mutations,
    getters,
};
