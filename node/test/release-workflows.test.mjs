import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncLockfileVersion } from "../scripts/sync-lockfile-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "@cluic/codex-remote-proxy";
const repository = "cluic/codex-remote-proxy";

function readWorkflowText(name) {
  return readFileSync(resolve(repositoryRoot, ".github/workflows", name), "utf8")
    .replace(/\r\n/g, "\n");
}

function extractStepBlock(workflowText, stepName) {
  const lines = workflowText.split("\n");
  const marker = `      - name: ${stepName}`;
  const starts = lines
    .map((line, index) => line === marker ? index : -1)
    .filter((index) => index !== -1);
  assert.equal(starts.length, 1, `expected one active step named ${stepName}`);
  const start = starts[0];
  const next = lines.findIndex((line, index) => (
    index > start && line.startsWith("      - name: ")
  ));
  return lines.slice(start, next === -1 ? lines.length : next).join("\n");
}

function extractTopLevelChildKeys(workflowText, sectionName) {
  const lines = workflowText.split("\n");
  const marker = `${sectionName}:`;
  const starts = lines
    .map((line, index) => line === marker ? index : -1)
    .filter((index) => index !== -1);
  assert.equal(starts.length, 1, `expected one top-level ${sectionName} section`);
  const keys = [];
  for (const line of lines.slice(starts[0] + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    const match = /^  ([A-Za-z0-9_-]+):(?:\s|$)/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function extractFoldedIf(stepBlock) {
  const lines = stepBlock.split("\n");
  const start = lines.indexOf("        if: >-");
  assert.notEqual(start, -1, "expected one folded if field in the active step");
  const values = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("          ")) break;
    const value = line.slice(10);
    assert.equal(value.startsWith("#"), false);
    values.push(value);
  }
  assert.equal(values.length > 0, true);
  return values.join(" ");
}

function extractSingleLineIf(stepBlock) {
  const matches = [...stepBlock.matchAll(/^        if: ([^#].*)$/gm)];
  assert.equal(matches.length, 1, "expected one active single-line if field");
  return matches[0][1];
}

function normalizeExpression(expression) {
  return String(expression).replace(/\s+/g, " ").trim();
}

function makePullRequestEvent({
  headRepository = repository,
  headRef = "feature/provider-ui",
  author = "developer"
} = {}) {
  return {
    name: "pull_request",
    pull_request: {
      head: { repo: { full_name: headRepository }, ref: headRef },
      user: { login: author }
    }
  };
}

function isStrictChangesetsReleasePullRequest(event, currentRepository) {
  return event.name === "pull_request"
    && event.pull_request?.head?.repo?.full_name === currentRepository
    && event.pull_request?.head?.ref?.startsWith("changeset-release/")
    && event.pull_request?.user?.login === "github-actions[bot]";
}

function evaluateChangesetGate({ event, changedPaths, releases }) {
  const exempt = isStrictChangesetsReleasePullRequest(event, repository);
  const releaseImpact = changedPaths.some((path) => (
    /^node\/(?:bin|src|ui)\//.test(path)
    || /^node\/package(?:-lock)?\.json$/.test(path)
  ));
  const changesetPathPresent = changedPaths.some((path) => (
    /^node\/\.changeset\/.*\.md$/.test(path)
    && path !== "node/.changeset/README.md"
  ));
  const patchRelease = releases.some((release) => (
    release.name === packageName && release.type === "patch"
  ));

  if (exempt) return { passes: true, exempt: true };
  if (releaseImpact && !changesetPathPresent) return { passes: false, exempt: false };
  if (changesetPathPresent && !patchRelease) return { passes: false, exempt: false };
  return { passes: true, exempt: false };
}

test("release workflow allows only the exact Changesets release pull request exemption", () => {
  const releaseEvent = makePullRequestEvent({
    headRef: "changeset-release/main",
    author: "github-actions[bot]"
  });
  const consumedReleaseChanges = [
    "node/.changeset/multi-provider-local-ui.md",
    "node/package.json",
    "node/package-lock.json",
    "node/CHANGELOG.md"
  ];
  assert.deepEqual(
    evaluateChangesetGate({
      event: releaseEvent,
      changedPaths: consumedReleaseChanges,
      releases: []
    }),
    { passes: true, exempt: true }
  );

  const mismatches = [
    { ...releaseEvent, name: "push" },
    makePullRequestEvent({
      headRepository: "fork/codex-remote-proxy",
      headRef: "changeset-release/main",
      author: "github-actions[bot]"
    }),
    makePullRequestEvent({ headRef: "feature/not-release", author: "github-actions[bot]" }),
    makePullRequestEvent({ headRef: "changeset-release/main", author: "developer" })
  ];
  for (const event of mismatches) {
    assert.deepEqual(
      evaluateChangesetGate({ event, changedPaths: consumedReleaseChanges, releases: [] }),
      { passes: false, exempt: false }
    );
  }
});

test("ordinary feature pull requests require this package's patch Changeset", () => {
  const event = makePullRequestEvent();
  const sourceChange = "node/src/providers/provider-service.mjs";
  const changeset = "node/.changeset/multi-provider-local-ui.md";

  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, changeset],
    releases: [{ name: packageName, type: "patch" }]
  }).passes, true);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange],
    releases: []
  }).passes, false);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, changeset],
    releases: [{ name: packageName, type: "minor" }]
  }).passes, false);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, changeset],
    releases: [{ name: packageName, type: "major" }]
  }).passes, false);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, changeset],
    releases: [{ name: "another-package", type: "patch" }]
  }).passes, false);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, "node/.changeset/feature-README.md"],
    releases: [{ name: packageName, type: "patch" }]
  }).passes, true);
  assert.equal(evaluateChangesetGate({
    event,
    changedPaths: [sourceChange, "node/.changeset/README.md"],
    releases: [{ name: packageName, type: "patch" }]
  }).passes, false);
});

