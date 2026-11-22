#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createServer } from "./server.js";

const server = createServer(configFromEnv());
await server.connect(new StdioServerTransport());
console.error("qa-mcp-server running on stdio");
