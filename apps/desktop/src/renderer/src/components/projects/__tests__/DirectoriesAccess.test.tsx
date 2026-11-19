import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmHost } from "../../atoms";
import { ProjectDetail } from "../ProjectDetail";
import type { ProjectView, WorkspaceBindingView } from "../../../types";
import {
  binding,
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway, view: ProjectView) {
  installFakeGateway(fake);
  render(
    <>
      <ProjectDetail project={view} onChanged={vi.fn()} onDeleted={vi.fn()} />
      <ConfirmHost />
    </>,
  );
  return { user: userEvent.setup() };
}

const SERVER = {
  transport: "stdio" as const,
  id: "docs",
  disabled: false,
  command: "npx",
  args: [],
  env: {},
};

describe("Folders — empty and adding", () => {
  it("explains what linking a folder does when none are linked", async () => {
    const view = project("alpha", { label: "Alpha" });
    setup(createFakeGateway({ projects: [view] }), view);
    expect(await screen.findByText("Folders (0)")).toBeInTheDocument();
    expect(screen.getByText(/no folders linked/i)).toBeInTheDocument();
    // "Rewrite all" is pointless with nothing linked.
    expect(screen.queryByRole("button", { name: /rewrite all/i })).not.toBeInTheDocument();
  });

  it("adds a folder from the native picker with no agents selected yet", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view], pickResult: "/abs/work" });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /add folder/i }));
    expect(fake.api.setDirectoryAgents).toHaveBeenCalledWith("alpha", "/abs/work", []);
  });

  it("ignores a cancelled picker", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view], pickResult: null });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("button", { name: /add folder/i }));
    expect(fake.api.setDirectoryAgents).not.toHaveBeenCalled();
  });

  it("refuses to link the same folder twice", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      pickResult: "/abs/work",
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    expect(await screen.findByText(/already linked to this project/i)).toBeInTheDocument();
    expect(fake.api.setDirectoryAgents).not.toHaveBeenCalled();
  });
});

describe("Folders — agent selection and status", () => {
  it("lists each agent with its managed file path and up-to-date status", async () => {
    const view = project("alpha", { servers: [SERVER] });
    setup(
      createFakeGateway({
        projects: [view],
        directories: {
          alpha: [
            {
              projectId: "alpha",
              directory: "/abs/work",
              agents: [
                {
                  agent: "cursor",
                  status: "current",
                  configPath: "/abs/work/.cursor/mcp.json",
                  lastInstalledAt: 1,
                },
                {
                  agent: "codex",
                  status: "current",
                  configPath: "/abs/work/.codex/config.toml",
                  lastInstalledAt: 1,
                },
              ],
            },
          ],
        },
      }),
      view,
    );
    const list = await screen.findByTestId("directory-list");
    expect(within(list).getByText("/abs/work")).toBeInTheDocument();
    const cursorRow = within(list).getByTestId("agent-row-cursor");
    expect(within(cursorRow).getByText("Cursor")).toBeInTheDocument();
    expect(within(cursorRow).getByText("/abs/work/.cursor/mcp.json")).toBeInTheDocument();
    const codexRow = within(list).getByTestId("agent-row-codex");
    expect(within(codexRow).getByText("Codex")).toBeInTheDocument();
    expect(within(codexRow).getByText("/abs/work/.codex/config.toml")).toBeInTheDocument();
    expect(within(list).getAllByText("up to date")).toHaveLength(2);
  });

  it("changes the agent selection for one folder", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");

    await user.click(screen.getByLabelText("Codex — /abs/work"));
    expect(fake.api.setDirectoryAgents).toHaveBeenCalledWith("alpha", "/abs/work", [
      "cursor",
      "codex",
    ]);
  });

  it("says nothing is written when a folder has no agents", async () => {
    const view = project("alpha");
    setup(
      createFakeGateway({
        projects: [view],
        directories: { alpha: [{ projectId: "alpha", directory: "/abs/work", agents: [] }] },
      }),
      view,
    );
    const list = await screen.findByTestId("directory-list");
    expect(within(list).getByText(/nothing is written here yet/i)).toBeInTheDocument();
  });

  it("offers a retry with the failure reason and recovery hint", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const failing: WorkspaceBindingView = {
      projectId: "alpha",
      directory: "/abs/work",
      agents: [
        {
          agent: "cursor",
          status: "error",
          configPath: "/abs/work/.cursor/mcp.json",
          lastInstalledAt: null,
          error: ".cursor/mcp.json is not valid JSON",
          hint: "Fix or remove the file, then retry.",
        },
      ],
    };
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [failing] },
    });
    const { user } = setup(fake, view);

    const list = await screen.findByTestId("directory-list");
    expect(within(list).getByText("failed")).toBeInTheDocument();
    expect(within(list).getByText(/not valid JSON/)).toBeInTheDocument();
    expect(within(list).getByText(/Fix or remove the file/)).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /retry/i }));
    expect(fake.api.retryDirectoryAgent).toHaveBeenCalledWith("alpha", "/abs/work", "cursor");
  });

  it("offers 'Write now' for an out-of-date target", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const fake = createFakeGateway({
      projects: [view],
      directories: {
        alpha: [
          {
            projectId: "alpha",
            directory: "/abs/work",
            agents: [
              {
                agent: "cursor",
                status: "out-of-date",
                configPath: "/abs/work/.cursor/mcp.json",
                lastInstalledAt: 1,
              },
            ],
          },
        ],
      },
    });
    const { user } = setup(fake, view);
    const list = await screen.findByTestId("directory-list");
    expect(within(list).getByText("needs writing")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /write now/i }));
    expect(fake.api.retryDirectoryAgent).toHaveBeenCalledWith("alpha", "/abs/work", "cursor");
  });

  it("rewrites every folder on demand", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");
    await user.click(screen.getByRole("button", { name: /rewrite all/i }));
    expect(fake.api.reconcileDirectories).toHaveBeenCalledWith("alpha");
  });

  it("reveals a folder in the file manager", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");
    await user.click(screen.getByRole("button", { name: "Reveal /abs/work" }));
    expect(fake.api.revealPath).toHaveBeenCalledWith("/abs/work");
  });
});

