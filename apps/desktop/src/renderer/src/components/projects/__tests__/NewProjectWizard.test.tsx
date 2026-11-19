import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assert, describe, expect, it, vi } from "vitest";

import {
  deriveProjectId,
  isValidProjectId,
  NewProjectWizard,
} from "../NewProjectWizard";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const onProfilesChanged = vi.fn();
  render(
    <NewProjectWizard
      open
      onClose={onClose}
      onCreated={onCreated}
      onProfilesChanged={onProfilesChanged}
    />,
  );
  return { onCreated, onClose, onProfilesChanged, user: userEvent.setup() };
}

/** Advance the wizard by clicking Continue `times` times. */
async function advance(
  user: ReturnType<typeof userEvent.setup>,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await user.click(screen.getByRole("button", { name: /continue/i }));
  }
}

describe("project id derivation", () => {
  it("lower-cases, collapses separators, and trims to the id grammar", () => {
    expect(deriveProjectId("Zabit Docs")).toBe("zabit-docs");
    expect(deriveProjectId("  Weird!!  Name??  ")).toBe("weird-name");
    expect(deriveProjectId("already-fine_1")).toBe("already-fine_1");
    expect(deriveProjectId("--leading and trailing--")).toBe("leading-and-trailing");
    expect(deriveProjectId("")).toBe("");
    expect(deriveProjectId("x".repeat(80))).toHaveLength(24);
  });

  it("accepts only the gateway's id grammar", () => {
    expect(isValidProjectId("ok_id-1")).toBe(true);
    expect(isValidProjectId("")).toBe(false);
    expect(isValidProjectId("Upper")).toBe(false);
    expect(isValidProjectId("has space")).toBe(false);
    expect(isValidProjectId("has.dot")).toBe(false);
    expect(isValidProjectId("a".repeat(65))).toBe(false);
  });
});

