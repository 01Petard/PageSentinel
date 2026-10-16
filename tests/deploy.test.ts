import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pagesentinel-deploy-")),
  );
  const project = join(directory, "project with spaces"),
    bin = join(directory, "bin"),
    log = join(directory, "commands.jsonl");
  mkdirSync(project);
  mkdirSync(bin);
  mkdirSync(join(project, "data"));
  copyFileSync(
    new URL("../deploy.sh", import.meta.url),
    join(project, "deploy.sh"),
  );
  writeFileSync(join(project, "compose.yaml"), "services: {}\n");
  writeFileSync(join(project, ".env"), "NTFY_TOKEN=test-only-keep-this\n");
  writeFileSync(join(project, "data", "preserved"), "existing-monitor-data");
  const command = join(bin, "command.cjs");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2);
const previous = fs.existsSync(process.env.DEPLOY_TEST_LOG)
  ? fs.readFileSync(process.env.DEPLOY_TEST_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify({tool, args, cwd:process.cwd()})+'\\n');
if (tool === 'docker') {
  if (args.includes('build') && process.env.DEPLOY_TEST_FAILURE === 'build') process.exit(1);
  if (args.includes('up') && process.env.DEPLOY_TEST_FAILURE === 'up') process.exit(1);
} else if (tool === 'curl') {
  if (process.env.DEPLOY_TEST_FAILURE === 'health' || !previous.some(x => x.tool === 'curl')) process.exit(7);
  process.stdout.write('{"status":"ok","ntfyConfigured":true}');
}
`,
    { mode: 0o755 },
  );
  for (const name of ["docker", "curl", "sleep"])
    symlinkSync(command, join(bin, name));
  return {
    project,
    run(failure = "") {
      return spawnSync("sh", [join(project, "deploy.sh")], {
        cwd: directory,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEPLOY_TEST_LOG: log,
          DEPLOY_TEST_FAILURE: failure,
        },
      });
    },
    commands(): { tool: string; args: string[]; cwd: string }[] {
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("deployment works from another directory, waits for readiness and preserves local data and configuration", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /部署完成/);
    const commands = f.commands();
    assert.ok(
      commands.findIndex((c) => c.args.includes("build")) <
        commands.findIndex((c) => c.args.includes("up")),
    );
    assert.equal(commands.filter((c) => c.tool === "curl").length, 2);
    const up = commands.find((c) => c.args.includes("up"))!;
    assert.equal(up.cwd, f.project);
    assert.ok(up.args.includes(join(f.project, "compose.yaml")));
    assert.ok(up.args.includes("--no-build"));
    assert.ok(
      !commands.some(
        (c) => c.args.includes("down") || c.args.includes("prune"),
      ),
    );
    assert.equal(
      readFileSync(join(f.project, ".env"), "utf8"),
      "NTFY_TOKEN=test-only-keep-this\n",
    );
    assert.equal(
      readFileSync(join(f.project, "data", "preserved"), "utf8"),
      "existing-monitor-data",
    );
    assert.ok(!existsSync(join(f.project, ".deploy-lock")));
  } finally {
    f.close();
  }
});

test("failed builds do not replace the deployed service and release the deployment lock", () => {
  const f = fixture();
  try {
    const result = f.run("build");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /未替换运行中的服务/);
    assert.ok(!f.commands().some((c) => c.args.includes("up")));
    assert.ok(!existsSync(join(f.project, ".deploy-lock")));
    assert.equal(f.run().status, 0);
  } finally {
    f.close();
  }
});

test("container startup and health check failures return failure instead of reporting deployment success", () => {
  for (const failure of ["up", "health"]) {
    const f = fixture();
    try {
      const result = f.run(failure);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /部署完成/);
      assert.match(result.stderr, /docker compose logs/);
      assert.ok(!existsSync(join(f.project, ".deploy-lock")));
    } finally {
      f.close();
    }
  }
});

test("a concurrent deployment cannot remove the active deployment's lock or replace its container", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.project, ".deploy-lock"));
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已有部署正在执行/);
    assert.ok(existsSync(join(f.project, ".deploy-lock")));
    assert.ok(
      !f
        .commands()
        .some((c) => c.args.includes("build") || c.args.includes("up")),
    );
  } finally {
    f.close();
  }
});
