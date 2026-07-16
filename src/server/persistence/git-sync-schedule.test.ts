import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "./memory-store";
import {
  GIT_SYNC_FAILURE_BACKOFF_MS,
  GIT_SYNC_INTERVAL_MS
} from "./store";

async function createGitRepository(store: MemoryAppStore) {
  const setup = await store.createInitialSetup("sync-schedule@example.com", "hash");
  const repository = await store.createRepository(setup!.workspace.id, {
    kind: "git",
    name: "Scheduled source",
    url: "https://github.com/example/scheduled-source.git"
  });
  expect(repository).not.toBeNull();
  return repository!;
}

describe("durable Git synchronization scheduling", () => {
  test("claims a repository once until its lease expires", async () => {
    const store = new MemoryAppStore();
    const repository = await createGitRepository(store);
    const now = new Date("2040-01-01T00:00:00.000Z");

    const [claim] = await store.claimDueGitSynchronizations(now, 10, 60_000);

    expect(claim?.repository.id).toBe(repository.id);
    await expect(store.claimDueGitSynchronizations(now, 10, 60_000)).resolves.toEqual([]);
    await expect(store.claimDueGitSynchronizations(new Date(now.getTime() + 59_999), 10, 60_000))
      .resolves.toEqual([]);
    await expect(store.claimDueGitSynchronizations(new Date(now.getTime() + 60_000), 10, 60_000))
      .resolves.toEqual([expect.objectContaining({ repository })]);
  });

  test("backs off failures and resets to the regular interval after success", async () => {
    const store = new MemoryAppStore();
    const repository = await createGitRepository(store);
    const now = new Date("2040-01-01T00:00:00.000Z");
    const [firstClaim] = await store.claimDueGitSynchronizations(now, 10, 60_000);

    await expect(store.finishGitSynchronization({
      repositoryId: repository.id,
      leaseToken: firstClaim!.leaseToken,
      status: "failed",
      failureCode: "GIT_SYNC_TIMEOUT",
      now
    })).resolves.toBe(true);
    await expect(store.claimDueGitSynchronizations(
      new Date(now.getTime() + GIT_SYNC_FAILURE_BACKOFF_MS - 1), 10, 60_000
    )).resolves.toEqual([]);

    const [retryClaim] = await store.claimDueGitSynchronizations(
      new Date(now.getTime() + GIT_SYNC_FAILURE_BACKOFF_MS), 10, 60_000
    );
    expect(retryClaim?.repository.id).toBe(repository.id);
    const successAt = new Date(now.getTime() + GIT_SYNC_FAILURE_BACKOFF_MS);
    await expect(store.finishGitSynchronization({
      repositoryId: repository.id,
      leaseToken: retryClaim!.leaseToken,
      status: "succeeded",
      now: successAt
    })).resolves.toBe(true);
    await expect(store.claimDueGitSynchronizations(
      new Date(successAt.getTime() + GIT_SYNC_INTERVAL_MS - 1), 10, 60_000
    )).resolves.toEqual([]);
    await expect(store.claimDueGitSynchronizations(
      new Date(successAt.getTime() + GIT_SYNC_INTERVAL_MS), 10, 60_000
    )).resolves.toEqual([expect.objectContaining({ repository })]);
  });

  test("refuses completion from a stale lease", async () => {
    const store = new MemoryAppStore();
    const repository = await createGitRepository(store);
    const now = new Date("2040-01-01T00:00:00.000Z");
    const [firstClaim] = await store.claimDueGitSynchronizations(now, 10, 60_000);
    const [replacementClaim] = await store.claimDueGitSynchronizations(
      new Date(now.getTime() + 60_000), 10, 60_000
    );

    await expect(store.finishGitSynchronization({
      repositoryId: repository.id,
      leaseToken: firstClaim!.leaseToken,
      status: "succeeded",
      now: new Date(now.getTime() + 60_000)
    })).resolves.toBe(false);
    await expect(store.finishGitSynchronization({
      repositoryId: repository.id,
      leaseToken: replacementClaim!.leaseToken,
      status: "succeeded",
      now: new Date(now.getTime() + 60_000)
    })).resolves.toBe(true);
  });
});
