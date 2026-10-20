/** Fixed output-data carrier. It grants no action, executor, network access or follow-up turn. */
export const OUTPUT_TOOL_NAME = 'submit_output';
export const OUTPUT_TOOL_DESCRIPTION = 'Submit the complete answer object as data. This tool executes no action.';
export const OUTPUT_TOOL = Object.freeze({
  name: OUTPUT_TOOL_NAME,
  description: OUTPUT_TOOL_DESCRIPTION,
  input_schema: Object.freeze({ type: 'object' }),
});

export type ReplyFormat = 'text' | 'single-tool-object';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Read expected framing from this call's exact encoded request, never from a response or mutable
 * port state. Unknown tool configurations refuse before fetch. Old requests without either tool
 * property keep the historical text parser. JSON.parse creates data properties, never getters.
 */
export function requestReplyFormat(text: string): ReplyFormat | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const body = record(value);
  if (body === undefined) return undefined;
  if (!Object.hasOwn(body, 'tools') && !Object.hasOwn(body, 'tool_choice')) return 'text';
  if (!Array.isArray(body['tools']) || body['tools'].length !== 1) return undefined;
  const tool = record(body['tools'][0]);
  const choice = record(body['tool_choice']);
  if (
    tool === undefined ||
    !exactKeys(tool, ['name', 'description', 'input_schema']) ||
    tool['name'] !== OUTPUT_TOOL_NAME ||
    tool['description'] !== OUTPUT_TOOL_DESCRIPTION ||
    choice === undefined ||
    !exactKeys(choice, ['type']) ||
    choice['type'] !== 'auto'
  )
    return undefined;
  const schema = record(tool['input_schema']);
  if (schema === undefined || !exactKeys(schema, ['type']) || schema['type'] !== 'object') return undefined;
  // This opt-in is documented only for M3; existing text model choices remain unchanged.
  return body['model'] === 'MiniMax-M3' ? 'single-tool-object' : undefined;
}
