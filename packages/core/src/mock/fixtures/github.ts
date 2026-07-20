/**
 * GitHub webhook fixtures. Event keys are in the form `<resource>.<action>`.
 * The `<resource>` is what GitHub sends in the `x-github-event` header.
 */
export const githubFixtures: Record<string, unknown> = {
  "pull_request.opened": {
    action: "opened",
    number: 42,
    pull_request: {
      id: 1,
      number: 42,
      state: "open",
      title: "Add webhook handler",
      user: { login: "octocat", id: 1, type: "User" },
      body: "This PR adds a webhook handler.",
      head: { ref: "feature-branch", sha: "abc123" },
      base: { ref: "main", sha: "def456" },
      created_at: "2026-01-01T00:00:00Z",
    },
    repository: {
      id: 1,
      name: "test-repo",
      full_name: "octocat/test-repo",
      private: false,
      owner: { login: "octocat", id: 1, type: "User" },
    },
    sender: { login: "octocat", id: 1, type: "User" },
  },

  "push.created": {
    ref: "refs/heads/main",
    before: "0000000000000000000000000000000000000000",
    after: "abc123def456",
    repository: {
      id: 1,
      name: "test-repo",
      full_name: "octocat/test-repo",
      owner: { login: "octocat", id: 1 },
    },
    pusher: { name: "octocat", email: "octocat@example.com" },
    commits: [
      {
        id: "abc123",
        message: "Initial commit",
        author: { name: "octocat", email: "octocat@example.com" },
      },
    ],
    sender: { login: "octocat", id: 1, type: "User" },
  },

  "issues.opened": {
    action: "opened",
    issue: {
      id: 1,
      number: 1,
      title: "Bug: something is broken",
      state: "open",
      user: { login: "octocat", id: 1 },
      body: "Steps to reproduce: ...",
    },
    repository: {
      id: 1,
      name: "test-repo",
      full_name: "octocat/test-repo",
      owner: { login: "octocat", id: 1 },
    },
    sender: { login: "octocat", id: 1, type: "User" },
  },
};
