#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { TapdApplication } from "./application.js";
import { loadTapdConfig, type TapdConfig } from "./config.js";
import { PrivateHttpClient } from "./private-api/index.js";
import { sanitizeTapdOutput } from "./security/index.js";
import { createTapdServer } from "./server.js";
import { loadUserBusinessPrompt } from "./user-business-prompt.js";
import {
  ChromeDevToolsSessionCapturer,
  ChromeDevToolsLoginBridge,
  JsonSessionStore,
  TapdSessionManager,
} from "./session/index.js";
import {
  BugService,
  MemberService,
  StoryService,
  WorkItemResolver,
  WorkflowService,
  WorkspaceContextService,
} from "./services/index.js";

export function createTapdRuntime(config: TapdConfig = loadTapdConfig()) {
  const contexts = new WorkspaceContextService();
  const sessionStore = new JsonSessionStore(config.sessionStorePath);
  const sessions = new TapdSessionManager({
    requestOrigin: `${config.webBaseUrl}/`,
    onSessionChanged: (_workspaceId, context) => {
      if (context) sessionStore.save(context);
      else sessionStore.remove(_workspaceId);
    },
  });
  for (const storedSession of sessionStore.load()) {
    const workspaceId = storedSession.workspaceId ?? "";
    sessions.completeLogin(workspaceId, storedSession);
    const restored = sessions.requireValidContext(workspaceId);
    if (restored.storyContext) contexts.hydrateFromSession(workspaceId, "story", restored.storyContext);
    if (restored.bugContext) contexts.hydrateFromSession(workspaceId, "bug", restored.bugContext);
  }
  const browser = new ChromeDevToolsSessionCapturer({
    requestTimeoutMs: config.requestTimeoutMs,
    userDataDir: config.chromeUserDataDir,
  });
  const loginBridge = new ChromeDevToolsLoginBridge({
    sessionManager: sessions,
    browser,
  });
  const privateClient = new PrivateHttpClient(sessions, fetch, {
    timeoutMs: config.requestTimeoutMs,
    maxRequestsPerMinute: config.maxRequestsPerMinute,
  });
  const resolver = new WorkItemResolver(privateClient);
  const stories = new StoryService(privateClient, contexts, resolver);
  const bugs = new BugService(privateClient, contexts, resolver);
  const members = new MemberService(privateClient);
  const workflow = new WorkflowService(privateClient, resolver);
  const application = new TapdApplication({ sessions, loginBridge, contexts, resolver, stories, bugs, members, workflow });
  const server = createTapdServer(application, {
    userBusinessPrompt: loadUserBusinessPrompt(config.userPromptPath),
  });

  return { server, application, sessions, loginBridge, browser, sessionStore, contexts, privateClient, resolver, stories, bugs, members, workflow };
}

async function main(): Promise<void> {
  const runtime = createTapdRuntime();
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        let bridgeFailure: unknown;
        try {
          await runtime.loginBridge.close();
        } catch (error) {
          bridgeFailure = error;
        } finally {
          await runtime.server.close();
        }
        if (bridgeFailure) throw bridgeFailure;
      })();
    }
    return closing;
  };

  const shutdown = () => void close()
    .catch((error: unknown) => {
      console.error(`tapd-mcp cleanup failed: ${safeStartupError(error)}`);
      process.exitCode = 1;
    });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  await runtime.server.connect(transport);
}

function safeStartupError(error: unknown): string {
  const payload = error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
  return JSON.stringify(sanitizeTapdOutput(payload));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`tapd-mcp failed to start: ${safeStartupError(error)}`);
    process.exitCode = 1;
  });
}