describe("wizard — identity step", () => {
  it("derives the id from the name and allows overriding it", async () => {
    const { user } = setup(createFakeGateway());
    await user.type(screen.getByLabelText("Project name"), "Zabit Docs");
    const idInput = screen.getByLabelText("Project id");
    expect(idInput).toHaveValue("zabit-docs");

    await user.clear(idInput);
    await user.type(idInput, "custom-id");
    expect(idInput).toHaveValue("custom-id");
    // Typing more of the name must not clobber an explicit override.
    await user.type(screen.getByLabelText("Project name"), " More");
    expect(screen.getByLabelText("Project id")).toHaveValue("custom-id");
  });

  it("blocks Continue until the id is valid", async () => {
    const { user } = setup(createFakeGateway());
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(screen.getByLabelText("Project id")).toHaveAttribute("aria-invalid", "true");

    await user.type(screen.getByLabelText("Project name"), "Fine");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();

    const idInput = screen.getByLabelText("Project id");
    await user.clear(idInput);
    await user.type(idInput, "Bad ID!");
    expect(screen.getByText(/only lower-case letters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });
});

describe("wizard — browser profile step", () => {
  it("defaults to no profile and offers the available ones", async () => {
    const { user } = setup(
      createFakeGateway({
        profiles: [
          { profileId: "prof-a", name: "Profile A", available: true },
          { profileId: "prof-b", name: "Profile B", available: true },
        ],
      }),
    );
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);

    expect(await screen.findByLabelText("No browser profile")).toBeChecked();
    expect(screen.getByLabelText("Profile A")).not.toBeChecked();
    await user.click(screen.getByLabelText("Profile A"));
    expect(screen.getByLabelText("Profile A")).toBeChecked();
  });

  it("disables a profile bound to another project and says which one", async () => {
    const { user } = setup(
      createFakeGateway({
        profiles: [
          { profileId: "prof-a", name: "Profile A", boundToProjectId: "alpha", available: false },
        ],
      }),
    );
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);

    const option = await screen.findByLabelText("Profile A");
    expect(option).toBeDisabled();
    expect(screen.getByText(/already bound to “alpha”/i)).toBeInTheDocument();
  });

  it("explains when there are no profiles at all", async () => {
    const { user } = setup(createFakeGateway({ profiles: [] }));
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);
    expect(await screen.findByText(/no browser profiles exist yet/i)).toBeInTheDocument();
    // The step is not a dead end: a profile can be made without leaving here.
    expect(screen.getByRole("button", { name: /new profile/i })).toBeInTheDocument();
  });

  it("creates a profile inline and selects it", async () => {
    const fake = createFakeGateway({ profiles: [] });
    const { user, onProfilesChanged } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);

    await user.click(await screen.findByRole("button", { name: /new profile/i }));
    await user.type(screen.getByLabelText("New profile name"), "zabit.ai");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));

    expect(fake.profilesApi.create).toHaveBeenCalledWith({ name: "zabit.ai" });
    // It appears in the list AND is already the chosen one, so the operator does
    // not have to find and tick it afterwards.
    const option = await screen.findByLabelText("zabit.ai");
    expect(option).toBeChecked();
    expect(screen.getByLabelText("No browser profile")).not.toBeChecked();
    // The form collapses once it succeeded.
    expect(screen.queryByLabelText("New profile name")).not.toBeInTheDocument();
    // The rest of the app is told, so the Profiles screen is not left stale.
    expect(onProfilesChanged).toHaveBeenCalled();
  });

  it("binds the inline-created profile to the project it is creating", async () => {
    const fake = createFakeGateway({ profiles: [] });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "Inline");
    await advance(user, 1);
    await user.click(await screen.findByRole("button", { name: /new profile/i }));
    await user.type(screen.getByLabelText("New profile name"), "fresh");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));
    await screen.findByLabelText("fresh");

    await advance(user, 2);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(fake.api.setupProject).toHaveBeenCalled());
    expect(vi.mocked(fake.api.setupProject).mock.calls[0]?.[0]).toMatchObject({
      id: "inline",
      browserProfileId: "new-profile-1",
    });
  });

  it("trims the name and refuses an empty one without calling the bridge", async () => {
    const fake = createFakeGateway({ profiles: [] });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);
    await user.click(await screen.findByRole("button", { name: /new profile/i }));

    // Nothing typed → Create is inert rather than submitting a blank profile.
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();

    await user.type(screen.getByLabelText("New profile name"), "  spaced  ");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));
    expect(fake.profilesApi.create).toHaveBeenCalledWith({ name: "spaced" });
  });

  it("reports a failed creation and keeps the typed name for another go", async () => {
    const fake = createFakeGateway({
      profiles: [],
      failProfileCreate: "profile directory is not writable",
    });
    const { user, onProfilesChanged } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);
    await user.click(await screen.findByRole("button", { name: /new profile/i }));
    await user.type(screen.getByLabelText("New profile name"), "doomed");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));

    expect(await screen.findByText(/profile directory is not writable/i)).toBeInTheDocument();
    // The form stays open with the name intact, and nothing was selected.
    expect(screen.getByLabelText("New profile name")).toHaveValue("doomed");
    expect(screen.getByLabelText("No browser profile")).toBeChecked();
    expect(onProfilesChanged).not.toHaveBeenCalled();
  });
  it("abandons the inline form without creating anything", async () => {
    const fake = createFakeGateway({ profiles: [] });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 1);
    await user.click(await screen.findByRole("button", { name: /new profile/i }));
    await user.type(screen.getByLabelText("New profile name"), "never");

    // The inline form has its own Cancel; it must not close the whole wizard.
    const form = screen.getByLabelText("New profile name").closest("div")!;
    await user.click(within(form).getByRole("button", { name: /cancel/i }));

    expect(fake.profilesApi.create).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New profile name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new profile/i })).toBeInTheDocument();
  });
});

