import type { PatchFile } from "../agents/programming/contracts.js";
import type { CheckStatus, GitHubBackend } from "../agents/programming/tools/github.js";

/**
 * In-memory `GitHubBackend` for the deterministic flow tests. It mirrors the
 * observable behaviours the flow asserts against (source SHA / branch head,
 * commit + draft-PR write counts, replay listing, checks, candidate files) so
 * the flow is exercised end to end without a socket, exactly as the retired
 * `FakeGitHubTransport` did, but speaking the single backend seam every lane now
 * uses.
 */
export class FakeGitHubBackend implements GitHubBackend {
  sourceSha: string;
  checks: CheckStatus;
  readonly commitSha: string;
  writeCalls = 0;
  commitCreates = 0;
  readonly pullRequests: Array<{ body: string; draft: boolean }> = [];
  readonly logs: string[] = [];
  files: string[] = [];
  private branchSha: string | undefined;

  constructor(config: { sourceSha: string; commitSha: string; checks: CheckStatus }) {
    this.sourceSha = config.sourceSha;
    this.commitSha = config.commitSha;
    this.checks = config.checks;
  }

  async headSha(_owner: string, _repo: string, branch: string): Promise<string> {
    this.logs.push(`headSha ${branch}`);
    return branch === "main" ? this.sourceSha : this.branchSha ?? this.sourceSha;
  }

  async branchHead(_owner: string, _repo: string, branch: string): Promise<string | undefined> {
    this.logs.push(`branchHead ${branch}`);
    return this.branchSha;
  }

  async fileContent(
    _owner: string,
    _repo: string,
    path: string,
    _refSha: string,
  ): Promise<{ content: string; sha: string }> {
    this.logs.push(`fileContent ${path}`);
    return { content: "fixture", sha: "1".repeat(40) };
  }

  async commitFiles(
    _owner: string,
    _repo: string,
    branch: string,
    _message: string,
    _baseSha: string,
    _files: PatchFile[],
  ): Promise<{ commitSha: string }> {
    this.logs.push(`commitFiles ${branch}`);
    this.writeCalls += 1;
    this.commitCreates += 1;
    this.branchSha = this.commitSha;
    return { commitSha: this.commitSha };
  }

  async openDraftPull(
    _owner: string,
    _repo: string,
    _branch: string,
    _baseBranch: string,
    _title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    this.logs.push("openDraftPull");
    this.writeCalls += 1;
    this.pullRequests.push({ body, draft: true });
    const number = this.pullRequests.length;
    return { number, url: `https://github.example/acme/widget/pull/${number}` };
  }

  async listOpenPulls(
    _owner: string,
    _repo: string,
    _branch: string,
  ): Promise<Array<{ number: number; url: string; body: string; draft: boolean }>> {
    return this.pullRequests.map((pull, index) => ({
      number: index + 1,
      url: `https://github.example/acme/widget/pull/${index + 1}`,
      body: pull.body,
      draft: pull.draft,
    }));
  }

  async checkRuns(_owner: string, _repo: string, _commitSha: string): Promise<CheckStatus> {
    return this.checks;
  }

  async listFiles(_owner: string, _repo: string, _refSha: string): Promise<string[]> {
    return this.files;
  }
}
