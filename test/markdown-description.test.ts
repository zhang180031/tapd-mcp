import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSING_SCREENSHOT_EVIDENCE,
  MISSING_VALUE,
  formatBugReport,
  toTapdMarkdownDescription,
} from "../src/services/index.js";

test("omits unsupplied supplementary fields while keeping the required Bug sections", () => {
  const result = formatBugReport({ rawDescription: "点击保存后页面没有响应" });

  for (const heading of [
    "## 复现步骤",
    "## 预期结果",
    "## 实际结果",
    "## 附件证据",
  ]) {
    assert.equal(result.markdown.includes(heading), true, `missing ${heading}`);
  }
  assert.equal(result.markdown.includes("## 基础环境"), false);
  assert.equal(result.markdown.includes("## 待补充信息"), false);
  assert.match(result.markdown, /1\. 【待补充】\n2\. 【待补充】\n3\. 【待补充】/);
  assert.match(result.markdown, /## 预期结果\n\n【待补充】/);
  assert.match(result.markdown, /## 实际结果\n\n点击保存后页面没有响应/);
  assert.match(result.markdown, new RegExp(`## 附件证据\\n\\n${MISSING_SCREENSHOT_EVIDENCE}`));
  assert.equal(result.missingInformation.includes("产品版本"), false);
  assert.ok(result.missingInformation.includes("复现步骤 1"));
  assert.ok(result.missingInformation.some((item) => item.startsWith("预期结果")));
  assert.ok(result.missingInformation.includes("截图/录屏证据"));
});

test("emits only the supplementary environment fields supplied by the user", () => {
  const result = formatBugReport({
    expectedResult: "提交成功后显示白名单详情，并可在列表中查询到新增记录",
    actualResult: "点击确认后页面提示错误码 E_PERMISSION，白名单列表没有新增记录",
    reproductionSteps: ["登录主管账号", "进入白名单管理并选择仪征站", "点击确认按钮"],
    productVersion: "v3.2.0",
    client: "Chrome 138",
    attachmentEvidence: ["![权限错误截图](/tfl/captures/permission-error.png)"],
  });

  assert.match(result.markdown, /^## 基础环境\n\n- 产品版本：v3\.2\.0\n- 客户端\/浏览器：Chrome 138/);
  for (const omitted of ["设备：", "系统：", "操作账号：", "复现概率：", "## 待补充信息"]) {
    assert.equal(result.markdown.includes(omitted), false, `unexpected ${omitted}`);
  }
  assert.deepEqual(result.missingInformation, []);
});

test("preserves objective structured details and uses numeric reproduction steps", () => {
  const result = formatBugReport({
    rawDescription: "保存接口返回 HTTP 500，错误码 E_SAVE_01",
    expectedResult: "保存成功并返回详情页，数据与产品需求一致",
    actualResult: "点击保存后接口返回 HTTP 500，错误码 E_SAVE_01，页面停留在编辑态",
    reproductionSteps: ["登录测试账号", "进入订单详情并修改备注", "点击保存按钮"],
    productVersion: "v2.4.1",
    device: "MacBook Pro",
    operatingSystem: "macOS 15.5",
    client: "Chrome 138",
    account: "tester@example.invalid",
    reproductionProbability: "5/5，必现",
    attachmentEvidence: ["![保存失败截图](/tfl/captures/save-error.png)"],
  });

  assert.match(result.markdown, /1\. 登录测试账号\n2\. 进入订单详情并修改备注\n3\. 点击保存按钮/);
  assert.match(result.markdown, /- 产品版本：v2\.4\.1/);
  assert.match(result.markdown, /## 附件证据\n\n!\[保存失败截图\]/);
  assert.equal(result.markdown.includes("## 待补充信息"), false);
  assert.equal(result.markdown.includes(MISSING_SCREENSHOT_EVIDENCE), false);
  assert.deepEqual(result.missingInformation, []);
});

test("keeps sanitised raw source material when structured Bug facts are supplied", () => {
  const result = formatBugReport({
    rawDescription: [
      "接口调用与筛选条件如下：",
      "curl 'https://example.invalid/api/search' \\",
      "  -H 'authorization: Bearer source-material-secret' \\",
      "  --data-raw '{\"serviceType\":\"服务器退役\"}'",
    ].join("\n"),
    expectedResult: "应返回满足筛选条件的工单数据。",
    actualResult: "请求后页面提示“服务器错误”。",
    reproductionSteps: ["进入工单管理页面", "选择服务器退役", "点击搜索"],
  });

  assert.match(result.markdown, /## 补充材料/);
  assert.match(result.markdown, /curl 'https:\/\/example\.invalid\/api\/search'/);
  assert.match(result.markdown, /authorization: \[REDACTED\]/);
  assert.equal(result.markdown.includes("source-material-secret"), false);
});

test("marks non-defects and replaces vague actual results with an explicit placeholder", () => {
  const nonDefect = formatBugReport({
    rawDescription: "原型未设计批量导出，希望新增这个功能",
    classification: "non_defect",
  });
  assert.equal(nonDefect.markdown.startsWith("> 【非缺陷，建议提交需求单】"), true);

  const vague = formatBugReport({ actualResult: "页面有点卡，不好用" });
  assert.match(vague.markdown, new RegExp(`## 实际结果\\n\\n${MISSING_VALUE}`));
  assert.ok(vague.missingInformation.some((item) => item.includes("客观、可量化")));

  const evidenceClaimWithoutFile = formatBugReport({ attachmentEvidence: ["截图见附件"] });
  assert.match(evidenceClaimWithoutFile.markdown, new RegExp(`## 附件证据\\n\\n${MISSING_SCREENSHOT_EVIDENCE}`));
});

test("rejects or marks imprecise expected, actual, and reproduction content", () => {
  const result = formatBugReport({
    expectedResult: "页面应该正常显示",
    actualResult: "页面很慢",
    reproductionSteps: ["正常操作后查看结果"],
  });

  assert.match(result.markdown, new RegExp(`## 复现步骤\\n\\n1\\. ${MISSING_VALUE}`));
  assert.match(result.markdown, new RegExp(`## 预期结果\\n\\n${MISSING_VALUE}`));
  assert.match(result.markdown, new RegExp(`## 实际结果\\n\\n${MISSING_VALUE}`));
  assert.ok(result.missingInformation.some((item) => item.includes("精准操作")));
  assert.ok(result.missingInformation.some((item) => item.includes("正常标准")));
  assert.ok(result.missingInformation.some((item) => item.includes("客观、可量化")));
});

test("rejects obvious multiple problems instead of combining them into one Bug", () => {
  assert.throws(
    () => formatBugReport({ rawDescription: "保存按钮无响应，同时头像上传后错位" }),
    /multiple apparent problems/i,
  );
  assert.throws(
    () => formatBugReport({ actualResult: "保存按钮无响应，同时头像上传后错位" }),
    /multiple apparent problems/i,
  );
});

test("treats screenshot-only input as evidence while leaving the actual result missing", () => {
  const evidence = "![截图](/tfl/captures/a.png)";
  const result = formatBugReport({ rawDescription: evidence });

  assert.match(result.markdown, new RegExp(`## 实际结果\\n\\n${MISSING_VALUE}`));
  assert.match(result.markdown, /## 附件证据\n\n!\[截图\]\(\/tfl\/captures\/a\.png\)/);
  assert.ok(result.missingInformation.some((item) => item.includes("实际结果")));
  assert.equal(result.missingInformation.includes("截图/录屏证据"), false);
});

test("does not mistake an API URL in the actual result for screenshot evidence", () => {
  const actual = "调用 https://example.invalid/api/save 后返回 HTTP 500";
  const result = formatBugReport({ rawDescription: actual });

  assert.equal(result.markdown.includes(`## 实际结果\n\n${actual}`), true);
  assert.match(result.markdown, new RegExp(`## 附件证据\\n\\n${MISSING_SCREENSHOT_EVIDENCE}`));
});

test("keeps Markdown source while rendering safe TAPD HTML", () => {
  const source = [
    "## 验收标准",
    "",
    "1. 显示 **成功** 状态",
    "2. 保留 `<script>alert(1)</script>` 文本",
    "",
    "![截图](/tfl/captures/safe.png)",
  ].join("\n");
  const result = toTapdMarkdownDescription(source);

  assert.equal(result.markdown, source);
  assert.match(result.html, /<h2>验收标准<\/h2>/);
  assert.match(result.html, /<ol><li>显示 <strong>成功<\/strong> 状态<\/li>/);
  assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(result.html.includes("<script>"), false);
  assert.match(result.html, /<img src="\/tfl\/captures\/safe\.png" alt="截图">/);
});

test("redacts credentials before serialising Markdown to TAPD", () => {
  const result = toTapdMarkdownDescription("## 请求\n\nAuthorization: Bearer markdown-secret\n\ndsc_token=token-secret");

  assert.match(result.markdown, /Authorization: \[REDACTED\]/);
  assert.match(result.markdown, /dsc_token=\[REDACTED\]/);
  assert.equal(result.markdown.includes("markdown-secret"), false);
  assert.equal(result.markdown.includes("token-secret"), false);
  assert.equal(result.html.includes("markdown-secret"), false);
});
