import type {
  AdvanceInput,
  CreateBugInput,
  CreateStoryInput,
  DeleteWorkItemInput,
  FormatBugReportInput,
  ListWorkItemsInput,
  RefreshAction,
  TapdToolFacade,
  TransitionInput,
  UpdateWorkItemInput,
  WorkflowInput,
} from "./server.js";
import type { ChromeLoginBridge } from "./session/chrome-login-bridge.js";
import { TapdSessionManager } from "./session/session-manager.js";
import {
  BugService,
  MemberService,
  formatBugReport as buildBugReport,
  StoryService,
  WorkItemResolver,
  WorkflowService,
  WorkspaceContextService,
} from "./services/index.js";

export interface TapdApplicationDependencies {
  sessions: TapdSessionManager;
  loginBridge: ChromeLoginBridge;
  contexts: WorkspaceContextService;
  resolver: WorkItemResolver;
  stories: StoryService;
  bugs: BugService;
  members: MemberService;
  workflow: WorkflowService;
}

export class TapdApplication implements TapdToolFacade {
  constructor(private readonly dependencies: TapdApplicationDependencies) {}

  sessionStatus(workspaceId: string): unknown {
    const bridgeStatus = this.dependencies.loginBridge.getStatus(workspaceId);
    return {
      ...this.dependencies.sessions.getStatus(workspaceId),
      pageOpen: bridgeStatus.pageOpen,
      cleanupPending: bridgeStatus.cleanupPending,
      browserMode: bridgeStatus.browserMode,
      captureReceived: bridgeStatus.captureReceived,
    };
  }

  async refreshSession(input: { workspaceId: string; action: RefreshAction }): Promise<unknown> {
    const { workspaceId, action } = input;
    if (action === "begin") return this.dependencies.loginBridge.begin(workspaceId);
    if (action === "cancel") {
      const status = await this.dependencies.loginBridge.cancel(workspaceId);
      if (status.state === "missing" || status.state === "expired") this.dependencies.contexts.clear(workspaceId);
      return status;
    }

    const status = await this.dependencies.loginBridge.complete(workspaceId);
    const captured = this.dependencies.sessions.requireValidContext(workspaceId);
    this.dependencies.contexts.clear(workspaceId);
    if (captured.storyContext) {
      this.dependencies.contexts.hydrateFromSession(workspaceId, "story", captured.storyContext);
    }
    if (captured.bugContext) {
      this.dependencies.contexts.hydrateFromSession(workspaceId, "bug", captured.bugContext);
    }
    return {
      ...status,
      workspaceContext: this.dependencies.contexts.getPublicSummary(workspaceId),
    };
  }

  listStories(input: ListWorkItemsInput): Promise<unknown> {
    return this.dependencies.stories.list({ ...input });
  }

  getStory(input: WorkflowInput): Promise<unknown> {
    return this.dependencies.stories.get({ workspaceId: input.workspaceId, id: input.id });
  }

  getStoryFields(workspaceId: string): Promise<unknown> {
    return this.dependencies.stories.getFields({ workspaceId });
  }

  createStory(input: CreateStoryInput): Promise<unknown> {
    return this.dependencies.stories.create({
      workspaceId: input.workspaceId,
      title: input.name,
      description: input.description,
      workItemTypeId: input.workitemTypeId,
      owner: input.owner,
      priority: input.priority,
      categoryId: input.categoryId,
      fields: input.fields,
      imagePaths: input.imagePaths,
    });
  }

  updateStory(input: UpdateWorkItemInput): Promise<unknown> {
    return this.dependencies.stories.updateFields(input);
  }

  deleteStory(input: DeleteWorkItemInput): Promise<unknown> {
    return this.dependencies.stories.delete({
      workspaceId: input.workspaceId,
      id: input.id,
      confirm: input.confirm,
    });
  }

  listBugs(input: ListWorkItemsInput): Promise<unknown> {
    return this.dependencies.bugs.list({ ...input });
  }

  getBug(input: WorkflowInput): Promise<unknown> {
    return this.dependencies.bugs.get({ workspaceId: input.workspaceId, id: input.id });
  }

  getBugFields(workspaceId: string): Promise<unknown> {
    return this.dependencies.bugs.getFields({ workspaceId });
  }

  searchMembers(input: { workspaceId: string; keyword: string }): Promise<unknown> {
    return this.dependencies.members.search(input);
  }

  formatBugReport(input: FormatBugReportInput): string {
    if (input.singleIssueConfirmed !== true) {
      throw new TypeError("single_issue_confirmed must be true after splitting unrelated problems.");
    }
    return buildBugReport({
      rawDescription: input.description,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      productVersion: input.productVersion,
      device: input.device,
      operatingSystem: input.operatingSystem,
      client: input.clientName,
      account: input.account,
      reproductionProbability: input.reproductionProbability,
      attachmentEvidence: input.attachmentEvidence,
      classification: input.classification,
    }).markdown;
  }

  createBug(input: CreateBugInput): Promise<unknown> {
    return this.dependencies.bugs.create({
      workspaceId: input.workspaceId,
      title: input.title,
      singleIssueConfirmed: input.singleIssueConfirmed,
      description: input.description,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      productVersion: input.productVersion,
      device: input.device,
      operatingSystem: input.operatingSystem,
      clientName: input.clientName,
      account: input.account,
      reproductionProbability: input.reproductionProbability,
      attachmentEvidence: input.attachmentEvidence,
      classification: input.classification,
      iterationId: input.iterationId,
      owner: input.owner,
      fields: input.fields,
      imagePaths: input.imagePaths,
    });
  }

  updateBug(input: UpdateWorkItemInput): Promise<unknown> {
    return this.dependencies.bugs.updateFields(input);
  }

  deleteBug(input: DeleteWorkItemInput): Promise<unknown> {
    return this.dependencies.bugs.delete({
      workspaceId: input.workspaceId,
      id: input.id,
      confirm: input.confirm,
    });
  }

  resolveWorkItem(input: WorkflowInput): Promise<unknown> {
    return this.dependencies.resolver.resolve(input);
  }

  getTransitions(input: WorkflowInput): Promise<unknown> {
    return this.dependencies.workflow.getTransitions(input);
  }

  transition(input: TransitionInput): Promise<unknown> {
    return this.dependencies.workflow.transition(input);
  }

  advance(input: AdvanceInput): Promise<unknown> {
    return this.dependencies.workflow.advanceToNextStep(input);
  }

  addComment(input: WorkflowInput & { comment: string; mentions?: import("./services/mentions.js").TapdMention[] }): Promise<unknown> {
    return this.dependencies.workflow.addComment(input);
  }
}
