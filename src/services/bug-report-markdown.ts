import { InvalidArgumentError } from "../private-api/errors.js";
import { redactSensitive } from "../security/index.js";

export const MISSING_VALUE = "【待补充】";
export const MISSING_SCREENSHOT_EVIDENCE = "【待补充截图证据】";

export type BugClassification = "bug" | "non_defect";

export interface BugReportInput {
  rawDescription?: string;
  expectedResult?: string;
  actualResult?: string;
  reproductionSteps?: readonly string[];
  productVersion?: string;
  device?: string;
  operatingSystem?: string;
  client?: string;
  account?: string;
  reproductionProbability?: string;
  attachmentEvidence?: readonly string[];
  classification?: BugClassification;
}

export interface FormattedBugReport {
  readonly markdown: string;
  readonly missingInformation: readonly string[];
  readonly classification: BugClassification;
}

const VAGUE_DESCRIPTION = /(?:有点卡|很卡|卡顿|很慢|较慢|速度慢|反应慢|偶尔|有时|间歇性|报错|失败|异常|错乱|不好用|不太好用|有问题|不正常|不对劲|不行|用不了|操作不了|感觉很慢|好像|貌似)/;
const OBJECTIVE_SIGNAL = /(?:\d|错误码|报错信息|崩溃|闪退|白屏|黑屏|错位|重叠|遮挡|无法|不能|未显示|未响应|没有响应|无响应|未生效|无变化|消失|重复|跳转|返回|提示(?:为|“|\")|超时|仍为|保持为|与.+不一致)/;
const VAGUE_EXPECTED_RESULT = /(?:(?:应该|应当|需要|希望|期望|预期)\s*)?(?:正常|正确|可用|没问题|符合预期|正常运行|功能正常|显示正常|操作正常)/u;
const EXPECTED_DETAIL_SIGNAL = /(?:(?:显示|呈现).{2,}|(?:跳转|进入|返回)(?:到|至).{2,}|(?:保存|创建|更新|提交)成功|(?:状态|数量|内容|字段|数据).{0,8}(?:为|等于|保持|一致)|(?:产品需求|原型|UI\s*设计).{0,12}(?:一致|相符)|(?:不应|不会|禁止).{2,}|\d+(?:ms|毫秒|秒|分钟|%|条|个))/iu;
const VAGUE_REPRODUCTION_STEP = /(?:操作一下|点击一下|进入页面|打开页面|进行操作|正常操作|按流程操作|复现问题|查看结果|随便操作|登录后操作|重现问题)/u;
const REPRODUCTION_ACTION = /(?:打开|进入|访问|登录|启动|安装|连接|选择|勾选|输入|填写|上传|点击|长按|拖拽|滚动|切换|搜索|新增|编辑|删除|提交|保存|刷新|返回|取消|关闭|调用|发送|等待|观察|查看|确认)/u;
const ISSUE_SIGNAL = /(?:报错|错误|失败|异常|崩溃|闪退|白屏|黑屏|卡顿|错位|重叠|遮挡|无法|不能|未显示|未响应|没有响应|无响应|未生效|丢失|消失|重复|超时|乱码|不一致)/u;
const NON_DEFECT_SIGNAL = /(?:需求|原型|UI\s*设计).{0,12}(?:未设计|没有设计|未定义)|(?:新增|增加|补充).{0,12}(?:功能|样式|交互)|(?:体验|样式|交互).{0,8}优化/iu;

export function formatBugReport(input: BugReportInput): FormattedBugReport {
  const raw = optionalText(input.rawDescription, "description", 200_000) ?? "";
  const explicitActual = optionalText(input.actualResult, "actual_result", 200_000);
  const explicitSteps = (input.reproductionSteps ?? []).map((step, index) =>
    optionalText(step, `reproduction_steps.${index}`, 20_000),
  ).filter((step): step is string => Boolean(step));
  const issueSource = [...new Set([raw, explicitActual, ...explicitSteps].filter(Boolean))].join("\n");
  if (containsMultipleIndependentIssues(issueSource)) {
    throw new InvalidArgumentError(
      "description",
      "The description contains multiple apparent problems. Split it into separate Bug tool calls; one TAPD Bug may contain only one problem.",
    );
  }
  const missing: string[] = [];
  const classification = input.classification ?? (NON_DEFECT_SIGNAL.test(raw) ? "non_defect" : "bug");

  const environment = [
    environmentField("产品版本", input.productVersion, raw, ["产品版本", "版本"]),
    environmentField("设备", input.device, raw, ["设备", "机型"]),
    environmentField("系统", input.operatingSystem, raw, ["操作系统", "系统", "OS"]),
    environmentField("客户端/浏览器", input.client, raw, ["客户端", "浏览器"]),
    environmentField("操作账号", input.account, raw, ["操作账号", "测试账号", "账号"]),
    environmentField("复现概率", input.reproductionProbability, raw, ["复现概率", "重现概率", "复现频率"]),
  ].filter((field): field is readonly [string, string] => field !== undefined);

  const suppliedSteps = (input.reproductionSteps ? explicitSteps : extractNumberedSteps(raw))
    .map((step) => step.replace(/^\s*\d+[.)、]\s*/, "").trim());
  const steps = suppliedSteps.slice(0, 20).map((step, index) => {
    if (!isPreciseReproductionStep(step)) {
      missing.push(`复现步骤 ${index + 1}（需补充精准操作）`);
      return MISSING_VALUE;
    }
    return step;
  });
  while (steps.length < 3) {
    steps.push(MISSING_VALUE);
    missing.push(`复现步骤 ${steps.length}`);
  }

  const expected = resultValue(
    input.expectedResult ?? extractLabeledValue(raw, ["预期结果", "期望结果"]),
    "预期结果",
    missing,
    "expected",
  );
  const actualCandidate = explicitActual
    ?? extractLabeledValue(raw, ["实际结果", "实际现象", "异常现象"])
    ?? rawWithoutKnownLabels(raw);
  const actual = resultValue(actualCandidate, "实际结果", missing, "actual");

  const evidence = [...(input.attachmentEvidence ?? []), ...extractEvidenceReferences(raw)]
    .map((item, index) => optionalText(item, `attachment_evidence.${index}`, 20_000))
    .filter((item): item is string => Boolean(item))
    .filter(hasConcreteEvidenceReference)
    .filter((item, index, items) => items.indexOf(item) === index);
  if (!evidence.length) missing.push("截图/录屏证据");

  const prefix = classification === "non_defect"
    ? "> 【非缺陷，建议提交需求单】\n\n"
    : "";
  const supplementaryMaterial = raw && hasStructuredBugDetails(input, explicitActual, explicitSteps)
    ? `## 补充材料\n\n${raw}`
    : undefined;
  const sections = [
    environment.length
      ? `## 基础环境\n\n${environment.map(([label, value]) => `- ${label}：${value}`).join("\n")}`
      : undefined,
    `## 复现步骤\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    `## 预期结果\n\n${expected}`,
    `## 实际结果\n\n${actual}`,
    supplementaryMaterial,
    `## 附件证据\n\n${evidence.length ? evidence.join("\n\n") : MISSING_SCREENSHOT_EVIDENCE}`,
  ].filter((section): section is string => section !== undefined);
  const markdown = `${prefix}${sections.join("\n\n")}`;

  return { markdown, missingInformation: [...new Set(missing)], classification };
}

function environmentField(
  label: string,
  explicit: string | undefined,
  raw: string,
  labels: readonly string[],
): readonly [string, string] | undefined {
  const value = optionalText(explicit, label, 20_000) ?? extractLabeledValue(raw, labels);
  return value ? [label, value] : undefined;
}

function resultValue(
  value: string | undefined,
  label: string,
  missing: string[],
  kind: "expected" | "actual",
): string {
  const normalized = optionalText(value, label, 200_000);
  const vague = kind === "expected"
    ? Boolean(normalized && VAGUE_EXPECTED_RESULT.test(normalized) && !EXPECTED_DETAIL_SIGNAL.test(normalized))
    : Boolean(normalized && (
        isEvidenceOnlyText(normalized)
        || (VAGUE_DESCRIPTION.test(normalized) && !OBJECTIVE_SIGNAL.test(normalized))
      ));
  if (!normalized || vague) {
    missing.push(kind === "actual"
      ? `${label}（需补充客观、可量化现象）`
      : `${label}（需对照需求、原型或 UI 明确正常标准）`);
    return MISSING_VALUE;
  }
  return normalized;
}

function isPreciseReproductionStep(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 4 || VAGUE_REPRODUCTION_STEP.test(normalized)) return false;
  if (/^(?:点击|打开|进入|选择|填写|输入|提交|保存|操作|查看|刷新|切换)(?:一下|页面|按钮|内容|数据|功能|选项)?[。.!！?？]*$/u.test(normalized)) {
    return false;
  }
  return REPRODUCTION_ACTION.test(normalized) || /[A-Za-z]{3,}/.test(normalized);
}

