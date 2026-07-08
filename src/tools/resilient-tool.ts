import { defineTool } from "@flue/runtime";
import { coerceToolArgs } from "./coerce-tool-args.js";

// Flue ToolDefinition types omit prepareArguments; runtime preserves extras via ...tool.
export function defineResilientTool(
  def: Parameters<typeof defineTool>[0],
): ReturnType<typeof defineTool> {
  const toolName = def.name;
  const withPrepare = {
    ...def,
    prepareArguments: (args: unknown) => {
      const { value, coercions } = coerceToolArgs(toolName, args);
      if (coercions.length > 0) {
        console.debug("[threadcord] tool_args_coerced", {
          tool: toolName,
          coercions,
        });
      }
      return value;
    },
  };
  return defineTool(
    withPrepare as unknown as Parameters<typeof defineTool>[0],
  );
}
