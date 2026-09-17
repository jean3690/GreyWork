/**
 * AskUserQuestion（agent 向用户提问）载荷的归一化与作答格式化。
 *
 * Agent 通过一次名为 `AskUserQuestion` 的工具调用把问题与选项塞进 `rawInput.questions`。
 * 这里只做纯数据变换：校验形状、收敛出稳定结构、把作答拼成回传文本。渲染交互在
 * `components/chat/AskQuestionCard.vue`。
 *
 * 校验从严（畸形返回 null）的理由：宁可整块不渲染，也不要给用户一张点了没反应的
 * 空壳卡片 —— 选项为空或题干缺失时，这张卡无论怎么点都推不动回合。
 */
import type { AskAnswer, AskOption, AskQuestion, AskRequest } from "../types";
import { isRecord } from "./guards";

/** 选项上限：工具语义是 2–4 个，放宽到 8 兜住实现差异，再多就把消息流压垮了。 */
const MAX_OPTIONS = 8;

/** 工具名是否指向「向用户提问」。大小写与连字符/下划线写法都容。 */
export function isAskToolName(name: string | undefined): boolean {
  if (!name) return false;
  const key = name.toLowerCase().replace(/[-\s]/g, "_");
  return key === "askuserquestion" || key === "ask_user_question" || key === "ask_user";
}

function normalizeQuestion(raw: unknown): AskQuestion | null {
  if (!isRecord(raw)) return null;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return null;
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options = optionsRaw
    .map((option): AskOption | null => {
      if (!isRecord(option)) return null;
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label) return null;
      const description = typeof option.description === "string" && option.description.trim() ? option.description.trim() : undefined;
      return { label, description };
    })
    .filter((option): option is AskOption => option !== null)
    .slice(0, MAX_OPTIONS);
  if (options.length === 0) return null;
  const header = typeof raw.header === "string" && raw.header.trim() ? raw.header.trim() : undefined;
  return { question, header, options, multiSelect: raw.multiSelect === true };
}

/**
 * 归一化 AskUserQuestion 的入参。
 *
 * 兼容两种形态：完整入参对象 `{ questions: [...] }`，或直接就是题目数组。
 * 全部题目都畸形时返回 null。
 */
export function normalizeAskRequest(rawInput: unknown): AskRequest | null {
  const candidates = Array.isArray(rawInput)
    ? rawInput
    : isRecord(rawInput) && Array.isArray(rawInput.questions)
      ? rawInput.questions
      : null;
  if (!candidates) return null;
  const questions = candidates.map(normalizeQuestion).filter((question): question is AskQuestion => question !== null);
  return questions.length > 0 ? { questions } : null;
}

/** 卡片是否已作答（收口为只读态）。 */
export function isAskSettled(request: AskRequest | undefined): boolean {
  return typeof request?.answeredAt === "number";
}

/** 单题作答的展示文本（卡片只读态与回传消息共用）。 */
export function formatAnswerLine(answer: AskAnswer): string {
  const picked = [...answer.labels];
  if (answer.custom) picked.push(answer.custom);
  return `${answer.question}：${picked.length ? picked.join("、") : "（未作答）"}`;
}

/**
 * 把整份作答拼成回传给 agent 的用户消息正文。
 * 多选题会带上前缀标注，避免 agent 把它当成单选题来理解。
 */
export function formatAskAnswer(request: AskRequest): string {
  const answers = request.answers ?? [];
  const lines = answers.map((answer) => {
    const question = request.questions.find((item) => item.question === answer.question);
    const prefix = question?.multiSelect ? "[多选] " : "";
    return `${prefix}${formatAnswerLine(answer)}`;
  });
  return lines.join("\n");
}