describe("Folders — unlinking", () => {
  it("confirms, explains the cleanup, and unlinks", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");

    await user.click(screen.getByRole("button", { name: "Unlink /abs/work" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/remove its entries from the agent configuration/i);
    expect(dialog).toHaveTextContent(/Everything else in those files is left alone/i);
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(fake.api.removeDirectory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Unlink /abs/work" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /unlink folder/i,
      }),
    );
    expect(fake.api.removeDirectory).toHaveBeenCalledWith("alpha", "/abs/work");
  });

  it("surfaces a cleanup failure instead of pretending it unlinked", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      directories: { alpha: [binding("alpha", "/abs/work", ["cursor"])] },
    });
    fake.api.removeDirectory = (async () => ({
      ok: false as const,
      error: { code: "permission", message: "permission denied writing .cursor/mcp.json" },
    })) as typeof fake.api.removeDirectory;
    const { user } = setup(fake, view);
    await screen.findByTestId("directory-list");

    await user.click(screen.getByRole("button", { name: "Unlink /abs/work" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /unlink folder/i,
      }),
    );
    expect(await screen.findByText(/permission denied writing/i)).toBeInTheDocument();
  });
});

describe("Access — token requirement", () => {
  it("is off by default and explains the consequence", async () => {
    const view = project("alpha");
    setup(createFakeGateway({ projects: [view] }), view);
    const toggle = await screen.findByRole("switch", { name: /require a token/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/any local process can call/i)).toBeInTheDocument();
    // With auth off there is no token UI at all.
    expect(screen.queryByRole("button", { name: /generate token/i })).not.toBeInTheDocument();
  });

  it("turns on and reveals the token controls", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("switch", { name: /require a token/i }));
    expect(fake.api.setAuthEnabled).toHaveBeenCalledWith("alpha", true);
  });

  it("shows the deterministic variable name and that no token is set yet", async () => {
    const view = project("alpha", {
      localAuth: {
        enabled: true,
        tokenRef: "${MULTIZEN_PROJECT_ALPHA_A1B2C3_TOKEN}",
        tokenPresent: false,
      },
    });
    setup(createFakeGateway({ projects: [view] }), view);
    expect(await screen.findByText("not set")).toBeInTheDocument();
    // The `${}` wrapper is an implementation detail; the operator needs the NAME.
    expect(screen.getByText("MULTIZEN_PROJECT_ALPHA_A1B2C3_TOKEN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy variable name/i })).toBeInTheDocument();
    expect(screen.getByText(/Export this variable/i)).toBeInTheDocument();
  });
});

