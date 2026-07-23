import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTapdConfig, requireWorkspaceId } from "../src/config.js";
import { createTapdRuntime } from "../src/index.js";
import { sanitizeTapdOutput } from "../src/security/index.js";
import type {
  EntityType,
  FieldConfigurationResult,
  TransitionListResult,
  TransitionOption,
  WorkItemResult,
} from "../src/private-api/contracts.js";

const enabled = process.env.TAPD_E2E === "1";
const authorisedE2eWorkspaceId = "56450277";
const residualScanPages = 5;
const residualScanPageSize = 100;

type TapdRuntime = ReturnType<typeof createTapdRuntime>;

interface OwnedWorkItem {
  entityType: EntityType;
  id: string;
  title: string;
}

test(
  "controlled login and Story/Bug CRUD probes in the hard-locked test2 TAPD workspace",
  {
    skip: enabled
      ? false
      : "Set TAPD_E2E=1 and TAPD_E2E_WORKSPACE_ID=56450277 to run the real TAPD probe.",
    timeout: 300_000,
  },
  async () => {
    const workspaceId = requireWorkspaceId(process.env.TAPD_E2E_WORKSPACE_ID ?? "");
    assert.equal(workspaceId, authorisedE2eWorkspaceId, "Real TAPD E2E is authorised only for the test2 workspace.");
    const runtime = createTapdRuntime(loadTapdConfig(process.env));
    const prefix = `[tapd-mcp-e2e:${randomUUID()}]`;
    const storyTitle = `${prefix} Story`;
    const updatedStoryTitle = `${prefix} Story updated`;
    const bugTitle = `${prefix} Bug`;
    const updatedBugTitle = `${prefix} Bug updated`;
    const storyMarkdown = `## 验收标准\n\n1. ${prefix} Markdown source is preserved`;
    const imageDirectory = await mkdtemp(join(tmpdir(), "tapd-mcp-e2e-image-"));
    const imagePath = join(imageDirectory, "evidence.gif");
    await writeFile(imagePath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
    let story: OwnedWorkItem | undefined;
    let bug: OwnedWorkItem | undefined;
    let submittedStoryMarkdown: string | undefined;
    let storyCreateAttempted = false;
    let bugCreateAttempted = false;
    let storyDeleted = false;
    let bugDeleted = false;
    const failures: unknown[] = [];

    try {
      const session = await runtime.application.refreshSession({ workspaceId, action: "begin" });
      process.stderr.write(`TAPD E2E Chrome DevTools refresh: ${JSON.stringify(sanitizeTapdOutput(session))}\n`);
      await runtime.application.refreshSession({ workspaceId, action: "complete" });

      const [storyFields, bugFields] = await Promise.all([
        runtime.stories.getFields({ workspaceId }),
        runtime.bugs.getFields({ workspaceId }),
      ]);
      assertFieldConfiguration(storyFields, workspaceId, "story");
      assertFieldConfiguration(bugFields, workspaceId, "bug");

      storyCreateAttempted = true;
      const createdStory = await runtime.stories.create({
        workspaceId,
        title: storyTitle,
        description: storyMarkdown,
        imagePaths: [imagePath],
      });
      story = { entityType: "story", id: createdStory.workItem.id, title: storyTitle };
      submittedStoryMarkdown = createdStory.workItem.markdownDescription;
      assert.match(submittedStoryMarkdown ?? "", new RegExp(escapeRegExp(storyMarkdown)));
      assert.match(submittedStoryMarkdown ?? "", /!\[附件证据 1\]\(\/tfl\/captures\//);
      story = await proveCreatedOwnership(
        runtime,
        workspaceId,
        "story",
        createdStory.workItem.id,
        createdStory.workItem.shortId,
        storyTitle,
      );
      assert.equal(
        (await runtime.stories.get({ workspaceId, id: story.id })).markdownDescription,
        submittedStoryMarkdown,
        "Story GET must preserve the exact submitted Markdown source.",
      );

      await runtime.stories.updateFields({ workspaceId, id: story.id, fields: { name: updatedStoryTitle } });
      story = { ...story, title: updatedStoryTitle };
      await assertOwnedByGet(runtime, workspaceId, story);

      await verifyWorkflowCapability(runtime, workspaceId, story);
      const storyComment = `${prefix} Story complete`;
      const storyCommentResult = await runtime.workflow.addComment({
        workspaceId,
        entityType: "story",
        id: story.id,
        comment: storyComment,
      });
      assert.equal(storyCommentResult.comments.some((comment) => comment.plainText === storyComment), true);

      await deleteAfterOwnershipProof(runtime, workspaceId, story);
      storyDeleted = true;

      bugCreateAttempted = true;
      const createdBug = await runtime.bugs.create({
        workspaceId,
        title: bugTitle,
        singleIssueConfirmed: true,
        expectedResult: "点击保存后应保存成功并返回详情页，内容与产品需求一致",
        actualResult: "点击保存后接口返回 HTTP 500，页面停留在编辑状态",
        reproductionSteps: ["登录 test2 测试账号", "进入测试工单编辑页并修改标题", "点击保存按钮"],
        productVersion: "tapd-mcp-e2e",
        device: "Mac",
        operatingSystem: "macOS",
        clientName: "Chrome",
        account: "test2",
        reproductionProbability: "1/1，必现",
      });
      bug = { entityType: "bug", id: createdBug.workItem.id, title: bugTitle };
      assert.match(createdBug.submittedMarkdown ?? "", /^## 基础环境/);
      assert.match(createdBug.submittedMarkdown ?? "", /## 附件证据\n\n【待补充截图证据】/);
      bug = await proveCreatedOwnership(
        runtime,
        workspaceId,
        "bug",
        createdBug.workItem.id,
        createdBug.workItem.shortId,
        bugTitle,
      );
      assert.equal(
        (await runtime.bugs.get({ workspaceId, id: bug.id })).markdownDescription,
        createdBug.submittedMarkdown,
        "Bug GET must preserve the mandatory submitted Markdown source.",
      );

      await runtime.bugs.updateFields({ workspaceId, id: bug.id, fields: { name: updatedBugTitle } });
      bug = { ...bug, title: updatedBugTitle };
      await assertOwnedByGet(runtime, workspaceId, bug);

      await verifyWorkflowCapability(runtime, workspaceId, bug);
      const bugComment = `${prefix} Bug complete`;
      const bugCommentResult = await runtime.workflow.addComment({
        workspaceId,
        entityType: "bug",
        id: bug.id,
        comment: bugComment,
      });
      assert.equal(bugCommentResult.comments.some((comment) => comment.plainText === bugComment), true);

      await deleteAfterOwnershipProof(runtime, workspaceId, bug);
      bugDeleted = true;
    } catch (error) {
      recordFailure(failures, "probe", error);
    } finally {
      if (story && !storyDeleted) {
        try {
          await deleteAfterOwnershipProof(runtime, workspaceId, story);
          storyDeleted = true;
        } catch (error) {
          recordFailure(failures, "story_cleanup", error);
        }
      }
      if (bug && !bugDeleted) {
        try {
          await deleteAfterOwnershipProof(runtime, workspaceId, bug);
          bugDeleted = true;
        } catch (error) {
          recordFailure(failures, "bug_cleanup", error);
        }
      }

      if (storyCreateAttempted || bugCreateAttempted) {
        try {
          const residuals = await findExactPrefixResiduals(runtime, workspaceId, prefix);
          if (residuals.length > 0) {
            const provenIds = new Set([story?.id, bug?.id].filter((id): id is string => id !== undefined));
            const unknownCreateResiduals = residuals.filter((item) => !provenIds.has(item.id));
            const knownIdResiduals = residuals.filter((item) => provenIds.has(item.id));
            if (unknownCreateResiduals.length > 0) {
              recordFailure(failures, "residual_scan", new Error(
                `TAPD E2E found unknown-create leftovers and intentionally did not delete them because GET ownership was never proven: ${summarizeResiduals(unknownCreateResiduals)}`,
              ));
            }
            if (knownIdResiduals.length > 0) {
              recordFailure(failures, "residual_scan", new Error(
                `TAPD E2E found known-ID leftovers after verified cleanup attempts: ${summarizeResiduals(knownIdResiduals)}`,
              ));
            }
          }
        } catch (error) {
          recordFailure(failures, "residual_scan", error);
        }
      }

      try {
        await runtime.loginBridge.close();
      } catch (error) {
        recordFailure(failures, "login_bridge_cleanup", error);
      }
      await rm(imageDirectory, { recursive: true, force: true });
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "TAPD E2E execution or cleanup did not fully succeed.");
    }
  },
);

function assertFieldConfiguration(
  configuration: FieldConfigurationResult,
  workspaceId: string,
  entityType: EntityType,
): void {
  assert.deepEqual(
    { workspaceId: configuration.workspaceId, entityType: configuration.entityType },
    { workspaceId, entityType },
  );
  assert.ok(configuration.fields.length > 0, `${entityType} field metadata must not be empty.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function proveCreatedOwnership(
  runtime: TapdRuntime,
  workspaceId: string,
  entityType: EntityType,
  candidateId: string,
  candidateShortId: string | undefined,
  exactTitle: string,
): Promise<OwnedWorkItem> {
  const expected = { entityType, id: candidateId, title: exactTitle } satisfies OwnedWorkItem;
  const verified = await assertOwnedByGet(runtime, workspaceId, expected);
  const advertisedShortIds = new Set(
    [candidateShortId, verified.shortId].filter((id): id is string => id !== undefined),
  );
  for (const shortId of advertisedShortIds) {
    const resolved = await runtime.resolver.resolve({ workspaceId, entityType, id: shortId });
    assert.deepEqual(
      {
        workspaceId: resolved.workspaceId,
        entityType: resolved.entityType,
        id: resolved.id,
        title: resolved.title,
      },
      { workspaceId, entityType, id: candidateId, title: exactTitle },
      "The short ID advertised by TAPD must resolve back to the exact verified full ID.",
    );
  }
  return expected;
}

async function assertOwnedByGet(
  runtime: TapdRuntime,
  workspaceId: string,
  expected: OwnedWorkItem,
): Promise<WorkItemResult> {
  const item = expected.entityType === "story"
    ? await runtime.stories.get({ workspaceId, id: expected.id })
    : await runtime.bugs.get({ workspaceId, id: expected.id });
  assert.equal(item.id, expected.id, "GET must return the exact created full ID before the item is treated as owned.");
  assert.deepEqual(
    { workspaceId: item.workspaceId, entityType: item.entityType, title: item.title },
    { workspaceId, entityType: expected.entityType, title: expected.title },
    "GET must prove the exact workspace, entity type, and title before any further mutation.",
  );
  return item;
}

async function deleteAfterOwnershipProof(
  runtime: TapdRuntime,
  workspaceId: string,
  owned: OwnedWorkItem,
): Promise<void> {
  await assertOwnedByGet(runtime, workspaceId, owned);
  if (owned.entityType === "story") {
    await runtime.stories.delete({ workspaceId, id: owned.id, confirm: true });
  } else {
    await runtime.bugs.delete({ workspaceId, id: owned.id, confirm: true });
  }
}

async function verifyWorkflowCapability(
  runtime: TapdRuntime,
  workspaceId: string,
  owned: OwnedWorkItem,
): Promise<void> {
  const currentItem = await assertOwnedByGet(runtime, workspaceId, owned);
  const metadata = await runtime.workflow.getTransitions({
    workspaceId,
    entityType: owned.entityType,
    id: owned.id,
  });
  assertWorkflowMetadata(metadata, workspaceId, owned, currentItem.status);
  const transition = metadata.transitions.find((candidate) => isSafeE2eTransition(candidate, metadata));
  assert.ok(
    transition,
    `TAPD E2E capability gap: ${owned.entityType} exposes no safe explicit non-self transition without required fields from status ${metadata.currentStatus}; transition behavior was not verified.`,
  );

  const changed = await runtime.workflow.transition({
    workspaceId,
    entityType: owned.entityType,
    id: owned.id,
    targetStatus: transition.toStatus,
    transitionFields: {},
  });
  assert.deepEqual(
    {
      workspaceId: changed.workspaceId,
      entityType: changed.entityType,
      id: changed.id,
      previousStatus: changed.previousStatus,
      status: changed.status,
    },
    {
      workspaceId,
      entityType: owned.entityType,
      id: owned.id,
      previousStatus: metadata.currentStatus,
      status: transition.toStatus,
    },
  );
  const verified = await assertOwnedByGet(runtime, workspaceId, owned);
  assert.equal(verified.status, transition.toStatus, "GET must confirm the explicitly selected workflow target status.");
  process.stderr.write(
    `TAPD E2E: ${owned.entityType} explicit safe transition ${metadata.currentStatus} -> ${transition.toStatus} executed and verified.\n`,
  );
}

function assertWorkflowMetadata(
  metadata: TransitionListResult,
  workspaceId: string,
  owned: OwnedWorkItem,
  currentStatus: string,
): void {
  assert.deepEqual(
    {
      workspaceId: metadata.workspaceId,
      entityType: metadata.entityType,
      id: metadata.id,
      currentStatus: metadata.currentStatus,
    },
    { workspaceId, entityType: owned.entityType, id: owned.id, currentStatus },
  );
}

function isSafeE2eTransition(transition: TransitionOption, metadata: TransitionListResult): boolean {
  if (transition.fromStatus !== metadata.currentStatus || transition.toStatus === metadata.currentStatus) return false;
  if (transition.fields.some((field) => field.required)) return false;
  const description = [
    transition.toStatus,
    transition.toStatusName,
    transition.name,
    metadata.statusAliases[transition.toStatus],
  ].filter((part): part is string => Boolean(part)).join(" ");
  return !/(?:rejected|suspend|hang|pause|reopen|rollback|reject|cancel|delete|archive|挂起|拒绝|驳回|重新打开|回退|撤销|取消|删除|归档)/i.test(description);
}

async function findExactPrefixResiduals(
  runtime: TapdRuntime,
  workspaceId: string,
  prefix: string,
): Promise<WorkItemResult[]> {
  const residuals = new Map<string, WorkItemResult>();
  for (const entityType of ["story", "bug"] as const) {
    for (let page = 1; page <= residualScanPages; page += 1) {
      const result = entityType === "story"
        ? await runtime.stories.list({
            workspaceId,
            page,
            perPage: residualScanPageSize,
            sortName: "id",
            order: "desc",
            filters: {},
          })
        : await runtime.bugs.list({
            workspaceId,
            page,
            perPage: residualScanPageSize,
            sortName: "id",
            order: "desc",
            filters: {},
          });
      assert.deepEqual(
        { workspaceId: result.workspaceId, entityType: result.entityType },
        { workspaceId, entityType },
      );
      for (const item of result.items) {
        if (hasExactRunPrefix(item.title, prefix)) residuals.set(`${item.entityType}:${item.id}`, item);
      }
      if (result.items.length < residualScanPageSize) break;
    }
  }
  return [...residuals.values()];
}

function hasExactRunPrefix(title: string, prefix: string): boolean {
  return title.startsWith(`${prefix} `);
}

function summarizeResiduals(items: readonly WorkItemResult[]): string {
  return JSON.stringify(items.map((item) => ({
    workspaceId: item.workspaceId,
    entityType: item.entityType,
    id: item.id,
    title: item.title,
  })));
}

function recordFailure(failures: unknown[], phase: string, error: unknown): void {
  failures.push(error);
  const candidate = error && typeof error === "object"
    ? error as { name?: unknown; message?: unknown; code?: unknown; details?: unknown }
    : undefined;
  const details = candidate?.details && typeof candidate.details === "object"
    ? candidate.details as Record<string, unknown>
    : undefined;
  const diagnostic = sanitizeTapdOutput({
    phase,
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    code: typeof candidate?.code === "string" ? candidate.code : undefined,
    message: typeof candidate?.message === "string" ? candidate.message : "TAPD E2E operation failed.",
    details: details
      ? {
          endpoint: typeof details.endpoint === "string" ? details.endpoint : undefined,
          reason: typeof details.reason === "string" ? details.reason : undefined,
          httpStatus: typeof details.httpStatus === "number" ? details.httpStatus : undefined,
          responseShape: typeof details.responseShape === "string" ? details.responseShape : undefined,
        }
      : undefined,
  });
  process.stderr.write(`TAPD E2E failure: ${JSON.stringify(diagnostic)}\n`);
}