test("release preflight encodes the strict event-field exemption and patch gate", () => {
  const workflow = readWorkflowText("release-preflight.yml");
  assert.deepEqual(extractTopLevelChildKeys(workflow, "on"), ["pull_request"]);

  const auditStep = extractStepBlock(workflow, "Audit runtime dependencies");
  assert.match(auditStep, /for attempt in 1 2 3; do/);
  assert.match(
    auditStep,
    /timeout 90s npm audit --omit=dev --fetch-retries=0 --fetch-timeout=60000/
  );
  assert.match(auditStep, /network timeout\|audit endpoint returned an error/);
  assert.match(auditStep, /exit "\$status"/);
  assert.equal(auditStep.includes("|| true"), false);

  const classifier = extractStepBlock(workflow, "Classify Changesets release pull request");
  const expectedExpression = normalizeExpression(`
    github.event_name == 'pull_request' &&
    github.event.pull_request.head.repo.full_name == github.repository &&
    startsWith(github.event.pull_request.head.ref, 'changeset-release/') &&
    github.event.pull_request.user.login == 'github-actions[bot]'
  `);
  assert.equal(normalizeExpression(extractFoldedIf(classifier)), expectedExpression);
  assert.equal(classifier.includes("github.actor"), false);
  assert.match(classifier, /^        id: release_pr$/m);

  const requireStep = extractStepBlock(
    workflow,
    "Require a patch Changeset for package behavior changes"
  );
  assert.equal(
    normalizeExpression(extractSingleLineIf(requireStep)),
    "steps.release_pr.outputs.exempt != 'true' && steps.changesets.outputs.release_impact == 'true' && steps.changesets.outputs.present != 'true'"
  );

  const validateStep = extractStepBlock(workflow, "Validate patch Changeset state");
  assert.equal(
    normalizeExpression(extractSingleLineIf(validateStep)),
    "steps.release_pr.outputs.exempt != 'true' && steps.changesets.outputs.present == 'true'"
  );
  assert.match(validateStep, /changeset -- status --since=origin\/main --output/);
  assert.match(validateStep, /@cluic\/codex-remote-proxy/);
  assert.match(validateStep, /type !== "patch"/);

  const detectStep = extractStepBlock(
    workflow,
    "Detect release-impacting and changeset files"
  );
  assert.match(
    detectStep,
    /grep -v -E '\^node\/\\\.changeset\/README\\\.md\$'/
  );
  assert.equal(detectStep.includes("grep -v 'README.md'"), false);
});

test("release workflow rejects non-patch Changesets before publication", () => {
  const workflow = readWorkflowText("release.yml");
  const validation = extractStepBlock(workflow, "Validate pending Changesets are patch-only");
  const release = extractStepBlock(workflow, "Create release PR or publish");

  assert.match(validation, /changeset -- status --output/);
  assert.match(validation, /@cluic\/codex-remote-proxy/);
  assert.match(validation, /entry\.type !== "patch"/);
  assert.match(validation, /Only patch Changesets may be published\./);
  assert.equal(workflow.indexOf(validation) < workflow.indexOf(release), true);
});

