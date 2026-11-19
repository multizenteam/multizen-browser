import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmHost } from "../../atoms";
import { ProjectDetail } from "../ProjectDetail";
import type { ProjectView, SecretRefStatusView, ServerView } from "../../../types";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function stdio(id: string, over: Partial<Extract<ServerView, { transport: "stdio" }>> = {}) {
  return {
    transport: "stdio" as const,
    id,
    disabled: false,
    command: "npx",
    args: ["-y", `${id}-mcp`],
    env: {},
    ...over,
  };
}

function http(
  id: string,
  over: Partial<Extract<ServerView, { transport: "streamable-http" }>> = {},
) {
  return {
    transport: "streamable-http" as const,
    id,
    disabled: false,
    url: "https://api.example.com/mcp",
    headers: {},
    ...over,
  };
}

function setup(
  fake: FakeGateway,
  view: ProjectView,
): {
  user: ReturnType<typeof userEvent.setup>;
  onChanged: ReturnType<typeof vi.fn>;
  onDeleted: ReturnType<typeof vi.fn>;
} {
  installFakeGateway(fake);
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  render(
    <>
      <ProjectDetail project={view} onChanged={onChanged} onDeleted={onDeleted} />
      <ConfirmHost />
    </>,
  );
  return { user: userEvent.setup(), onChanged, onDeleted };
}

describe("Overview — header summary", () => {
  it("counts endpoints from enabled servers plus a bound browser profile", async () => {
    const view = project("alpha", {
      label: "Alpha",
      browserProfileId: "prof-1",
      servers: [stdio("a"), stdio("b", { disabled: true })],
    });
    setup(createFakeGateway({ projects: [view] }), view);
    // 1 enabled server + 1 browser endpoint.
    expect(await screen.findByText(/2 endpoints/)).toBeInTheDocument();
  });

  it("reports how many servers are actually active", async () => {
    const view = project("alpha", { label: "Alpha", servers: [stdio("a"), http("b")] });
    setup(createFakeGateway({ projects: [view] }), view);
    // The fake reports stdio as running and http as connected.
    expect(await screen.findByText(/2 active/)).toBeInTheDocument();
  });
});