describe("Access — one-shot token reveal", () => {
  const authed = (tokenPresent: boolean): ProjectView =>
    project("alpha", {
      localAuth: {
        enabled: true,
        tokenRef: "${MULTIZEN_PROJECT_ALPHA_A1B2C3_TOKEN}",
        tokenPresent,
      },
    });

  it("generates a token, shows it once, and forgets it on dismiss", async () => {
    const view = authed(false);
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /^Generate token$/ }));
    expect(fake.api.generateToken).toHaveBeenCalledWith("alpha");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/only time Sekvona can show it/i);
    const token = "f".repeat(64);
    expect(within(dialog).getByText(token)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /copy token/i })).toBeInTheDocument();
    // It tells the operator exactly how to hand it to their agent.
    expect(dialog).toHaveTextContent(/export MULTIZEN_PROJECT_ALPHA_A1B2C3_TOKEN=/);

    await user.click(within(dialog).getByRole("button", { name: /i’ve saved it/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The token is gone from the document entirely — there is no way back to it.
    expect(document.body.textContent).not.toContain(token);
  });

  it("warns before replacing an existing token", async () => {
    const view = authed(true);
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    expect(await screen.findByText("stored")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate new token/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/current token stops working immediately/i);
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(fake.api.generateToken).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /generate new token/i }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /replace token/i,
      }),
    );
    expect(fake.api.generateToken).toHaveBeenCalledWith("alpha");
  });
});

describe("Endpoints", () => {
  it("lists a copyable URL per enabled server plus the browser route", async () => {
    const view = project("alpha", {
      servers: [SERVER],
      browserProfileId: "prof-1",
    });
    setup(createFakeGateway({ projects: [view] }), view);

    const list = await screen.findByTestId("endpoint-list");
    expect(
      within(list).getByText("http://127.0.0.1:7777/mcp/proxies/alpha/docs"),
    ).toBeInTheDocument();
    expect(
      within(list).getByText("http://127.0.0.1:7777/mcp/projects/alpha/browser"),
    ).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /copy docs endpoint/i })).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: /copy browser endpoint/i }),
    ).toBeInTheDocument();
  });

  it("copies an endpoint to the clipboard", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const { user } = setup(createFakeGateway({ projects: [view] }), view);
    // Installed after `setup`, because `userEvent.setup()` attaches its own
    // clipboard stub to the window and would otherwise win.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await user.click(
      within(await screen.findByTestId("endpoint-list")).getByRole("button", {
        name: /copy docs endpoint/i,
      }),
    );
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:7777/mcp/proxies/alpha/docs");
  });

  it("reports a clipboard failure rather than claiming success", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const { user } = setup(createFakeGateway({ projects: [view] }), view);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });

    await user.click(
      within(await screen.findByTestId("endpoint-list")).getByRole("button", {
        name: /copy docs endpoint/i,
      }),
    );
    expect(await screen.findByText(/couldn’t reach the clipboard/i)).toBeInTheDocument();
  });

  it("says when nothing is exposed yet", async () => {
    const view = project("alpha");
    setup(createFakeGateway({ projects: [view] }), view);
    expect(await screen.findByText(/no endpoints yet/i)).toBeInTheDocument();
  });

  it("warns when the URLs are not actually being served", async () => {
    const view = project("alpha", { servers: [SERVER] });
    const fake = createFakeGateway({ projects: [view] });
    fake.api.endpoints = (async () => ({
      ok: true as const,
      value: {
        projectId: "alpha",
        baseUrl: "http://127.0.0.1:7777",
        proxies: [{ serverId: "docs", url: "http://127.0.0.1:7777/mcp/proxies/alpha/docs" }],
        authRequired: false,
        served: false,
      },
    })) as typeof fake.api.endpoints;
    setup(fake, view);

    expect(await screen.findByText(/not being served yet/i)).toBeInTheDocument();
    expect(screen.getByText(/addresses below will not change/i)).toBeInTheDocument();
  });

  it("notes that a disabled project answers on nothing", async () => {
    const view = project("alpha", { enabled: false, servers: [SERVER] });
    setup(createFakeGateway({ projects: [view] }), view);
    expect(
      await screen.findByText(/switched off, so nothing answers on these addresses/i),
    ).toBeInTheDocument();
  });

  it("notes when calls must carry a token", async () => {
    const view = project("alpha", {
      servers: [SERVER],
      localAuth: { enabled: true, tokenPresent: true },
    });
    setup(createFakeGateway({ projects: [view] }), view);
    expect(
      await screen.findByText(/must carry this project’s bearer token/i),
    ).toBeInTheDocument();
  });
});