describe("wizard — server step", () => {
  it("skips the server by default, producing a browser-only project", async () => {
    const fake = createFakeGateway({
      profiles: [{ profileId: "prof-a", name: "Profile A", available: true }],
    });
    const { user, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "Browser Only");
    await advance(user, 1);
    await user.click(await screen.findByLabelText("Profile A"));
    await advance(user, 2);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("browser-only"));
    const input = vi.mocked(fake.api.setupProject).mock.calls[0]?.[0];
    expect(input?.server).toBeUndefined();
    expect(input?.browserProfileId).toBe("prof-a");
  });

  it("validates a stdio server before it can be submitted", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));

    // No id yet → blocked.
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByLabelText("Server id"), "docs");
    // Still blocked: stdio needs a command.
    expect(screen.getByText(/enter the command that starts the server/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Command"), "npx");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("sends a stdio server with one argument per line and a stored credential", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));
    await user.type(screen.getByLabelText("Server id"), "docs");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.type(screen.getByLabelText("Arguments"), "-y{enter}@scope/docs-mcp");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await user.type(screen.getByLabelText("Variable name 1"), "API_TOKEN");
    // Pasting the value is the default, so no mode switch is needed.
    await user.type(screen.getByLabelText("Value 1"), "sk-live-abc123");
    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const input = vi.mocked(fake.api.setupProject).mock.calls[0]?.[0];
    expect(input?.server).toEqual({
      transport: "stdio",
      id: "docs",
      command: "npx",
      args: ["-y", "@scope/docs-mcp"],
      // The value travels in secretValues; env is left for the backend to fill
      // with the reference it derives, so no value is ever in the config.
      env: {},
      secretValues: { API_TOKEN: "sk-live-abc123" },
    });
  });

  it("sends an environment reference instead when asked to", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));
    await user.type(screen.getByLabelText("Server id"), "docs");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await user.type(screen.getByLabelText("Variable name 1"), "API_TOKEN");
    await user.click(
      within(screen.getByRole("radiogroup", { name: /how to supply API_TOKEN/i })).getByRole(
        "radio",
        { name: "Variable" },
      ),
    );

    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const input = vi.mocked(fake.api.setupProject).mock.calls[0]?.[0];
    // The source name mirrors the variable name as it is typed.
    expect(input?.server).toMatchObject({ env: { API_TOKEN: "${API_TOKEN}" } });
    expect(input?.server).not.toHaveProperty("secretValues");
  });

  it("validates an http URL and sends header references", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));
    await user.click(screen.getByRole("radio", { name: /remote url/i }));
    await user.type(screen.getByLabelText("Server id"), "api");

    await user.type(screen.getByLabelText("Server URL"), "not a url");
    expect(screen.getByText(/that url is not valid/i)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Server URL"));
    await user.type(screen.getByLabelText("Server URL"), "ftp://example.com");
    expect(screen.getByText(/must use http or https/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Server URL"));
    await user.type(screen.getByLabelText("Server URL"), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await user.type(screen.getByLabelText("Header name 1"), "Authorization");
    await user.click(
      within(screen.getByRole("radiogroup", { name: /how to supply Authorization/i })).getByRole(
        "radio",
        { name: "Variable" },
      ),
    );
    await user.clear(screen.getByLabelText("Source variable 1"));
    await user.type(screen.getByLabelText("Source variable 1"), "MY_TOKEN");
    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const input = vi.mocked(fake.api.setupProject).mock.calls[0]?.[0];
    expect(input?.server).toEqual({
      transport: "streamable-http",
      id: "api",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "${MY_TOKEN}" },
    });
  });

  it("blocks submission when a credential row has neither a value nor a variable", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));
    await user.type(screen.getByLabelText("Server id"), "docs");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await user.type(screen.getByLabelText("Variable name 1"), "API_TOKEN");

    // An empty value row is a mistake, not an implicit "leave it blank".
    expect(screen.getByText(/paste a value for “API_TOKEN”/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("masks a pasted value and keeps it out of the config fields", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 2);
    await user.click(screen.getByLabelText("Add a server now"));
    await user.type(screen.getByLabelText("Server id"), "docs");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await user.type(screen.getByLabelText("Variable name 1"), "API_TOKEN");
    await user.type(screen.getByLabelText("Value 1"), "sk-secret-value");

    // Typed secrets are not shown on screen.
    expect(screen.getByLabelText("Value 1")).toHaveAttribute("type", "password");

    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const input = vi.mocked(fake.api.setupProject).mock.calls[0]?.[0];
    // The value appears ONLY under secretValues — never in env, where it would
    // end up in the persisted, synced project config.
    const server = input?.server;
    assert(server !== undefined && server.transport === "stdio");
    expect(JSON.stringify(server.env)).not.toContain("sk-secret-value");
    expect(server.secretValues).toEqual({ API_TOKEN: "sk-secret-value" });
  });
});