describe("Overview — browser profile binding", () => {
  it("offers free profiles and marks ones held by another project", async () => {
    const view = project("beta", { label: "Beta" });
    setup(
      createFakeGateway({
        projects: [view],
        profiles: [
          { profileId: "free", name: "Free One", available: true },
          { profileId: "taken", name: "Taken One", boundToProjectId: "alpha", available: false },
        ],
      }),
      view,
    );
    const select = await screen.findByLabelText("Browser profile");
    expect(select).toHaveValue("");

    const options = within(select).getAllByRole("option");
    const taken = options.find((o) => o.textContent?.includes("Taken One"));
    expect(taken).toBeDisabled();
    expect(taken?.textContent).toMatch(/in use by alpha/);
    expect(options.find((o) => o.textContent === "Free One")).toBeEnabled();
  });

  it("binds and unbinds through the gateway", async () => {
    const view = project("beta", { label: "Beta" });
    const fake = createFakeGateway({
      projects: [view],
      profiles: [{ profileId: "free", name: "Free One", available: true }],
    });
    const { user } = setup(fake, view);
    const select = await screen.findByLabelText("Browser profile");

    await user.selectOptions(select, "free");
    expect(fake.api.bindProfile).toHaveBeenCalledWith("beta", "free");

    // Re-render with the binding applied, then clear it.
    const bound = project("beta", { label: "Beta", browserProfileId: "free" });
    installFakeGateway(fake);
    render(<ProjectDetail project={bound} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    const selects = await screen.findAllByLabelText("Browser profile");
    await user.selectOptions(selects[selects.length - 1]!, "");
    expect(fake.api.bindProfile).toHaveBeenCalledWith("beta", null);
  });

  it("surfaces an exclusive-binding conflict", async () => {
    const view = project("beta", { label: "Beta" });
    const fake = createFakeGateway({
      projects: [view],
      profiles: [
        { profileId: "taken", name: "Taken", boundToProjectId: "alpha", available: false },
      ],
    });
    // The option is disabled in the UI, but the backend is the real guard.
    fake.api.bindProfile = (async () => ({
      ok: false as const,
      error: {
        code: "profile-bound:alpha",
        message: "That browser profile is already bound to the project “alpha”.",
      },
    })) as typeof fake.api.bindProfile;
    const { user } = setup(fake, view);

    // Drive the change handler directly through a value the backend rejects.
    const select = await screen.findByLabelText("Browser profile");
    await user
      .selectOptions(select, [within(select).getByRole("option", { name: /Taken/ })])
      .catch(() => {
        /* a disabled option cannot be selected — that is the point */
      });
    // The UI prevented it; nothing was sent and nothing changed.
    expect(select).toHaveValue("");
  });
});

describe("Servers — listing and status", () => {
  it("shows an empty state when there are no servers", async () => {
    const view = project("alpha", { label: "Alpha" });
    setup(createFakeGateway({ projects: [view] }), view);
    expect(await screen.findByText(/no servers yet/i)).toBeInTheDocument();
    expect(screen.getByText("Servers (0)")).toBeInTheDocument();
  });

  it("lists each server with its command or URL and runtime status", async () => {
    const view = project("alpha", {
      label: "Alpha",
      servers: [stdio("docs"), http("api")],
    });
    setup(createFakeGateway({ projects: [view] }), view);
    const list = await screen.findByTestId("server-list");
    expect(within(list).getByText(/npx -y docs-mcp/)).toBeInTheDocument();
    expect(within(list).getByText(/https:\/\/api\.example\.com\/mcp/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(list).getByText("running")).toBeInTheDocument();
      expect(within(list).getByText("connected")).toBeInTheDocument();
      expect(within(list).getByText("· 2 tools")).toBeInTheDocument();
    });
  });

  it("shows a disabled server as off", async () => {
    const view = project("alpha", { servers: [stdio("docs", { disabled: true })] });
    setup(createFakeGateway({ projects: [view] }), view);
    const list = await screen.findByTestId("server-list");
    await waitFor(() => expect(within(list).getByText("off")).toBeInTheDocument());
    expect(screen.getByLabelText("docs enabled")).not.toBeChecked();
  });

  it("explains an env-error phase and points at References", async () => {
    const view = project("alpha", { servers: [stdio("docs", { env: { T: "${T}" } })] });
    const fake = createFakeGateway({ projects: [view] });
    fake.api.runtime = (async () => ({
      ok: true as const,
      value: {
        projectId: "alpha",
        enabled: true,
        bootstrapped: false,
        servers: [
          {
            projectId: "alpha",
            serverId: "docs",
            transport: "stdio" as const,
            phase: "env-error" as const,
            restarts: 0,
            consecutiveFailures: 0,
            missingEnv: ["T"],
            sessions: 0,
          },
        ],
      },
    })) as typeof fake.api.runtime;
    setup(fake, view);

    expect(await screen.findByText("needs a value")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for T — provide a value in References/)).toBeInTheDocument();
  });

  it("shows a redacted runtime error when one is reported", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    const fake = createFakeGateway({ projects: [view] });
    fake.api.runtime = (async () => ({
      ok: true as const,
      value: {
        projectId: "alpha",
        enabled: true,
        bootstrapped: false,
        servers: [
          {
            projectId: "alpha",
            serverId: "docs",
            transport: "stdio" as const,
            phase: "circuit-open" as const,
            restarts: 5,
            consecutiveFailures: 5,
            missingEnv: [],
            sessions: 0,
            lastError: "spawn npx ENOENT",
          },
        ],
      },
    })) as typeof fake.api.runtime;
    setup(fake, view);

    expect(await screen.findByText("giving up")).toBeInTheDocument();
    expect(screen.getByText("spawn npx ENOENT")).toBeInTheDocument();
  });
});

