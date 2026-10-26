// M0 spike gate for the Sandbox Git Migration plan.
//
// Boots a real DockerSandbox built from createDockerRepoTemplate against a tiny
// public fixture repo (octocat/Hello-World), then exercises exactly the surface
// the migration depends on: start -> read via git/exec -> writeFiles ->
// git add/commit -> destroy. The `git push` leg is intentionally NOT exercised
// here: it needs a repo-scoped credential, which is injected later by the M1
// provisioner and covered by the opt-in integration test in the plan's test
// section.
//
// Run manually on a host with Docker Desktop running:
//   SPIKE_DOCKER=1 npx vitest run src/mastra/agents/programming/tools/__tests__/sandbox-spike.test.ts
import { describe, expect, it } from 'vitest';

const enabled = process.env.SPIKE_DOCKER === '1';

describe.skipIf(!enabled)('M0 spike: @mastra/docker surface against a real container', () => {
  it(
    'boots a repo-template sandbox, reads, writes, and commits inside it',
    async () => {
      const { DockerSandbox, createDockerRepoTemplate } = await import('@mastra/docker');

      const template = createDockerRepoTemplate({
        getRepositoryAccess: async () => ({ cloneUrl: 'https://github.com/octocat/Hello-World.git' }),
        ref: 'master',
      });
      expect(template).toBeDefined();
      if (template === undefined) throw new Error('template resolver unavailable');

      const sandbox = new DockerSandbox({
        id: 'mastra-spike-m0',
        template,
      });

      try {
        await sandbox.start();

        // The checkout must be pinned at the ref head with git history present.
        const head = await sandbox.executeCommand!('sh', ['-c', 'cd /workspace/Hello-World && git rev-parse HEAD']);
        expect(head.success, head.stderr).toBe(true);
        expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

        const status = await sandbox.executeCommand!('sh', [
          '-c',
          'cd /workspace/Hello-World && git status --porcelain && git log --oneline -1',
        ]);
        expect(status.success, status.stderr).toBe(true);

        // writeFiles lands bytes on disk inside the container.
        const marker = `spike-${Date.now()}.txt`;
        const content = 'sandbox owns the code now\n';
        await sandbox.writeFiles!([{ path: `/workspace/Hello-World/${marker}`, content }]);
        const readFile = await sandbox.executeCommand!('sh', ['-c', `cat /workspace/Hello-World/${marker}`]);
        expect(readFile.stdout).toBe(content);

        // The disk manifest reader must fingerprint the landed bytes with a
        // sha256 identical to hashing the content directly — the byte-exact
        // approval guarantee the migration rests on, proven on real Docker.
        const { readManifestFromDisk } = await import('../../../../../src/mastra/agents/programming/tools/sandbox.js');
        const { createHash } = await import('node:crypto');
        const manifest = await readManifestFromDisk(sandbox, '/workspace/Hello-World', [
          { path: marker, validators: ['basic-syntax'] },
        ]);
        const entry = manifest[0];
        if (entry === undefined || 'missing' in entry) {
          throw new Error(`manifest reader reported ${marker} as missing`);
        }
        expect(entry.sha256).toBe(createHash('sha256').update(content).digest('hex'));
        expect(entry.bytes).toBe(Buffer.byteLength(content));

        // git add + commit works from the sandbox working tree.
        const commit = await sandbox.executeCommand!('sh', [
          '-c',
          `cd /workspace/Hello-World && git add -A && git -c user.email=mastra@local -c user.name=mastra commit -m "spike: ${marker}"`,
        ]);
        expect(commit.success, commit.stderr + commit.stdout).toBe(true);

        const afterCommit = await sandbox.executeCommand!('sh', ['-c', 'cd /workspace/Hello-World && git rev-parse HEAD && git status --porcelain']);
        expect(afterCommit.success, afterCommit.stderr).toBe(true);
        expect(afterCommit.stdout.trim().split('\n')[0]).toMatch(/^[0-9a-f]{40}$/);
        expect(afterCommit.stdout).not.toContain(marker); // porcelain clean after commit
      } finally {
        await sandbox.destroy();
      }
    },
    10 * 60 * 1000,
  );
});