describe("wizard — folders step", () => {
  it("creates a project with zero folders", async () => {
    const fake = createFakeGateway();
    const { user, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "No Folders");
    await advance(user, 3);
    expect(screen.getByText(/no folders yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("no-folders"));
    expect(vi.mocked(fake.api.setupProject).mock.calls[0]?.[0]?.directories).toEqual([]);
  });

  it("adds a folder from the native picker and sends its agent selection", async () => {
    const fake = createFakeGateway({ pickResult: "/abs/work" });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 3);
    await user.click(screen.getByRole("button", { name: /add folder/i }));

    expect(await screen.findByText("/abs/work")).toBeInTheDocument();
    // A folder with no agent selected is called out and excluded from the request.
    expect(screen.getByText(/select at least one agent/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText("Cursor — /abs/work"));
    await user.click(screen.getByLabelText("Codex — /abs/work"));
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(vi.mocked(fake.api.setupProject).mock.calls[0]?.[0]?.directories).toEqual([
      { directory: "/abs/work", agents: ["cursor", "codex"] },
    ]);
  });

  it("supports multiple folders with different agent selections", async () => {
    const fake = createFakeGateway({ pickResult: "/abs/one" });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 3);

    await user.click(screen.getByRole("button", { name: /add folder/i }));
    await screen.findByText("/abs/one");
    fake.api.pickDirectory = (async () => "/abs/two") as typeof fake.api.pickDirectory;
    installFakeGateway(fake);
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    await screen.findByText("/abs/two");

    await user.click(screen.getByLabelText("Claude Code — /abs/one"));
    await user.click(screen.getByLabelText("Kiro CLI — /abs/two"));
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(vi.mocked(fake.api.setupProject).mock.calls[0]?.[0]?.directories).toEqual([
      { directory: "/abs/one", agents: ["claude-code"] },
      { directory: "/abs/two", agents: ["kiro-cli"] },
    ]);
  });

  it("ignores a cancelled folder picker and de-duplicates the same folder", async () => {
    const fake = createFakeGateway({ pickResult: null });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 3);
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    expect(screen.getByText(/no folders yet/i)).toBeInTheDocument();

    fake.api.pickDirectory = (async () => "/abs/same") as typeof fake.api.pickDirectory;
    installFakeGateway(fake);
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    await screen.findByText("/abs/same");
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    expect(screen.getAllByText("/abs/same")).toHaveLength(1);
  });

  it("removes a folder", async () => {
    const fake = createFakeGateway({ pickResult: "/abs/work" });
    const { user } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "P");
    await advance(user, 3);
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    await screen.findByText("/abs/work");
    await user.click(screen.getByRole("button", { name: "Remove /abs/work" }));
    expect(screen.queryByText("/abs/work")).not.toBeInTheDocument();
  });
});

describe("wizard — submission", () => {
  it("navigates back and forth without losing entered data", async () => {
    const { user } = setup(createFakeGateway());
    await user.type(screen.getByLabelText("Project name"), "Keep Me");
    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByLabelText("Project name")).toHaveValue("Keep Me");
    expect(screen.getByLabelText("Project id")).toHaveValue("keep-me");
  });

  it("surfaces a duplicate-id conflict from the backend", async () => {
    const fake = createFakeGateway({ projects: [project("taken")] });
    const { user, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "taken");
    await advance(user, 3);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("surfaces an exclusive-profile conflict raised at submit time", async () => {
    const fake = createFakeGateway({
      profiles: [{ profileId: "prof-a", name: "Profile A", available: true }],
    });
    // The profile is taken by another project between listing and submitting.
    fake.api.setupProject = (async () => ({
      ok: false as const,
      error: {
        code: "profile-bound:alpha",
        message: "That browser profile is already bound to the project “alpha”.",
      },
    })) as typeof fake.api.setupProject;
    const { user, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "Beta");
    await advance(user, 1);
    await user.click(await screen.findByLabelText("Profile A"));
    await advance(user, 2);
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already bound to the project/i);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reports a partial install failure and keeps the created project", async () => {
    const fake = createFakeGateway({ pickResult: "/abs/work" });
    fake.api.setupProject = (async (input) => ({
      ok: true as const,
      value: {
        project: { ...project(input.id), enabled: false },
        enabled: false,
        reconcile: {
          projectId: input.id,
          allCurrent: false,
          bindings: [
            {
              projectId: input.id,
              directory: "/abs/work",
              agents: [
                {
                  agent: "cursor" as const,
                  status: "error" as const,
                  configPath: "/abs/work/.cursor/mcp.json",
                  lastInstalledAt: null,
                  error: ".cursor/mcp.json is not valid JSON",
                },
              ],
            },
          ],
        },
      },
    })) as typeof fake.api.setupProject;

    const { user, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "Partial");
    await advance(user, 3);
    await user.click(screen.getByRole("button", { name: /add folder/i }));
    await screen.findByText("/abs/work");
    await user.click(screen.getByLabelText("Cursor — /abs/work"));
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/some folders need attention/i);
    expect(alert).toHaveTextContent(/left switched off/i);
    expect(alert).toHaveTextContent(/Cursor in \/abs\/work/);
    expect(alert).toHaveTextContent(/not valid JSON/);
    // The operator is not auto-navigated away; they choose to open the project.
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /open project/i }));
    expect(onCreated).toHaveBeenCalledWith("partial");
  });

  it("cancelling closes without creating anything", async () => {
    const fake = createFakeGateway();
    const { user, onClose, onCreated } = setup(fake);
    await user.type(screen.getByLabelText("Project name"), "Abandoned");
    await advance(user, 1);
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(fake.api.setupProject).not.toHaveBeenCalled();
  });
});
