// Every tool, in the order MCP clients list them. One line per file in this folder.
import type { AnyTool } from "../tool.ts";
import programInfo from "./program_info.ts";

export const TOOLS: readonly AnyTool[] = [programInfo];