test("package versioning keeps package and lockfile root versions synchronized", () => {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "node/package.json"), "utf8"));
  const packageLock = JSON.parse(
    readFileSync(resolve(repositoryRoot, "node/package-lock.json"), "utf8")
  );

  assert.equal(packageJson.version, packageLock.version);
  assert.equal(packageJson.version, packageLock.packages[""].version);
  assert.equal(
    packageJson.scripts["version-packages"],
    "changeset version && node scripts/sync-lockfile-version.mjs"
  );
  assert.match(
    extractStepBlock(readWorkflowText("release.yml"), "Create release PR or publish"),
    /^          version: npm run version-packages$/m
  );
});

test("lockfile version sync preserves the dependency graph and is byte-idempotent", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crp-lock-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  const packageJson = { name: packageName, version: "0.4.1" };
  const packageLock = {
    name: packageName,
    version: "0.4.0",
    lockfileVersion: 3,
    packages: {
      "": { name: packageName, version: "0.4.0", dependencies: { stable: "1.0.0" } },
      "node_modules/stable": { version: "1.0.0", integrity: "sha512-stable" }
    }
  };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

  assert.deepEqual(syncLockfileVersion({ packagePath, lockPath }), {
    changed: true,
    version: "0.4.1"
  });
  const synchronizedBytes = readFileSync(lockPath);
  const synchronized = JSON.parse(synchronizedBytes);
  assert.equal(synchronized.version, "0.4.1");
  assert.equal(synchronized.packages[""].version, "0.4.1");
  assert.deepEqual(
    synchronized.packages["node_modules/stable"],
    packageLock.packages["node_modules/stable"]
  );

  assert.deepEqual(syncLockfileVersion({ packagePath, lockPath }), {
    changed: false,
    version: "0.4.1"
  });
  assert.deepEqual(readFileSync(lockPath), synchronizedBytes);
});

test("lockfile version sync fails before writing mismatched package metadata", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crp-lock-version-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  writeFileSync(packagePath, JSON.stringify({ name: packageName, version: "0.4.1" }));
  writeFileSync(lockPath, JSON.stringify({
    name: "another-package",
    version: "0.4.0",
    packages: { "": { name: "another-package", version: "0.4.0" } }
  }));
  const original = readFileSync(lockPath);

  assert.throws(
    () => syncLockfileVersion({ packagePath, lockPath }),
    /Package and lockfile root metadata do not match\./
  );
  assert.deepEqual(readFileSync(lockPath), original);
});

test("every workflow checkout disables persisted credentials", () => {
  for (const name of ["release.yml", "release-preflight.yml", "platform-tests.yml"]) {
    const checkout = extractStepBlock(readWorkflowText(name), "Checkout");
    assert.match(checkout, /^        uses: actions\/checkout@v4$/m);
    assert.match(checkout, /^          persist-credentials: false$/m);
  }
});

test("Linux native smoke proves Secret Service and the default collection before Node", () => {
  const workflow = readWorkflowText("platform-tests.yml");
  const installScript = extractStepBlock(workflow, "Install Linux Secret Service");
  const smokeScript = extractStepBlock(
    workflow,
    "Smoke test Linux native keyring through Secret Service"
  );

  assert.match(installScript, /libglib2\.0-bin/);
  assert.match(smokeScript, /HOME="\$smoke_home" dbus-run-session/);
  assert.match(smokeScript, /gdbus wait --session --timeout [0-9]+ org\.freedesktop\.secrets/);
  assert.match(smokeScript, /gdbus call --session --dest org\.freedesktop\.secrets/);
  assert.match(smokeScript, /\/org\/freedesktop\/secrets\/aliases\/default/);
  assert.match(smokeScript, /org\.freedesktop\.Secret\.Collection Label/);
  assert.equal(smokeScript.includes("gdbus") && smokeScript.includes("|| true"), false);
  assert.equal(
    smokeScript.lastIndexOf("org.freedesktop.Secret.Collection Label")
      < smokeScript.indexOf("node scripts/native-keyring-smoke.mjs"),
    true
  );
});
