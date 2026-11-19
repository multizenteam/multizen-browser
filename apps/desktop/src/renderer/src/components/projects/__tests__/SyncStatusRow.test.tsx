import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectsScreen } from "../ProjectsScreen";
import { SyncStatusRow } from "../SyncStatusRow";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  const onSynced = vi.fn();
  render(<SyncStatusRow onSynced={onSynced} />);
  return { onSynced, user: userEvent.setup() };
}

describe("Sync status — states", () => {
  it("says projects are device-only when sync is not configured", async () => {
    setup(createFakeGateway({ sync: { ready: false } }));
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByText("Not syncing")).toBeInTheDocument();
    expect(within(row).getByText(/stored on this device only/i)).toBeInTheDocument();
    // Not an error state — the gateway is designed to work offline.
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows pending uploads and unreadable projects separately from conflicts", async () => {
    setup(createFakeGateway({ sync: { ready: true, pending: 2, unreadable: 1 } }));
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByText(/2 awaiting upload.*1 could not be read/)).toBeInTheDocument();
    expect(within(row).queryByText(/refused|conflicted/)).not.toBeInTheDocument();
  });

  it("reports when it has never synced despite being ready", async () => {
    setup(createFakeGateway({ sync: { ready: true, lastSyncAt: null } }));
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByText("Cloud sync on")).toBeInTheDocument();
    expect(within(row).getByText("No sync yet.")).toBeInTheDocument();
  });

  it("shows how long ago the last pass ran", async () => {
    setup(
      createFakeGateway({
        sync: { ready: true, lastSyncAt: Date.now() - 5 * 60_000 },
      }),
    );
    expect(await screen.findByText(/last synced 5m ago/i)).toBeInTheDocument();
  });

  it("surfaces the last error instead of hiding it", async () => {
    setup(
      createFakeGateway({
        sync: { ready: true, lastError: "bucket unreachable: getaddrinfo ENOTFOUND" },
      }),
    );
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByRole("alert")).toHaveTextContent(/ENOTFOUND/);
  });

  it("counts refused and conflicted records and points at the project", async () => {
    setup(
      createFakeGateway({
        sync: { ready: true, lastSyncAt: Date.now(), quarantined: 2, conflicts: 1 },
      }),
    );
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByText(/2 refused/)).toBeInTheDocument();
    expect(within(row).getByText(/1 conflicted/)).toBeInTheDocument();
    // The counts are a button, because they lead somewhere that can act on them.
    expect(within(row).getByRole("button", { name: /refused.*conflicted.*review/i })).toBeInTheDocument();
  });

  it("disables retry while a pass is already running", async () => {
    setup(createFakeGateway({ sync: { ready: true, running: true } }));
    const row = await screen.findByTestId("sync-status");
    expect(within(row).getByText("Syncing…")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /retry/i })).toBeDisabled();
  });

  it("renders nothing until the status has been read", () => {
    const fake = createFakeGateway();
    fake.api.syncStatus = (() => new Promise(() => {})) as typeof fake.api.syncStatus;
    installFakeGateway(fake);
    render(<SyncStatusRow onSynced={vi.fn()} />);
    expect(screen.queryByTestId("sync-status")).not.toBeInTheDocument();
  });
});

describe("Sync status — retry", () => {
  it("re-composes sync and reports the new state", async () => {
    const fake = createFakeGateway({ sync: { ready: false } });
    const { user, onSynced } = setup(fake);
    await screen.findByText("Not syncing");

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(fake.api.syncRetry).toHaveBeenCalled();
    // This is the "configured Cloud Sync after launch" recovery: the row flips
    // from not-syncing to on without an app restart.
    expect(await screen.findByText("Cloud sync on")).toBeInTheDocument();
    // A pass may have applied remote projects, so the list must be re-read.
    expect(onSynced).toHaveBeenCalled();
  });

  it("keeps showing the failure when the retry itself fails", async () => {
    const fake = createFakeGateway({ sync: { ready: true } });
    fake.api.syncRetry = (async () => ({
      ok: false as const,
      error: { code: "store", message: "credentials rejected" },
    })) as typeof fake.api.syncRetry;
    const { user, onSynced } = setup(fake);
    await screen.findByTestId("sync-status");

    await user.click(screen.getByRole("button", { name: /retry/i }));

    // No false "synced" signal, and the button comes back for another attempt.
    expect(onSynced).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled(),
    );
  });

  it("reports quarantined records discovered by the retry", async () => {
    const fake = createFakeGateway({
      sync: { ready: false },
      syncAfterRetry: { quarantined: 1 },
    });
    const { user } = setup(fake);
    await screen.findByText("Not syncing");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/1 refused/)).toBeInTheDocument();
  });
});

describe("Sync status — on the Projects screen", () => {
  it("appears under the project list", async () => {
    const view = project("alpha", { label: "Alpha" });
    installFakeGateway(createFakeGateway({ projects: [view], sync: { ready: true } }));
    render(<ProjectsScreen />);
    expect(await screen.findByTestId("sync-status")).toBeInTheDocument();
    expect(screen.getByText("Cloud sync on")).toBeInTheDocument();
  });

  it("re-reads the project list when a retry applies remote projects", async () => {
    const fake = createFakeGateway({ sync: { ready: false } });
    installFakeGateway(fake);
    render(<ProjectsScreen />);
    const user = userEvent.setup();
    await screen.findByTestId("sync-status");

    // A remote project lands in the store as the retry runs, exactly as a real
    // pass would apply it before the status comes back.
    fake.state.projects.set("remote", project("remote", { label: "Remote" }));
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("Remote")).toBeInTheDocument();
  });
});
