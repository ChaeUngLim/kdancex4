// SX-5.1(강사·학원 이름 후보 찾기) — Next.js 쪽 MCP 읽기 도구 서버(계약 16 §6 「MCP 읽기 도구」, 층 B2).
//   에이전트 서버(Python)는 DB 를 직접 보지 않고 이 서버의 도구로만 데이터를 읽는다(ADR-004). 이 파일이 그 도구 목록의 Next.js 원본이다.
//   에이전트 쪽 허용 목록은 agent-server/app/tools/read_catalog.py(SX-1.2(MCP 읽기 도구))이고, 이름은 둘 다 계약 §6 표와 같다.
//
// 왜 McpServer.registerTool 대신 저수준 Server 를 쓰나
//   - 오류 모양을 계약대로 정확히 내야 한다: 입력이 틀리면 `isError: true` + `{ "code": "INVALID_INPUT" }` 만(계약 §6).
//     고수준 API 는 자체 검사 문구(스키마 경로·메시지)를 그대로 돌려줘 계약 밖 글자가 섞인다.
//   - 모든 도구에 readOnlyHint=true · destructiveHint=false 를 붙인다. 에이전트 쪽 ReadOnlyToolbox 는 이 표시가 없는 도구를 빼 버린다.
//
// SX-5.1 이 find_instructors · find_academies 를, SX-5.3 이 search_offerings 를 올렸다(계약 §6 의 SX-5 행). 나머지 9개는 각자 Task 가 같은 표에 더한다.
// 쓰기 도구는 하나도 없다(FR-214(AI 쓰기 금지)) — 테스트가 tools/list 로 이름과 표시를 센다.
// 신원 토큰 확인(Authorization)·호출 수 상한은 HTTP 경로 `POST /api/internal/mcp` 를 만드는 Task 의 몫이다. 두 도구는 「내 데이터」가 없는 공개 정보라 신원을 쓰지 않는다.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  findAcademiesInputSchema,
  findAcademyCandidates,
  findInstructorCandidates,
  findInstructorsInputSchema,
  type NameCandidatesDeps,
} from "../services/name-candidates";
import { searchOfferingCards, searchOfferingsInputSchema } from "../services/offering-search";

/** 계약 16 §6 표의 읽기 도구 이름 전부(12개). tools/list 에 이 밖의 이름이 있으면 계약 위반이다 */
export const CONTRACT_READ_TOOL_NAMES = [
  "get_my_reservations",
  "get_my_orders",
  "get_my_schedule",
  "get_refund_preview",
  "get_my_waitlist",
  "search_offerings",
  "find_instructors",
  "find_academies",
  "get_offering_detail",
  "get_academy_info",
  "get_policy_text",
  "search_knowledge",
] as const;
export type ContractReadToolName = (typeof CONTRACT_READ_TOOL_NAMES)[number];

export type ReadToolDeps = NameCandidatesDeps;

/** 도구 결과의 출처 한 줄(계약 §6 「sources」) — 에이전트가 답 옆에 근거로 붙인다 */
type Source = { kind: string; id: string; label: string };
type ToolOutput = { data: unknown; sources: Source[] };

/** 도구 하나 = 이름 · 설명 · 입력 스키마(zod) · 실행. 입력은 실행 전에 이 스키마로 한 번 더 검사한다 */
type ReadTool = {
  name: ContractReadToolName;
  description: string;
  input: z.ZodType;
  run: (deps: ReadToolDeps, input: unknown) => Promise<ToolOutput>;
};

const READ_TOOLS: readonly ReadTool[] = [
  // SX-5.3(조건 검색 결과를 수업 카드로) — 조건으로 DB 를 직접 찾아 카드 값을 그대로 돌려준다. AI 는 이 결과 밖의 수업을 말하지 못한다
  {
    name: "search_offerings",
    description: "검색 조건(강사·학원 id, 요일, 시간대, 장르, 레벨 등)으로 공개 수업을 찾아 수업 카드로 돌려준다(DB 값 그대로, 개인 레슨은 레슨 모집 시간만)",
    input: searchOfferingsInputSchema,
    run: async (deps, input) => {
      const data = await searchOfferingCards(deps, searchOfferingsInputSchema.parse(input));
      // 출처는 카드마다 하나 — 개인 레슨은 판매 단위가 없어 상품 수업 id 를 쓴다
      return { data, sources: data.map((c) => ({ kind: "offering", id: c.offeringId ?? c.classId, label: c.title })) };
    },
  },
  {
    name: "find_instructors",
    description: "강사 이름으로 후보 찾기(정확히 같은 이름만, 같은 이름이 여럿이면 ambiguous 이고 하나로 정하지 않는다)",
    input: findInstructorsInputSchema,
    run: async (deps, input) => {
      const data = await findInstructorCandidates(deps, findInstructorsInputSchema.parse(input));
      return { data, sources: data.candidates.map((c) => ({ kind: "instructor", id: c.instructorId, label: c.displayName })) };
    },
  },
  {
    name: "find_academies",
    description: "학원 이름으로 후보 찾기(정확히 같은 이름의 공개 학원만)",
    input: findAcademiesInputSchema,
    run: async (deps, input) => {
      const data = await findAcademyCandidates(deps, findAcademiesInputSchema.parse(input));
      return { data, sources: data.candidates.map((c) => ({ kind: "academy", id: c.academyId, label: c.name })) };
    },
  },
];

/** 계약 §6 의 오류 하나를 MCP 결과로 — 본문은 코드만 담는다(데이터·검사 문구는 한 글자도 싣지 않는다) */
function toolError(code: "INVALID_INPUT" | "NOT_FOUND"): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code }) }] };
}

/**
 * 읽기 도구 서버를 만든다. 전송(transport)은 부르는 쪽이 붙인다 — HTTP 경로는 Streamable HTTP, 테스트는 메모리 안 연결.
 */
export function createReadToolServer(deps: ReadToolDeps): Server {
  const server = new Server({ name: "kdance-read-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

  // tools/list — 이름·설명·입력 JSON Schema·읽기 전용 표시. 에이전트(pydantic)와 같은 스키마를 가리킨다(계약 §6)
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: READ_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...(z.toJSONSchema(tool.input) as Record<string, unknown>), type: "object" as const },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }));

  // tools/call — 목록 밖 이름은 NOT_FOUND, 입력이 스키마 밖(모르는 칸 memberId 포함)이면 INVALID_INPUT
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = READ_TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) return toolError("NOT_FOUND");
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return toolError("INVALID_INPUT");
    const output = await tool.run(deps, parsed.data);
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  });

  return server;
}