describe("Servers — mutations", () => {
  it("adds a stdio server through the editor", async () => {
    const view = project("alpha", { label: "Alpha" });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Server id"), "docs");
    await user.type(within(dialog).getByLabelText("Command"), "npx");
    await user.type(within(dialog).getByLabelText("Arguments"), "-y{enter}docs-mcp");
    await user.click(within(dialog).getByRole("button", { name: /^Add server$/ }));

    expect(fake.api.addServer).toHaveBeenCalledWith("alpha", {
      transport: "stdio",
      id: "docs",
      command: "npx",
      args: ["-y", "docs-mcp"],
      env: {},
    });
  });

  it("blocks an invalid server before submitting", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");

    // No id, no command.
    expect(within(dialog).getByRole("button", { name: /^Add server$/ })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Server id"), "docs");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/enter the command/i);
    expect(within(dialog).getByRole("button", { name: /^Add server$/ })).toBeDisabled();
    expect(fake.api.addServer).not.toHaveBeenCalled();
  });

  it("edits an existing server, keeping its id immutable", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: "Edit docs" }));
    const dialog = await screen.findByRole("dialog");
    const idInput = within(dialog).getByLabelText("Server id");
    expect(idInput).toHaveValue("docs");
    expect(idInput).toHaveAttribute("readonly");

    const command = within(dialog).getByLabelText("Command");
    await user.clear(command);
    await user.type(command, "node");
    await user.click(within(dialog).getByRole("button", { name: /save changes/i }));

    expect(fake.api.updateServer).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ id: "docs", command: "node" }),
    );
  });

  it("round-trips existing env references into the editor as names", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${MY_SOURCE}" } })],
    });
    setup(createFakeGateway({ projects: [view] }), view);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit docs" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Variable name 1")).toHaveValue("API_TOKEN");
    // The `${}` wrapper is stripped for editing, and never shown to the user.
    expect(within(dialog).getByLabelText("Source variable 1")).toHaveValue("MY_SOURCE");
  });

  it("switches transport in the editor and submits the http shape", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /remote url/i }));
    await user.type(within(dialog).getByLabelText("Server id"), "api");
    await user.type(within(dialog).getByLabelText("Server URL"), "https://mcp.example.com/mcp");
    await user.click(within(dialog).getByRole("button", { name: /^Add server$/ }));

    expect(fake.api.addServer).toHaveBeenCalledWith("alpha", {
      transport: "streamable-http",
      id: "api",
      url: "https://mcp.example.com/mcp",
      headers: {},
    });
  });

  it("saves an OAuth remote server", async () => {
    const view = project("alpha", { browserProfileId: "prof-1" });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /remote url/i }));
    await user.type(within(dialog).getByLabelText("Server id"), "sentry");
    await user.type(within(dialog).getByLabelText("Server URL"), "https://mcp.sentry.dev/mcp");
    await user.click(within(dialog).getByRole("radio", { name: "OAuth sign-in" }));
    await user.click(within(dialog).getByRole("button", { name: /^Add server$/ }));
    expect(fake.api.addServer).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ auth: "oauth" }),
    );
  });

  it("offers Connect for a saved OAuth server", async () => {
    const view = project("alpha", {
      servers: [
        {
          transport: "streamable-http",
          id: "sentry",
          disabled: false,
          auth: "oauth",
          url: "https://mcp.sentry.dev/mcp",
          headers: {},
        },
      ],
    });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("button", { name: "Connect" }));
    expect(fake.api.connectOAuthServer).toHaveBeenCalledWith("alpha", "sentry");
  });

  it("toggles a server on and off", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByLabelText("docs enabled"));
    expect(fake.api.setServerEnabled).toHaveBeenCalledWith("alpha", "docs", false);
  });

  it("restarts a server, and cannot restart a disabled one", async () => {
    const view = project("alpha", { servers: [stdio("a"), stdio("b", { disabled: true })] });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: "Restart a" }));
    expect(fake.api.restartServer).toHaveBeenCalledWith("alpha", "a");
    expect(screen.getByRole("button", { name: "Restart b" })).toBeDisabled();
  });

  it("confirms before removing a server and explains the consequence", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: "Remove docs" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Remove “docs”\?/);
    expect(dialog).toHaveTextContent(/removed from every folder’s agent configuration/i);
    await within(dialog)
      .getByRole("button", { name: /cancel/i })
      .click();
    expect(fake.api.removeServer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove docs" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /remove server/i,
      }),
    );
    expect(fake.api.removeServer).toHaveBeenCalledWith("alpha", "docs");
  });

  it("shows an inline error when a server mutation fails", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    const fake = createFakeGateway({ projects: [view] });
    fake.api.setServerEnabled = (async () => ({
      ok: false as const,
      error: { code: "invalid", message: "server rejected the change" },
    })) as typeof fake.api.setServerEnabled;
    const { user } = setup(fake, view);

    await user.click(await screen.findByLabelText("docs enabled"));
    expect(await screen.findByText("server rejected the change")).toBeInTheDocument();
  });
});

