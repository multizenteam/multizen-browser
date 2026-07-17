import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLaunchTimezone,
  StrictGeoCoherenceError,
} from "./launchTimezone.ts";

const enPk = {
  timezone: "Asia/Karachi",
  country: "pk",
};

const localeTz = ["Asia/Karachi"] as const;

test("strict pin: en-PK stays Karachi when geo reports Europe/Paris", () => {
  const result = resolveLaunchTimezone(
    enPk,
    { timezone: "Europe/Paris", country: "fr" },
    localeTz,
  );
  assert.equal(result.timezone, "Asia/Karachi");
  assert.equal(result.appliedGeoTimezone, false);
  assert.ok(result.warnings.some((w) => w.includes("keeping pinned")));
  assert.ok(result.warnings.some((w) => w.includes("country")));
});

test("alignTimezoneToProxy + Paris ∉ locale allowlist → still Karachi + warning", () => {
  const result = resolveLaunchTimezone(
    enPk,
    { timezone: "Europe/Paris", country: "fr" },
    localeTz,
    { alignTimezoneToProxy: true },
  );
  assert.equal(result.timezone, "Asia/Karachi");
  assert.equal(result.appliedGeoTimezone, false);
  assert.ok(result.warnings.some((w) => w.includes("not in locale allowlist")));
});

test("alignTimezoneToProxy + geo TZ in allowlist → apply", () => {
  const result = resolveLaunchTimezone(
    enPk,
    { timezone: "Asia/Karachi", country: "pk" },
    localeTz,
    { alignTimezoneToProxy: true },
  );
  assert.equal(result.timezone, "Asia/Karachi");
  assert.equal(result.appliedGeoTimezone, false);
  assert.equal(result.warnings.length, 0);
});

test("alignTimezoneToProxy applies alternate allowlisted TZ", () => {
  const us = { timezone: "America/New_York", country: "us" };
  const result = resolveLaunchTimezone(
    us,
    { timezone: "America/Chicago", country: "us" },
    ["America/New_York", "America/Chicago", "America/Denver"],
    { alignTimezoneToProxy: true },
  );
  assert.equal(result.timezone, "America/Chicago");
  assert.equal(result.appliedGeoTimezone, true);
});

test("strictGeoCoherence throws on country mismatch", () => {
  assert.throws(
    () =>
      resolveLaunchTimezone(
        enPk,
        { timezone: "Europe/Paris", country: "fr" },
        localeTz,
        { strictGeoCoherence: true },
      ),
    (err: unknown) => err instanceof StrictGeoCoherenceError,
  );
});

test("no geo → keep pinned, no warnings", () => {
  const result = resolveLaunchTimezone(enPk, null, localeTz);
  assert.equal(result.timezone, "Asia/Karachi");
  assert.equal(result.warnings.length, 0);
});