function extractNumberedSteps(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.match(/^\s*\d+[.)、]\s*(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
}

function extractLabeledValue(raw: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = raw.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:：]\\s*([^\\n]+)`, "iu"));
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function rawWithoutKnownLabels(raw: string): string | undefined {
  const lines = raw.split("\n").filter((line) => {
    if (/^\s*\d+[.)、]\s*/.test(line)) return false;
    if (isEvidenceReferenceLine(line)) return false;
    return !/^\s*(?:预期结果|期望结果|实际结果|实际现象|异常现象|产品版本|版本|设备|机型|操作系统|系统|OS|客户端|浏览器|操作账号|测试账号|账号|复现概率|重现概率|复现频率)\s*[:：]/iu.test(line);
  });
  const value = lines.join("\n").trim();
  return value || undefined;
}

function extractEvidenceReferences(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && isEvidenceReferenceLine(line));
}

function isEvidenceReferenceLine(value: string): boolean {
  const line = value.trim();
  if (/^!\[[^\]]*\]\((?:https?:\/\/|\/)[^)]+\)$/iu.test(line)) return true;
  if (/(?:截图|录屏|附件|证据)/u.test(line) && hasConcreteEvidenceReference(line)) return true;
  return /(?:\/tfl\/captures\/|\/attachments?\/|\.(?:png|jpe?g|gif|webp|mp4|mov|webm)(?:[?#]|$))/iu.test(line)
    && hasConcreteEvidenceReference(line);
}

function isEvidenceOnlyText(value: string): boolean {
  const withoutEvidence = value
    .replace(/!\[[^\]]*\]\((?:https?:\/\/|\/)[^)]+\)/giu, "")
    .replace(/\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)/giu, "")
    .replace(/(?:https?:\/\/|\/tfl\/|\/attachments?\/)[^\s)]+/giu, "")
    .replace(/(?:截图|录屏|附件|证据|如下|见附件|请查看)/gu, "")
    .replace(/[\s:：，,。.!！?？;；_-]+/gu, "");
  return withoutEvidence.length === 0;
}

function containsMultipleIndependentIssues(raw: string): boolean {
  const withoutEvidence = raw
    .split("\n")
    .filter((line) => !isEvidenceReferenceLine(line))
    .join("\n");
  if (!withoutEvidence.trim()) return false;

  const explicitIssueLabels = withoutEvidence.match(/(?:^|\n)\s*(?:问题|缺陷|Bug)\s*(?:[一二三四五六七八九十]|\d+)\s*[:：.)、]/giu) ?? [];
  if (explicitIssueLabels.length > 1) return true;

  const connector = /(?:同时|另外|此外|还有|并且|而且|另一个问题|还有一个问题)/gu;
  for (const match of withoutEvidence.matchAll(connector)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = nearestClause(withoutEvidence.slice(0, index), "before");
    const after = nearestClause(withoutEvidence.slice(index + match[0].length), "after");
    if (ISSUE_SIGNAL.test(before) && ISSUE_SIGNAL.test(after)) return true;
  }

  return false;
}

function nearestClause(value: string, direction: "before" | "after"): string {
  const clauses = value.split(/[\n。.!！?？;；，,]/u).map((part) => part.trim()).filter(Boolean);
  return direction === "before" ? clauses.at(-1) ?? "" : clauses[0] ?? "";
}

function hasConcreteEvidenceReference(value: string): boolean {
  return /!\[[^\]]*\]\((?:https?:\/\/|\/)[^)]+\)/iu.test(value)
    || /\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)/iu.test(value)
    || /(?:https?:\/\/|\/tfl\/|\/attachments?\/)[^\s)]+/iu.test(value);
}

function optionalText(value: string | undefined, argument: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidArgumentError(argument, `${argument} must be text.`);
  const normalized = redactText(value.replace(/\r\n?/g, "\n").trim());
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new InvalidArgumentError(argument, `${argument} is too long.`);
  return normalized;
}

function hasStructuredBugDetails(
  input: BugReportInput,
  explicitActual: string | undefined,
  explicitSteps: readonly string[],
): boolean {
  return Boolean(
    explicitActual
    || input.expectedResult
    || explicitSteps.length
    || input.productVersion
    || input.device
    || input.operatingSystem
    || input.client
    || input.account
    || input.reproductionProbability,
  );
}

function redactText(value: string): string {
  const redacted = redactSensitive(value);
  return typeof redacted === "string" ? redacted : value;
}