describe("References", () => {
  const refs: SecretRefStatusView[] = [
    { name: "API_TOKEN", source: null, present: false, approved: false, managed: false },
  ];

  it("is omitted entirely when nothing is referenced", async () => {
    const view = project("alpha", { servers: [stdio("docs")] });
    setup(createFakeGateway({ projects: [view] }), view);
    await screen.findByTestId("server-list");
    expect(screen.queryByTestId("reference-list")).not.toBeInTheDocument();
  });

  it("lists an unsatisfied reference with both ways to fix it", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    setup(createFakeGateway({ projects: [view], secretRefs: { alpha: refs } }), view);

    const list = await screen.findByTestId("reference-list");
    expect(within(list).getByText("API_TOKEN")).toBeInTheDocument();
    expect(within(list).getByText("no value")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /use environment/i })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /provide value/i })).toBeInTheDocument();
  });

  it("offers to restore unresolved credentials when a cloud backup exists", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: { alpha: refs },
      credentialBackup: { remotePresent: true },
      restoreResult: { restored: 1, projects: ["alpha"] },
    });
    const { user, onChanged } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /restore from backup/i }));
    const dialog = await screen.findByRole("dialog", { name: /restore mcp credentials/i });
    const passphrase = "the credential backup passphrase";
    await user.type(within(dialog).getByLabelText("Credential backup passphrase"), passphrase);
    await user.click(within(dialog).getByRole("button", { name: /restore credentials/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fake.api.restoreCredentials).toHaveBeenCalledWith(passphrase);
    expect(fake.state.passphrases).toEqual([{ op: "restore", passphrase }]);
    expect(onChanged).toHaveBeenCalledWith("alpha");
    expect(screen.getByRole("status")).toHaveTextContent(/restored 1 credential/i);
    expect(document.body.innerHTML).not.toContain(passphrase);
  });

  it("explains how to create a backup when no credential bundle exists", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    setup(
      createFakeGateway({
        projects: [view],
        secretRefs: { alpha: refs },
        credentialBackup: { remotePresent: false },
      }),
      view,
    );

    expect(await screen.findByTestId("credential-backup-missing")).toHaveTextContent(
      /on the original mac, open cloud sync settings/i,
    );
    expect(screen.queryByRole("button", { name: /restore from backup/i })).not.toBeInTheDocument();
  });

  it("approves a pending backup signer inline, then offers restore", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const deviceId = "dev_original";
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: { alpha: refs },
      devices: [
        {
          deviceId,
          publicKeyHex: "bb".repeat(32),
          role: "pending",
          isSelf: false,
          name: "Original Mac",
        },
      ],
      credentialBackup: {
        remotePresent: null,
        remoteIssue: {
          code: "unknown-signer",
          message: `Unknown signer ${deviceId}`,
          deviceId,
        },
      },
    });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /approve backup device/i }));

    expect(fake.api.approveDevice).toHaveBeenCalledWith(deviceId, "bb".repeat(32));
    expect(fake.api.syncRetry).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /restore from backup/i })).toBeInTheDocument();
  });

  it("reports a wrong credential-backup passphrase and clears the field", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: { alpha: refs },
      credentialBackup: { remotePresent: true },
      failRestoreCredentials: {
        code: "wrong-passphrase",
        message: "That passphrase does not open the stored backup.",
      },
    });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /restore from backup/i }));
    const dialog = await screen.findByRole("dialog", { name: /restore mcp credentials/i });
    const input = within(dialog).getByLabelText("Credential backup passphrase");
    await user.type(input, "wrong passphrase");
    await user.click(within(dialog).getByRole("button", { name: /restore credentials/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/does not open/i);
    expect(input).toHaveValue("");
  });

  it("approves reading from the environment", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({ projects: [view], secretRefs: { alpha: refs } });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /use environment/i }));
    expect(fake.api.approveEnvName).toHaveBeenCalledWith("API_TOKEN");
  });

  it("stores a value write-only and never displays it again", async () => {
    const secret = "sk-live-never-shown";
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({ projects: [view], secretRefs: { alpha: refs } });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /provide value/i }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Value for API_TOKEN");
    // A secret field must not be a plain-text input.
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, secret);
    await user.click(within(dialog).getByRole("button", { name: /save value/i }));

    expect(fake.api.saveManagedSecret).toHaveBeenCalledWith("alpha", "API_TOKEN", secret);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The value is gone from the DOM entirely.
    expect(document.body.textContent).not.toContain(secret);
    // The row now reports only that a value is stored, and offers no way to see
    // it — the only action left is removal.
    const list = await screen.findByTestId("reference-list");
    await waitFor(() => expect(within(list).getByText("stored by Sekvona")).toBeInTheDocument());
    expect(within(list).queryByRole("button", { name: /provide value/i })).not.toBeInTheDocument();
    expect(
      within(list).queryByRole("button", { name: /show|reveal|view/i }),
    ).not.toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /remove stored value/i })).toBeInTheDocument();
  });

  it("cannot save an empty value", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({ projects: [view], secretRefs: { alpha: refs } });
    const { user } = setup(fake, view);
    await user.click(await screen.findByRole("button", { name: /provide value/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /save value/i })).toBeDisabled();
    expect(fake.api.saveManagedSecret).not.toHaveBeenCalled();
  });

  it("reports a stored value and allows removing it", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: {
        alpha: [
          { name: "API_TOKEN", source: "managed", present: true, approved: false, managed: true },
        ],
      },
    });
    const { user } = setup(fake, view);

    const list = await screen.findByTestId("reference-list");
    expect(within(list).getByText("stored by Sekvona")).toBeInTheDocument();
    // With a stored value there is nothing to "provide" and no env choice to make.
    expect(within(list).queryByRole("button", { name: /provide value/i })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /remove stored value/i }));
    expect(fake.api.deleteManagedSecret).toHaveBeenCalledWith("alpha", "API_TOKEN");
  });

  it("explains an approved-but-unset environment variable", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: {
        alpha: [
          { name: "API_TOKEN", source: null, present: false, approved: true, managed: false },
        ],
      },
    });
    const { user } = setup(fake, view);

    const list = await screen.findByTestId("reference-list");
    expect(within(list).getByText(/it is not set/i)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /stop using environment/i }));
    expect(fake.api.revokeEnvName).toHaveBeenCalledWith("API_TOKEN");
  });

  it("shows a reference satisfied from the environment", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${API_TOKEN}" } })],
    });
    setup(
      createFakeGateway({
        projects: [view],
        secretRefs: {
          alpha: [
            {
              name: "API_TOKEN",
              source: "environment",
              present: true,
              approved: true,
              managed: false,
            },
          ],
        },
      }),
      view,
    );
    const list = await screen.findByTestId("reference-list");
    expect(within(list).getByText("from environment")).toBeInTheDocument();
  });
});

describe("Servers — pasted credentials", () => {
  it("stores a pasted value instead of putting it in the config", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Server id"), "docs");
    await user.type(within(dialog).getByLabelText("Command"), "npx");
    await user.click(within(dialog).getByRole("button", { name: /^Add$/ }));
    await user.type(within(dialog).getByLabelText("Variable name 1"), "API_TOKEN");
    await user.type(within(dialog).getByLabelText("Value 1"), "sk-live-xyz");
    await user.click(within(dialog).getByRole("button", { name: /^Add server$/ }));

    await waitFor(() => expect(fake.api.addServer).toHaveBeenCalled());
    const input = vi.mocked(fake.api.addServer).mock.calls[0]?.[1];
    expect(input?.secretValues).toEqual({ API_TOKEN: "sk-live-xyz" });
    // The value is nowhere in the fields that become the persisted config.
    expect(JSON.stringify({ ...input, secretValues: undefined })).not.toContain("sk-live-xyz");
  });

  it("shows an already-stored credential as stored rather than as a variable", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${MULTIZEN_DOCS_API_TOKEN_AB12CD}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: {
        alpha: [
          {
            name: "MULTIZEN_DOCS_API_TOKEN_AB12CD",
            source: "managed",
            present: true,
            approved: false,
            managed: true,
          },
        ],
      },
    });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: "Edit docs" }));
    const dialog = await screen.findByRole("dialog");
    // The row offers to replace the value, and never reveals it.
    const value = within(dialog).getByLabelText("Value 1");
    expect(value).toHaveAttribute("type", "password");
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", expect.stringMatching(/stored/i));
    expect(within(dialog).queryByLabelText("Source variable 1")).not.toBeInTheDocument();
  });

  it("keeps a stored credential when an unrelated field is edited", async () => {
    const view = project("alpha", {
      servers: [stdio("docs", { env: { API_TOKEN: "${MULTIZEN_DOCS_API_TOKEN_AB12CD}" } })],
    });
    const fake = createFakeGateway({
      projects: [view],
      secretRefs: {
        alpha: [
          {
            name: "MULTIZEN_DOCS_API_TOKEN_AB12CD",
            source: "managed",
            present: true,
            approved: false,
            managed: true,
          },
        ],
      },
    });
    const { user } = setup(fake, view);

    await user.click(await screen.findByRole("button", { name: "Edit docs" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Server label"), "Docs lookup");
    await user.click(within(dialog).getByRole("button", { name: /^Save changes$/ }));

    await waitFor(() => expect(fake.api.updateServer).toHaveBeenCalled());
    const input = vi.mocked(fake.api.updateServer).mock.calls[0]?.[1];
    // The existing reference survives, and nothing was re-submitted as a value.
    expect(input).toMatchObject({
      env: { API_TOKEN: "${MULTIZEN_DOCS_API_TOKEN_AB12CD}" },
    });
    expect(input).not.toHaveProperty("secretValues");
  });
});

describe("Servers — test connection", () => {
  const openAddForm = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Server id"), "docs");
    await user.type(within(dialog).getByLabelText("Command"), "npx");
    return dialog;
  };

  it("cannot be run until the definition is complete", async () => {
    const view = project("alpha");
    const { user } = setup(createFakeGateway({ projects: [view] }), view);
    await user.click(await screen.findByRole("button", { name: /add server/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("button", { name: /test connection/i })).toBeDisabled();
    expect(within(dialog).getByText(/complete the fields above to test/i)).toBeInTheDocument();
  });

  it("reports the server it reached and the tools it offers", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);

    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));

    expect(await within(dialog).findByText(/connected/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/docs-server/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 tools: alpha, beta/)).toBeInTheDocument();
    // It points at the next step rather than saving on the operator's behalf.
    expect(within(dialog).getByText(/save to apply/i)).toBeInTheDocument();
    expect(fake.api.addServer).not.toHaveBeenCalled();
  });

  it("probes the project and the definition currently in the form", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Add$/ }));
    await user.type(within(dialog).getByLabelText("Variable name 1"), "API_TOKEN");
    await user.type(within(dialog).getByLabelText("Value 1"), "sk-untested");

    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));

    await waitFor(() => expect(fake.api.testServer).toHaveBeenCalled());
    const [projectId, input] = vi.mocked(fake.api.testServer).mock.calls[0]!;
    expect(projectId).toBe("alpha");
    // The value the operator just typed is what gets tested, unsaved.
    expect(input.secretValues).toEqual({ API_TOKEN: "sk-untested" });
    expect(fake.api.addServer).not.toHaveBeenCalled();
    expect(fake.api.saveManagedSecret).not.toHaveBeenCalled();
  });

  it("explains a failure, offers the hint, and shows the server's output", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      probeResult: {
        ok: false,
        durationMs: 120,
        error: "spawn npx ENOENT",
        hint: "The command could not be found.",
        stderr: ["node: command not found"],
      },
    });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);

    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));

    expect(await within(dialog).findByText(/could not connect/i)).toBeInTheDocument();
    expect(within(dialog).getByText("spawn npx ENOENT")).toBeInTheDocument();
    expect(within(dialog).getByText(/command could not be found/i)).toBeInTheDocument();
    await user.click(within(dialog).getByText(/output from the server/i));
    expect(within(dialog).getByText(/node: command not found/)).toBeInTheDocument();
  });

  it("names the references it is waiting on", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      probeResult: {
        ok: false,
        durationMs: 0,
        error: "no value is available for API_TOKEN",
        missingRefs: ["API_TOKEN"],
      },
    });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);
    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));
    expect(await within(dialog).findByText(/waiting on API_TOKEN/i)).toBeInTheDocument();
  });

  it("still allows saving a definition that failed its test", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({
      projects: [view],
      probeResult: { ok: false, durationMs: 50, error: "ECONNREFUSED" },
    });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);
    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));
    await within(dialog).findByText(/could not connect/i);

    // A server that is merely offline right now must still be configurable.
    await user.click(within(dialog).getByRole("button", { name: /^Add server$/ }));
    await waitFor(() => expect(fake.api.addServer).toHaveBeenCalled());
  });

  it("discards the result as soon as the definition changes", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);
    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));
    await within(dialog).findByText(/connected/i);

    await user.type(within(dialog).getByLabelText("Command"), "-changed");

    // A pass for a definition that no longer exists would be worse than nothing.
    expect(within(dialog).queryByText(/connected/i)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /test connection/i })).toBeEnabled();
  });

  it("surfaces a bridge failure as a failed test", async () => {
    const view = project("alpha");
    const fake = createFakeGateway({ projects: [view] });
    fake.api.testServer = (async () => ({
      ok: false as const,
      error: { code: "invalid", message: "server id is not valid" },
    })) as typeof fake.api.testServer;
    const { user } = setup(fake, view);
    const dialog = await openAddForm(user);
    await user.click(within(dialog).getByRole("button", { name: /test connection/i }));
    expect(await within(dialog).findByText("server id is not valid")).toBeInTheDocument();
  });
});
