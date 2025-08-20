// Import paths for MCP SDK are ESM with .js suffix at runtime.
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  ListToolsResultSchema,
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import EventSource from "eventsource";
import {
  VISUAL_SCRIPT_TEMPLATES,
  getTemplatesByCategory,
  getTemplatesByTag,
  getAllCategories,
  getAllTags,
  searchTemplates,
  // type VisualScriptTemplate
} from "./visualScriptingTemplates.js";

// Env helpers and small utilities
function envBool(name: string, defaultValue: boolean): boolean {
  const v = (process.env[name] ?? "").toString().trim().toLowerCase();
  if (v === "" || v == null) return defaultValue;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}
// const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));


// Unity bridge base URL (Unity Editor plugin will host this locally)
const UNITY_BASE_URL = process.env.UNITY_BRIDGE_URL || "http://127.0.0.1:58888";

const DEBUG = process.env.UNITY_MCP_DEBUG === "1" || process.env.DEBUG === "1";

// Type definitions for better type safety
type UnityResponse<T> = {
  ok: boolean;
  result?: T;
  resultJson?: string;
  error?: string;
};

type VisualScriptResponse = {
  gameObjectPath: string;
  scriptName: string;
  success: boolean;
  message: string;
  nodes?: Array<{
    nodeId: string;
    nodeType: string;
    displayName: string;
    position: Vector3;
    nodeData: string;
    inputPorts: string[];
    outputPorts: string[];
  }>;
  connections?: Array<{
    fromNodeId: string;
    fromPort: string;
    toNodeId: string;
    toPort: string;
  }>;
};

type Vector3 = {
  x: number;
  y: number;
  z: number;
};

type Color = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// Console verification configuration
const CONSOLE_VERIFICATION_ENABLED = envBool("UNITY_CONSOLE_VERIFICATION", true);
const CONSOLE_CHECK_DELAY_MS = envInt("UNITY_CONSOLE_CHECK_DELAY_MS", 500);

// Common response helper functions
function successResponse(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResponse(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// function jsonResponse(data: unknown): ToolResult {
//   return successResponse(JSON.stringify(data ?? {}));
// }

// Enhanced response with console verification
async function successResponseWithConsoleCheck(text: string, skipConsoleCheck: boolean = false): Promise<ToolResult> {
  if (!CONSOLE_VERIFICATION_ENABLED || skipConsoleCheck) {
    return successResponse(text);
  }

  try {
    // Small delay to allow Unity to process the operation
    await new Promise(resolve => setTimeout(resolve, CONSOLE_CHECK_DELAY_MS));

    // Check console for any errors or warnings
    const consoleResult = await callUnity<{ text: string } | null>("/console/read", {});
    const consoleText = consoleResult?.text || "";

    // Look for recent errors or warnings in console
    const lines = consoleText.split('\n').slice(-10); // Check last 10 lines
    const hasErrors = lines.some(line => line.includes('Error:') || line.includes('error CS'));
    const hasWarnings = lines.some(line => line.includes('Warning:') || line.includes('warning CS'));

    let responseText = text;

    if (hasErrors) {
      const errorLines = lines.filter(line => line.includes('Error:') || line.includes('error CS'));
      responseText += `\n\n⚠️ CONSOLE ERRORS DETECTED:\n${errorLines.join('\n')}`;
    }

    if (hasWarnings) {
      const warningLines = lines.filter(line => line.includes('Warning:') || line.includes('warning CS'));
      responseText += `\n\n⚠️ CONSOLE WARNINGS:\n${warningLines.join('\n')}`;
    }

    if (!hasErrors && !hasWarnings) {
      responseText += "\n✅ Console Status: Clean";
    }

    return { content: [{ type: "text", text: responseText }], isError: hasErrors };

  } catch (consoleError) {
    // If console check fails, return original response with note
    return { content: [{ type: "text", text: `${text}\n\n⚠️ Console check failed: ${(consoleError as Error).message}` }] };
  }
}

// Enhanced error response with console verification
async function errorResponseWithConsoleCheck(text: string): Promise<ToolResult> {
  if (!CONSOLE_VERIFICATION_ENABLED) {
    return errorResponse(text);
  }

  try {
    // Check console for additional error context
    const consoleResult = await callUnity<{ text: string } | null>("/console/read", {});
    const consoleText = consoleResult?.text || "";

    // Get recent console output for context
    const lines = consoleText.split('\n').slice(-15); // Check last 15 lines for errors
    const errorLines = lines.filter(line =>
      line.includes('Error:') ||
      line.includes('error CS') ||
      line.includes('Exception:') ||
      line.includes('Failed')
    );

    let responseText = text;
    if (errorLines.length > 0) {
      responseText += `\n\n🔍 CONSOLE ERROR CONTEXT:\n${errorLines.join('\n')}`;
    }

    return { content: [{ type: "text", text: responseText }], isError: true };

  } catch (consoleError) {
    return { content: [{ type: "text", text: `${text}\n\n⚠️ Console check failed: ${(consoleError as Error).message}` }], isError: true };
  }
}

export async function callUnity<T>(path: string, payload?: unknown, timeoutMs?: number): Promise<T> {
  const url = `${UNITY_BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.UNITY_BRIDGE_TOKEN;
  if (token) headers["X-Unity-Bridge-Token"] = token;
  const maxAttempts = 8;
  const start = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.post<UnityResponse<T>>(url, payload ?? {}, {
        headers,
        timeout: timeoutMs !== undefined ? timeoutMs : 45_000,
        validateStatus: () => true,
      });
      if (!response.data || (typeof response.data === "object" && response.data.ok === false)) {
        const msg = response.data?.error || `Unity call failed: ${path}`;
        throw new Error(msg);
      }
      const body = response.data;
      if (DEBUG) { console.log(`[unity-mcp] POST ${path} ok in ${Date.now() - start}ms`); }
      if (body.result !== undefined) return body.result;
      if (body.resultJson) {
        try {
          return JSON.parse(body.resultJson) as T;
        } catch (e) {
          throw new Error(`Failed to parse Unity resultJson for ${path}: ${(e as Error).message}`);
        }
      }
      return undefined as unknown as T;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|network error/i.test(msg);
      if (DEBUG) { console.warn(`[unity-mcp] POST ${path} attempt ${attempt}/${maxAttempts} failed: ${msg}`); }
      if (!transient || attempt === maxAttempts) {
        throw err as Error;
      }
      await new Promise(res => setTimeout(res, 200 * attempt));
    }
  }
  throw lastErr as Error;
}

async function getUnityText(path: string, timeoutMs?: number): Promise<string> {
  const url = `${UNITY_BASE_URL}${path}`;
  const maxAttempts = 8;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.get(url, { timeout: timeoutMs ?? 30_000, validateStatus: () => true });
      if (res.status >= 200 && res.status < 300) {
        return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|network error|HTTP 5\d\d/i.test(msg);
      if (!transient || attempt === maxAttempts) throw err as Error;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastErr as Error;
}

// Compilation wait configuration and helper
const COMPILE_TIMEOUT_MS: number = Number.isFinite(Number(process.env.UNITY_COMPILE_TIMEOUT_MS))
  ? Number(process.env.UNITY_COMPILE_TIMEOUT_MS)
  : 120_000;

async function waitForCompileIdle(timeoutMs: number = COMPILE_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const state = await callUnity<{ playMode: string; isCompiling: boolean } | null>("/editor/state", {});
      if (!state?.isCompiling) break;
    } catch {
      // ignore transient errors during domain reload
    }
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for Unity to finish compilation");
  }
  // small settle delay
  await new Promise((r) => setTimeout(r, 250));
}

type ToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

// Expose a directly testable handler for unity.assets
export async function unityAssetsHandler(args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { action, path, query } = args as { action?: string; path?: string; query?: string };
  const act = String(action ?? (query ? "find" : "list")).toLowerCase();
  if (act === "find") {
    const result = await callUnity<{ assets: string[] } | null>("/assets/find", { query: query ?? "", path });
    const assets = Array.isArray(result?.assets) ? result!.assets : [];
    return { content: [{ type: "text", text: assets.join("\n") }] };
  }
  if (act === "list") {
    const result = await callUnity<{ assets: string[] } | null>("/assets/list", { path });
    const assets = Array.isArray(result?.assets) ? result!.assets : [];
    return { content: [{ type: "text", text: assets.join("\n") }] };
  }
  if (act === "refresh") {
    await callUnity("/assets/refresh", {});
    return { content: [{ type: "text", text: "Refreshed AssetDatabase" }] };
  }
  return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
}

export function getServer() {
  const server = new McpServer(
    { name: "unity-mcp", version: "0.1.0" },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
      },
    }
  );

  const tools: ToolDef[] = [
    // Optimized tool set - reduced from 28 to 18 tools
    {
      name: "unity_console",
      description: "Console tools: read recent Unity logs or clear the console (action=read|clear)",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Operation to perform. 'read' returns the latest console text; 'clear' clears Unity's console and the bridge log ring.",
            enum: ["read", "clear"],
          },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "read").toLowerCase();
        if (act === "clear") {
          await callUnity("/console/clear", {});
          return successResponse("Cleared ✅");
        }
        const result = await callUnity<{ text: string } | null>("/console/read", {});
        const text = result?.text && typeof result.text === "string" ? result.text : "";

        // Add status indicators to console output
        const lines = text.split('\n');
        const errorCount = lines.filter(line => line.includes('Error:') || line.includes('error CS')).length;
        const warningCount = lines.filter(line => line.includes('Warning:') || line.includes('warning CS')).length;

        let statusText = text;
        if (errorCount > 0 || warningCount > 0) {
          statusText += `\n\n📊 CONSOLE STATUS: ${errorCount} errors, ${warningCount} warnings`;
        } else if (text.trim()) {
          statusText += "\n\n✅ CONSOLE STATUS: No errors or warnings detected";
        }

        return { content: [{ type: "text", text: statusText }] };
      },
    },
    {
      name: "unity_play",
      description: "Control Play Mode in the Editor (action=start|stop|pause|resume)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'start', 'stop', 'pause', or 'resume'", enum: ["start", "stop", "pause", "resume"] },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "start").toLowerCase();
        if (act === "start") {
          try {
            await callUnity("/play/start", {});

            // Verify play mode actually started by checking editor state
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Unity to process
            const state = await callUnity<{ playMode: string; isCompiling: boolean } | null>("/editor/state", {});

            if (state?.playMode === "Playing") {
              return await successResponseWithConsoleCheck("🎮 Play Mode Started Successfully");
            } else if (state?.isCompiling) {
              return await errorResponseWithConsoleCheck("❌ Cannot start Play Mode: Unity is compiling. Fix compilation errors first.");
            } else {
              return await errorResponseWithConsoleCheck("❌ Play Mode failed to start. Check console for compilation errors.");
            }
          } catch (error) {
            return await errorResponseWithConsoleCheck(`❌ Play Mode start failed: ${(error as Error).message}`);
          }
        }
        if (act === "stop") {
          await callUnity("/play/stop", {});
          return await successResponseWithConsoleCheck("⏹️ Play Mode Stopped");
        }
        if (act === "pause") {
          await callUnity("/play/pause", { pause: true });
          return await successResponseWithConsoleCheck("⏸️ Play Mode Paused");
        }
        if (act === "resume") {
          await callUnity("/play/pause", { pause: false });
          return await successResponseWithConsoleCheck("▶️ Play Mode Resumed");
        }
        return await errorResponseWithConsoleCheck(`Unknown action: ${act}`);
      },
    },
    {
      name: "unity_packages",
      description: "Unity Package Manager operations (action=list|install|remove)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'list' installed packages, 'install' a package, or 'remove' a package", enum: ["list", "install", "remove"] },
          id: {
            type: "string",
            description: "Package identifier for install/remove (e.g., 'com.unity.cinemachine' or a git URL). Required for install/remove.",
          },
        },
      },
      handler: async (args) => {
        const { action, id } = args as { action?: string; id?: string };
        const act = String(action ?? "list").toLowerCase();
        if (act === "list") {
          const result = await callUnity<{ packages: Array<{ name: string; version: string; displayName: string }> }>("/packages/list", {});
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (act === "install") {
          if (!id) return { content: [{ type: "text", text: "id required for install" }], isError: true };
          const result = await callUnity<{ id: string; installedVersion: string }>("/package/install", { id });
          await waitForCompileIdle();
          return { content: [{ type: "text", text: `Installed ${result.id}@${result.installedVersion}` }] };
        }
        if (act === "remove") {
          if (!id) return { content: [{ type: "text", text: "id required for remove" }], isError: true };
          const result = await callUnity<{ id: string }>("/package/remove", { id });
          await waitForCompileIdle();
          return { content: [{ type: "text", text: `Removed ${result.id}` }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_assets",
      description: "Asset operations: list/find/refresh database, or instantiate assets into scene",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "'list' assets, 'find' by query, 'refresh' database, or 'instantiate' asset into scene",
            enum: ["list", "find", "refresh", "instantiate"]
          },
          // AssetDatabase operations
          path: { type: "string", description: "Folder path for list (e.g., 'Assets/Prefabs') or GameObject parent path for instantiate" },
          query: { type: "string", description: "AssetDatabase search filter for find (e.g., 't:Prefab', 't:Material myName')" },
          // Instantiate operations
          assetPath: { type: "string", description: "Asset path to instantiate (e.g., 'Assets/Prefabs/Cube.prefab')" },
          parentPath: { type: "string", description: "Optional parent GameObject path for instantiated object" },
          position: { type: "object", description: "World position {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localPosition: { type: "object", description: "Local position {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localScale: { type: "object", description: "Local scale {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        },
      },
      handler: async (args) => {
        const { action, assetPath } = args as { action?: string; assetPath?: string };
        const act = String(action ?? "list").toLowerCase();

        // Original AssetDatabase operations
        if (act === "find" || act === "list" || act === "refresh") {
          return unityAssetsHandler(args);
        }

        // Instantiate operation (from unity_asset)
        if (act === "instantiate") {
          if (!assetPath) return { content: [{ type: "text", text: "assetPath required for instantiate" }], isError: true };
          const res = await callUnity<{ path: string; instanceId: number }>("/asset/instantiate", args);
          return { content: [{ type: "text", text: `Instantiated ${res.path} (id ${res.instanceId})` }] };
        }

        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_selection",
      description: "Get or set the current selection (action=get|set)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'get' returns selected GameObject paths; 'set' updates the selection", enum: ["get", "set"] },
          paths: { type: "array", description: "GameObject paths or names to select (for action='set')", items: { type: "string" } },
          instanceIds: { type: "array", description: "Unity instance IDs to select (for action='set')", items: { type: "number" } },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "get").toLowerCase();
        if (act === "get") {
          const result = await callUnity<{ paths: string[] } | null>("/selection/get", {});
          const paths = Array.isArray(result?.paths) ? result!.paths : [];
          return { content: [{ type: "text", text: paths.join("\n") }] };
        }
        const result = await callUnity<{ count: number }>("/selection/set", args);
        return { content: [{ type: "text", text: `Selected ${result.count} objects` }] };
      },
    },
    {
      name: "unity_gameObject",
      description: "GameObject operations including hierarchy (action=create|get|set|delete|hierarchy). Use name or path or instanceId to address.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'create', 'get', 'set', 'delete', or 'hierarchy' to get all paths", enum: ["create", "get", "set", "delete", "hierarchy"] },
          // create
          name: { type: "string", description: "Name for the new GameObject (create) or new name (set)." },
          primitiveType: { type: "string", description: "Primitive type for create (e.g., 'Cube', 'Sphere', 'Cylinder', 'Plane', 'Quad', 'Capsule'). Optional." },
          parentPath: { type: "string", description: "Optional parent GameObject path (create)." },
          active: { type: "boolean", description: "Active state (create/set)." },
          tag: { type: "string", description: "Tag to assign (create/set)." },
          layer: { type: "number", description: "Layer index (create/set)." },
          components: { type: "array", description: "Component types to add on create (e.g., 'UnityEngine.Rigidbody').", items: { type: "string" } },
          // transform properties
          position: { type: "object", description: "World position {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localPosition: { type: "object", description: "Local position {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          rotation: { type: "object", description: "World rotation euler angles {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localRotation: { type: "object", description: "Local rotation euler angles {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          eulerAngles: { type: "object", description: "World euler angles {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localEulerAngles: { type: "object", description: "Local euler angles {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          scale: { type: "object", description: "Local scale {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          localScale: { type: "object", description: "Local scale {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          // addressing for get/set/delete
          path: { type: "string", description: "Target GameObject path or name (get/set/delete)." },
          // alias for addressing when path is not provided in 'get' (will be treated as 'path')
          targetName: { type: "string", description: "Alias for 'path' when using action='get'. If provided and 'path' is missing, it will be used as path." },
          instanceId: { type: "number", description: "Target GameObject instance ID (get/set/delete)." },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "create").toLowerCase();
        if (act === "create") {
          const { primitiveType, name, position, localPosition, localScale, scale, localEulerAngles } = args as Record<string, unknown>;

          if (primitiveType && typeof primitiveType === 'string') {
            // Check if position is provided (either position or localPosition)
            if (!position && !localPosition) {
              return { content: [{ type: "text", text: `Position required when creating primitive ${primitiveType}. Please provide 'position' or 'localPosition' to avoid objects stacking at origin.` }], isError: true };
            }

            // Use Unity menu system to create visible primitives
            const menuMap: Record<string, string> = {
              'Cube': 'GameObject/3D Object/Cube',
              'Sphere': 'GameObject/3D Object/Sphere',
              'Cylinder': 'GameObject/3D Object/Cylinder',
              'Plane': 'GameObject/3D Object/Plane',
              'Quad': 'GameObject/3D Object/Quad',
              'Capsule': 'GameObject/3D Object/Capsule'
            };

            const menuPath = menuMap[primitiveType];
            if (menuPath) {
              // Create primitive via menu
              await callUnity("/menu/execute", { menuPath });

              // Get the newly created object
              const hierarchy = await callUnity<{ paths: string[] } | null>("/hierarchy/get", {});
              const newObjects = hierarchy?.paths?.filter(p => p.includes(primitiveType)) || [];

              if (newObjects.length > 0) {
                const newObjectPath = newObjects[newObjects.length - 1];

                // Apply name and transform properties
                const setProps: Record<string, unknown> = { path: newObjectPath };
                if (name) setProps.name = name;
                // Handle both 'position' and 'localPosition' parameters (position takes precedence)
                if (position) setProps.localPosition = position;
                else if (localPosition) setProps.localPosition = localPosition;
                // Handle both 'scale' and 'localScale' parameters (scale takes precedence)
                if (scale) setProps.localScale = scale;
                else if (localScale) setProps.localScale = localScale;
                if (localEulerAngles) setProps.localEulerAngles = localEulerAngles;

                if (Object.keys(setProps).length > 1) {
                  await callUnity("/gameobject/setProperties", setProps);
                }

                const finalName = name || newObjectPath;
                return { content: [{ type: "text", text: `Created visible ${primitiveType} named ${finalName}` }] };
              }
            }

            return { content: [{ type: "text", text: `Failed to create ${primitiveType}: unsupported primitive type` }], isError: true };
          }

          // Fallback to regular creation for non-primitives
          const result = await callUnity<{ instanceId: number; path: string }>("/gameobject/create", args);
          return { content: [{ type: "text", text: `Created ${result.path} (id ${result.instanceId})` }] };
        }
        if (act === "get") {
          // Support alias: if caller passes only 'name' or 'targetName' for addressing, map to 'path'
          const { path, instanceId, name, targetName, ..._rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ..._rest };
          if (instanceId !== undefined) payload.instanceId = instanceId;
          if (path !== undefined) payload.path = path;
          else if (targetName !== undefined) payload.path = targetName;
          else if (name !== undefined && (act === "get")) payload.path = name; // legacy alias
          const result = await callUnity<{ instanceId: number; path: string; name: string; active: boolean; tag: string; layer: number; position: {x:number;y:number;z:number}; localPosition: {x:number;y:number;z:number}; eulerAngles: {x:number;y:number;z:number}; localEulerAngles: {x:number;y:number;z:number}; localScale: {x:number;y:number;z:number} } | null>("/gameobject/getProperties", payload);
          return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
        }
        if (act === "set") {
          const { path, name, instanceId, components, ..._rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ..._rest };
          if (instanceId !== undefined) payload.instanceId = instanceId;
          if (path !== undefined) payload.path = path;
          else if (name !== undefined) payload.path = name;

          // Handle legacy components format for transforms
          if (components && Array.isArray(components)) {
            for (const comp of components) {
              if (comp && typeof comp === 'object' &&
                  'type' in comp && comp.type === 'UnityEngine.Transform' &&
                  'fields' in comp && comp.fields && typeof comp.fields === 'object') {
                // Extract transform fields from component format
                Object.assign(payload, comp.fields);
              }
            }
          }

          const result = await callUnity<{ path: string }>("/gameobject/setProperties", payload);
          return { content: [{ type: "text", text: `Updated ${result.path}` }] };
        }
        if (act === "delete") {
          const { path, instanceId, name, ..._rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ..._rest };
          if (instanceId !== undefined) payload.instanceId = instanceId;
          if (path !== undefined) payload.path = path;
          else if (name !== undefined) payload.path = name;
          const result = await callUnity<{ path: string }>("/gameobject/delete", payload);
          return { content: [{ type: "text", text: `Deleted ${result.path}` }] };
        }
        if (act === "hierarchy" || act === "gethierarchy") {
          // Get full hierarchy paths
          const result = await callUnity<{ paths: string[] } | null>("/hierarchy/get", {});
          const paths = Array.isArray(result?.paths) ? result.paths : [];
          return { content: [{ type: "text", text: paths.join("\n") }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_component",
      description: "Component operations on a GameObject (action=addOrUpdate|get|getAll|destroy). Accepts path/name or instanceId + componentType.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "addOrUpdate ensures/updates; get reads a snapshot; getAll lists attached components; destroy removes a component", enum: ["addOrUpdate", "get", "getAll", "destroy"] },
          path: { type: "string", description: "Owner GameObject path or name (alternative to instanceId)." },
          name: { type: "string", description: "Alias for 'path' if provided (owner name)." },
          instanceId: { type: "number", description: "Owner GameObject instance ID." },
          componentType: { type: "string", description: "Component type (e.g., 'Rigidbody', 'UnityEngine.Camera') for addOrUpdate/get/destroy." },
          fields: { type: "object", description: "JSON object of fieldName -> value to apply (MonoBehaviours and supported engine components)." },
        },
      },
      handler: async (args) => {
        const { action, path, name, instanceId, componentType, fields } = args as { action?: string; path?: string; name?: string; instanceId?: number; componentType?: string; fields?: Record<string, unknown> };
        const act = String(action ?? "addOrUpdate").toLowerCase();
        const basePayload: Record<string, unknown> = {};
        if (instanceId !== undefined) basePayload.instanceId = instanceId;
        if (path !== undefined) basePayload.path = path;
        else if (name !== undefined) basePayload.path = name;
        if (act === "addorupdate") {
          if (!componentType) return { content: [{ type: "text", text: "componentType required" }], isError: true };
          const payload = { ...basePayload, componentType, fieldsJson: fields ? JSON.stringify(fields) : undefined } as Record<string, unknown>;
          const result = await callUnity<{ componentType: string; path: string }>("/component/addOrUpdate", payload);
          return { content: [{ type: "text", text: `Ensured ${result.componentType} on ${result.path}` }] };
        }
        if (act === "get") {
          const payload = { ...basePayload, componentType } as Record<string, unknown>;
          const res = await callUnity<Record<string, unknown> | null>("/component/get", payload);
          return { content: [{ type: "text", text: JSON.stringify(res ?? {}) }] };
        }
        if (act === "getall") {
          const res = await callUnity<Record<string, unknown> | null>("/component/getAll", basePayload);
          return { content: [{ type: "text", text: JSON.stringify(res ?? {}) }] };
        }
        if (act === "destroy") {
          if (!componentType) return { content: [{ type: "text", text: "componentType required for destroy" }], isError: true };
          const payload = { ...basePayload, componentType } as Record<string, unknown>;
          await callUnity("/component/destroy", payload);
          return { content: [{ type: "text", text: `Destroyed ${componentType}` }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_editor",
      description: "Editor utilities: state/info/notify, build target switch, PlayerPrefs ops, and method invocation (action=state|info|notify|buildTarget|prefsSet|prefsGet|prefsDelete|prefsClear|invoke)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'state' (play/compiling/selection), 'info' (project/version/paths), 'notify', 'buildTarget', PlayerPrefs ops, or 'invoke' for reflection.", enum: ["state", "info", "notify", "buildTarget", "prefsSet", "prefsGet", "prefsDelete", "prefsClear", "invoke"] },
          // notify
          message: { type: "string", description: "Message for notifications (notify)." },
          title: { type: "string", description: "Optional title for notifications (notify)." },
          modal: { type: "boolean", description: "If true, show a blocking dialog; otherwise a non-modal notification (notify)." },
          // buildTarget
          target: { type: "string", description: "BuildTarget name (e.g., StandaloneWindows64, Android)." },
          // PlayerPrefs
          key: { type: "string", description: "PlayerPrefs key for prefsSet/get/delete." },
          prefType: { type: "string", description: "Type for prefsSet/get: 'string' (default), 'int', or 'float'.", enum: ["string", "int", "float"] },
          stringValue: { type: "string", description: "Value for prefsSet when prefType='string'." },
          intValue: { type: "number", description: "Value for prefsSet when prefType='int'." },
          floatValue: { type: "number", description: "Value for prefsSet when prefType='float'." },
          // invoke
          typeName: { type: "string", description: "Fully qualified type name for invoke." },
          methodName: { type: "string", description: "Method name for invoke." },
          isStatic: { type: "boolean", description: "If true, invoke a static method." },
          argsJson: { type: "string", description: "Optional JSON array of string args for invoke (e.g., ['a','b'])." },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "state").toLowerCase();
        if (act === "state") {
          const state = await callUnity<{ playMode: string; isCompiling: boolean; selection: string[] } | null>("/editor/state");
          const playMode = state?.playMode ?? "Unknown";
          const compiling = Boolean(state?.isCompiling);
          return { content: [{ type: "text", text: `PlayMode: ${playMode}, compiling: ${compiling}` }] };
        }
        if (act === "info") {
          const result = await callUnity<{ projectName: string; unityVersion: string; dataPath: string } | null>("/editor/info", {});
          return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
        }
        if (act === "notify") {
          const result = await callUnity<{ shown: boolean } | null>("/editor/notify", args, 0);
          const shown = Boolean(result?.shown);
          return { content: [{ type: "text", text: shown ? "Shown" : "Not shown" }] };
        }
        if (act === "buildtarget") {
          await callUnity<null>("/editor/buildTarget", args);
          await waitForCompileIdle();
          return { content: [{ type: "text", text: "Build target switched" }] };
        }
        if (act === "prefsset") {
          const { key, prefType, stringValue, intValue, floatValue } = args as { key?: string; prefType?: string; stringValue?: string; intValue?: number; floatValue?: number };
          if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
          const payload = { key, type: prefType || "string", stringValue, intValue, floatValue };
          await callUnity("/prefs/set", payload);
          return { content: [{ type: "text", text: "PlayerPrefs set" }] };
        }
        if (act === "prefsget") {
          const { key, prefType } = args as { key?: string; prefType?: string };
          if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
          const res = await callUnity<Record<string, unknown> | null>("/prefs/get", { key, type: prefType || "string" });
          return { content: [{ type: "text", text: JSON.stringify(res ?? {}) }] };
        }
        if (act === "prefsdelete") {
          const { key } = args as { key?: string };
          if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
          await callUnity("/prefs/delete", { key });
          return { content: [{ type: "text", text: "PlayerPrefs key deleted" }] };
        }
        if (act === "prefsclear") {
          await callUnity("/prefs/clear", {});
          return { content: [{ type: "text", text: "PlayerPrefs cleared" }] };
        }
        if (act === "invoke") {
          const { typeName, methodName, isStatic, argsJson } = args as { typeName?: string; methodName?: string; isStatic?: boolean; argsJson?: string };
          if (!typeName || !methodName) return { content: [{ type: "text", text: "typeName and methodName required for invoke" }], isError: true };
          const res = await callUnity<Record<string, unknown> | { resultJson: string } | null>("/editor/invoke", { typeName, methodName, isStatic, argsJson });
          return { content: [{ type: "text", text: JSON.stringify(res ?? {}) }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_build",
      description: "Build player (fields: scenes[], target, outputPath, development)",
      inputSchema: {
        type: "object",
        properties: {
          scenes: { type: "array", items: { type: "string" }, description: "Optional explicit scene paths. Defaults to enabled EditorBuildSettings scenes." },
          target: { type: "string", description: "BuildTarget name (e.g., StandaloneWindows64, Android, iOS)." },
          outputPath: { type: "string", description: "Output path for build (file or folder depending on target)." },
          development: { type: "boolean", description: "If true, build in Development mode." },
        },
      },
      handler: async (args) => {
        const result = await callUnity<{ outputPath: string; result: string; error: string } | null>("/editor/build", args, 0);
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
      },
    },
    {
      name: "unity_scene",
      description: "Scene operations: open/save/saveAs, list loaded, create new/clean, or unload (action=open|save|saveAs|getLoaded|create|createClean|unload|clear)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'open', 'save', 'saveAs', 'getLoaded', 'create', 'createClean', 'unload', or 'clear'", enum: ["open", "save", "saveAs", "getLoaded", "create", "createClean", "unload", "clear"] },
          path: { type: "string", description: "Scene path for open/save/saveAs; also used by unload (path or scene name). For create, optional path to save new scene." },
          additive: { type: "boolean", description: "Open additively when action='open'. If false (default), replaces current scene." },
          clean: { type: "boolean", description: "For 'create' action, if true, creates a completely empty scene with no default objects." },
        },
      },
      handler: async (args) => {
        const { action, path, additive, clean } = args as { action?: string; path?: string; additive?: boolean; clean?: boolean };
        const act = String(action ?? "open").toLowerCase();

        if (act === "open") {
          // By default, open replaces current scene unless additive is true
          if (!additive) {
            // Unload all existing scenes first to ensure clean loading
            const loaded = await callUnity<{ scenes: string[] } | null>("/scene/getLoaded", {});
            if (loaded?.scenes && loaded.scenes.length > 0) {
            for (const scenePath of loaded.scenes) {
            try {
            await callUnity("/scene/unload", { path: scenePath });
            } catch {
            // Ignore errors if scene can't be unloaded
            }
            }
            }
          }
          await callUnity("/scene/open", { path, additive: additive ?? false });
          return { content: [{ type: "text", text: `Opened scene${additive ? " (additive)" : ""}` }] };
        }

        if (act === "save") {
          await callUnity("/scene/save", args);
          return { content: [{ type: "text", text: "Saved" }] };
        }

        if (act === "saveas") {
          await callUnity("/scene/saveAs", args);
          return { content: [{ type: "text", text: "Saved As" }] };
        }

        if (act === "getloaded") {
          const res = await callUnity<Record<string, unknown> | null>("/scene/getLoaded", {});
          return { content: [{ type: "text", text: JSON.stringify(res ?? {}) }] };
        }

        if (act === "create" || act === "createclean") {
          // Create new scene - if clean or createClean action, ensure it's empty
          const isClean = act === "createclean" || clean === true;

          // First, create the new scene
          await callUnity("/scene/create", { path });

          // If clean scene requested, remove all default objects
          if (isClean) {
            // Get all objects in the new scene
            const hierarchy = await callUnity<{ paths: string[] } | null>("/hierarchy/get", {});
            const objects = hierarchy?.paths || [];

            // Delete all objects to create a truly empty scene
            for (const objPath of objects) {
              try {
                await callUnity("/gameobject/delete", { path: objPath });
              } catch {
                // Ignore errors for objects that may have been deleted as children
              }
            }

            return { content: [{ type: "text", text: "Created clean empty scene" }] };
          }

          return { content: [{ type: "text", text: "Created new scene" }] };
        }

        if (act === "clear") {
          // Clear all objects from current scene without creating a new one
          const hierarchy = await callUnity<{ paths: string[] } | null>("/hierarchy/get", {});
          const objects = hierarchy?.paths || [];

          // Delete all root objects (children will be deleted automatically)
          const rootObjects = objects.filter(p => !p.includes('/'));
          for (const objPath of rootObjects) {
            try {
              await callUnity("/gameobject/delete", { path: objPath });
            } catch {
              // Ignore errors
            }
          }

          return { content: [{ type: "text", text: "Cleared all objects from scene" }] };
        }

        if (act === "unload") {
          await callUnity("/scene/unload", args);
          return { content: [{ type: "text", text: "Unloaded" }] };
        }

        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_prefab",
      description: "Prefab ops (action=apply|revert|create) for an instance by path or instanceId",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'apply' instance overrides back to prefab, 'revert' instance to prefab, or 'create' a prefab asset from a scene object.", enum: ["apply", "revert", "create"] },
          path: { type: "string", description: "Instance GameObject path or name (alternative to instanceId)." },
          instanceId: { type: "number", description: "Instance GameObject instance ID." },
          assetPath: { type: "string", description: "Target prefab asset path (e.g., 'Assets/Prefabs/My.prefab'). Optional when action='create'." },
          connect: { type: "boolean", description: "When action='create', connect the scene instance to the saved prefab." },
          overwrite: { type: "boolean", description: "When action='create', if false and file exists, auto-increment file name instead of overwriting." },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "apply").toLowerCase();
        if (act === "apply") { await callUnity("/prefab/apply", args); return { content: [{ type: "text", text: "Applied" }] }; }
        if (act === "revert") { await callUnity("/prefab/revert", args); return { content: [{ type: "text", text: "Reverted" }] }; }
        if (act === "create") {
          const res = await callUnity<{ path: string } | null>("/prefab/create", args);
          const saved = res?.path;
          if (!saved) return { content: [{ type: "text", text: "Failed to create prefab" }], isError: true };
          return { content: [{ type: "text", text: `Created prefab at ${saved}` }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_bake",
      description: "Bake operations (action=lighting). Extensible for navmesh/occlusion later.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Currently supports 'lighting' to start Lightmapping bake.", enum: ["lighting"] },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "lighting").toLowerCase();
        if (act === "lighting") { await callUnity("/bake/lighting", {}, 0); return { content: [{ type: "text", text: "Baking started" }] }; }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_profiler",
      description: "Profiler ops (action=memorySnapshot) to a given path",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Use 'memorySnapshot' to write a snapshot file (.snap).", enum: ["memorySnapshot"] },
          path: { type: "string", description: "Output file path for the snapshot (e.g., 'Snapshots/mem.snap')." },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "memorySnapshot").toLowerCase();
        if (act === "memorysnapshot") { await callUnity("/profiler/memorySnapshot", args, 0); return { content: [{ type: "text", text: "Snapshot requested" }] }; }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_import",
      description: "Set common import settings (currently textures) and reimport",
      inputSchema: {
        type: "object",
        properties: {
          assetPath: { type: "string", description: "Asset path in the project (e.g., 'Assets/Textures/Brick.png')." },
          textureType: { type: "string", description: "TextureImporterType, e.g., 'Default', 'NormalMap', 'Sprite'." },
          sRGB: { type: "boolean", description: "Treat as sRGB color texture." },
          maxSize: { type: "number", description: "Max texture size (e.g., 1024, 2048)." },
          compressionQuality: { type: "number", description: "Compression quality 0..100 (platform dependent)." },
          textureCompression: { type: "string", description: "TextureImporterCompression, e.g., 'Uncompressed', 'Compressed', 'CompressedHQ'." },
        },
      },
      handler: async (args) => {
        await callUnity("/import/set", args, 0);
        return { content: [{ type: "text", text: "Import settings applied" }] };
      },
    },
    {
      name: "unity_menu",
      description: "Execute Unity menu items (action=execute; menuPath required)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["execute"], description: "Only 'execute' supported" },
          menuPath: { type: "string", description: "Menu path, e.g., 'File/Save'" },
        },
        required: ["menuPath"],
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "execute").toLowerCase();
        if (act !== "execute") return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
        await callUnity("/menu/execute", args);
        return { content: [{ type: "text", text: "Executed" }] };
      },
    },
    {
      name: "unity_import",
      description: "Import a .unitypackage or copy any external file into Assets and refresh",
      inputSchema: {
        type: "object",
        properties: {
          // .unitypackage path
          filePath: { type: "string", description: "Path to file. If ends with .unitypackage, imports the package. Otherwise treated as a regular file to copy into Assets (alias for sourcePath)." },
          interactive: { type: "boolean", description: "When importing a .unitypackage, show Unity's import dialog (default false)." },
          // Generic file import
          sourcePath: { type: "string", description: "Absolute path to the source file on disk (used for non-.unitypackage files). If not set, filePath is used when not a .unitypackage." },
          destPath: { type: "string", description: "Optional project-relative path under Assets (e.g., 'Assets/Textures/My.png'). If omitted, uses destFolder + source file name." },
          destFolder: { type: "string", description: "Optional folder under Assets (e.g., 'Assets/Textures') when destPath is not provided." },
          overwrite: { type: "boolean", description: "Overwrite if destination exists (default false)" },
        },
      },
      handler: async (args) => {
        const { filePath, interactive, sourcePath, destPath, destFolder, overwrite } = args as { filePath?: string; interactive?: boolean; sourcePath?: string; destPath?: string; destFolder?: string; overwrite?: boolean };
        const trimmedFile = typeof filePath === "string" ? filePath.trim() : undefined;
        const isPackage = !!(trimmedFile && /\.unitypackage$/i.test(trimmedFile));

        // If a .unitypackage, use the package import endpoint
        if (isPackage) {
          try {
            await callUnity("/unitypackage/import", { path: trimmedFile, interactive: interactive === true }, 0);
            await callUnity("/assets/refresh", {});
            await waitForCompileIdle();
            return { content: [{ type: "text", text: `Imported: ${trimmedFile}` }] };
          } catch (err) {
            const msg = (err as Error).message || String(err);
            return { content: [{ type: "text", text: `Import failed: ${msg}` }], isError: true };
          }
        }

        // Otherwise, treat as a general file import (copy into Assets)
        const resolvedSource = sourcePath || trimmedFile;
        if (!resolvedSource) {
          return { content: [{ type: "text", text: "Provide filePath (.unitypackage) or sourcePath (general file)." }], isError: true };
        }
        try {
          const payload = { sourcePath: resolvedSource.trim(), destPath, destFolder, overwrite: overwrite === true };
          const res = await callUnity<{ path: string }>("/assets/importFile", payload, 0);
          const importedPath = res?.path || payload.destPath || "";
          await callUnity("/assets/refresh", {});
          await waitForCompileIdle();
          return { content: [{ type: "text", text: importedPath ? `Imported: ${importedPath}` : "Imported" }] };
        } catch (err) {
          const msg = (err as Error).message || String(err);
          return { content: [{ type: "text", text: `Import failed: ${msg}` }], isError: true };
        }
      }
    },


    {
      name: "unity_tests",
      description: "Run Unity Test Framework tests (action=run; mode EditMode|PlayMode, filter?)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["run"] },
          mode: { type: "string", description: "EditMode or PlayMode" },
          filter: { type: "string", description: "Optional test filter" },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "run").toLowerCase();
        if (act !== "run") return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
        const result = await callUnity<{ passed: number; failed: number; durationMs: number; reportPath: string } | null>("/tests/run", args, 0);
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
      },
    },
    {
      name: "unity_rendering",
      description: "Unified rendering operations: lights, cameras, materials (action=createLight|createCamera|createMaterial|setLightProperty|setCameraProperty)",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Rendering action to perform",
            enum: ["createLight", "createCamera", "createMaterial", "setLightProperty", "setCameraProperty"]
          },
          // Common properties
          name: { type: "string", description: "GameObject/Asset name" },
          path: { type: "string", description: "GameObject path for property updates" },
          position: { type: "object", description: "Position {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          rotation: { type: "object", description: "Rotation {x, y, z}", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },

          // Light properties
          lightType: { type: "string", description: "Light type: 'Directional', 'Point', 'Spot', 'Area'", enum: ["Directional", "Point", "Spot", "Area"] },
          intensity: { type: "number", description: "Light intensity" },
          range: { type: "number", description: "Light range (Point/Spot)" },
          spotAngle: { type: "number", description: "Spot light angle" },

          // Camera properties
          fieldOfView: { type: "number", description: "Camera field of view" },
          orthographic: { type: "boolean", description: "Orthographic camera mode" },
          orthographicSize: { type: "number", description: "Orthographic size" },
          nearClip: { type: "number", description: "Near clipping plane" },
          farClip: { type: "number", description: "Far clipping plane" },
          clearFlags: { type: "string", description: "Clear flags: 'Skybox', 'SolidColor', 'DepthOnly', 'Nothing'" },

          // Material properties
          shader: { type: "string", description: "Shader name (e.g., 'Standard', 'Unlit/Color')" },
          assetPath: { type: "string", description: "Optional asset path for saving material (e.g., 'Assets/Materials/Test.mat')" },
          propertyName: { type: "string", description: "Material property name" },
          // Removed propertyValue as 'any' type is not valid in JSON Schema
          color: { type: "object", description: "Color {r, g, b, a}", properties: { r: { type: "number" }, g: { type: "number" }, b: { type: "number" }, a: { type: "number" } } },
          texturePath: { type: "string", description: "Texture asset path" },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "createLight").toLowerCase();

        // Light operations
        if (act === "createlight") {
          type LightCreateArgs = { name?: string; lightType?: string; position?: Vector3; rotation?: Vector3; intensity?: number; color?: Color };
const { name, lightType, position, rotation, intensity, color } = args as LightCreateArgs;
          if (!name || !position) return { content: [{ type: "text", text: "Name and position required for light" }], isError: true };

          await callUnity("/gameobject/create", { name, position, ...(rotation && { eulerAngles: rotation }) });

          const fields: Record<string, unknown> = {};
          if (lightType) {
            const typeMap: Record<string, number> = { "Directional": 1, "Point": 2, "Spot": 0, "Area": 3 };
            fields.type = typeMap[lightType] ?? 1;
          }
          if (intensity !== undefined) fields.intensity = intensity;
          if (color) fields.color = color;

          await callUnity("/component/addOrUpdate", {
            path: name,
            componentType: "Light",
            fieldsJson: JSON.stringify(fields)
          });
          return { content: [{ type: "text", text: `Created ${lightType ?? 'Directional'} light: ${name}` }] };
        }

        // Camera operations
        if (act === "createcamera") {
          type CameraCreateArgs = { name?: string; position?: Vector3; rotation?: Vector3; fieldOfView?: number; orthographic?: boolean };
const { name, position, rotation, fieldOfView, orthographic } = args as CameraCreateArgs;
          if (!name || !position) return { content: [{ type: "text", text: "Name and position required for camera" }], isError: true };

          await callUnity("/gameobject/create", { name, position, ...(rotation && { eulerAngles: rotation }) });

          const fields: Record<string, unknown> = {};
          if (fieldOfView !== undefined) fields.fieldOfView = fieldOfView;
          if (orthographic !== undefined) fields.orthographic = orthographic;

          await callUnity("/component/addOrUpdate", {
            path: name,
            componentType: "Camera",
            fieldsJson: JSON.stringify(fields)
          });
          return { content: [{ type: "text", text: `Created camera: ${name}` }] };
        }

        // Material operations (create only; property updates not exposed by bridge yet)
        if (act === "creatematerial") {
          const { name, shader, color, assetPath } = args as { name?: string; shader?: string; color?: Color; assetPath?: string };
          if (!name) return { content: [{ type: "text", text: "Material name required" }], isError: true };
          const payload: Record<string, unknown> = { name };
          if (shader) payload.shader = shader;
          if (color) payload.color = color;
          if (assetPath) payload.assetPath = assetPath;

          const res = await callUnity<{ path?: string; message?: string } | null>("/material/create", payload);
          const msg = res?.path ? `Created material ${name} at ${res.path}` : (res?.message ?? `Created material ${name}`);
          return { content: [{ type: "text", text: msg }] };
        }

        // Property setters
        if (act === "setlightproperty") {
          type LightSetArgs = { path?: string; name?: string; intensity?: number; color?: Color };
const { path, name, intensity, color } = args as LightSetArgs;
          const targetPath = path || name;
          if (!targetPath) return { content: [{ type: "text", text: "Path or name required" }], isError: true };

          const fields: Record<string, unknown> = {};
          if (intensity !== undefined) fields.intensity = intensity;
          if (color) fields.color = color;

          await callUnity("/component/addOrUpdate", {
            path: targetPath,
            componentType: "Light",
            fieldsJson: JSON.stringify(fields)
          });
          return { content: [{ type: "text", text: `Updated light properties on ${targetPath}` }] };
        }

        if (act === "setcameraproperty") {
          type CameraSetArgs = { path?: string; name?: string; fieldOfView?: number; orthographic?: boolean };
const { path, name, fieldOfView, orthographic } = args as CameraSetArgs;
          const targetPath = path || name;
          if (!targetPath) return { content: [{ type: "text", text: "Path or name required" }], isError: true };

          const fields: Record<string, unknown> = {};
          if (fieldOfView !== undefined) fields.fieldOfView = fieldOfView;
          if (orthographic !== undefined) fields.orthographic = orthographic;

          await callUnity("/component/addOrUpdate", {
            path: targetPath,
            componentType: "Camera",
            fieldsJson: JSON.stringify(fields)
          });
          return { content: [{ type: "text", text: `Updated camera properties on ${targetPath}` }] };
        }

        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_gameplay",
      description: "Gameplay components: physics and tags/layers (action=addRigidbody|addCollider|setGravity|setMass|setTag|setLayer)",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Gameplay action to perform",
            enum: ["addRigidbody", "addCollider", "setGravity", "setMass", "setTag", "setLayer"]
          },
          path: { type: "string", description: "GameObject path or name" },

          // Physics properties
          colliderType: { type: "string", description: "Collider type: 'Box', 'Sphere', 'Capsule', 'Mesh'", enum: ["Box", "Sphere", "Capsule", "Mesh"] },
          useGravity: { type: "boolean", description: "Enable/disable gravity on Rigidbody" },
          mass: { type: "number", description: "Mass value for Rigidbody" },
          isKinematic: { type: "boolean", description: "Set Rigidbody as kinematic" },
          isTrigger: { type: "boolean", description: "Set collider as trigger" },

          // Tag/Layer properties
          tag: { type: "string", description: "Tag name (e.g., 'Player', 'Enemy', 'Checkpoint')" },
          layer: { type: "number", description: "Layer index (0-31)" },
        },
      },
      handler: async (args) => {
        const { action, path } = args as { action?: string; path?: string };
        const act = String(action ?? "addRigidbody").toLowerCase();

        if (!path) return { content: [{ type: "text", text: "GameObject path required" }], isError: true };

        // Physics actions
        if (act === "addrigidbody") {
          const { useGravity, mass, isKinematic } = args as { useGravity?: boolean; mass?: number; isKinematic?: boolean };
          const fields: Record<string, unknown> = {};
          if (useGravity !== undefined) fields.useGravity = useGravity;
          if (mass !== undefined) fields.mass = mass;
          if (isKinematic !== undefined) fields.isKinematic = isKinematic;

          await callUnity("/component/addOrUpdate", {
            path,
            componentType: "Rigidbody",
            fieldsJson: fields ? JSON.stringify(fields) : undefined
          });
          return { content: [{ type: "text", text: `Added Rigidbody to ${path}` }] };
        }

        if (act === "addcollider") {
          const { colliderType, isTrigger } = args as { colliderType?: string; isTrigger?: boolean };
          const type = colliderType ?? "Box";
          const componentType = `${type}Collider`;

          const fields: Record<string, unknown> = {};
          if (isTrigger !== undefined) fields.isTrigger = isTrigger;

          await callUnity("/component/addOrUpdate", {
            path,
            componentType,
            fieldsJson: fields ? JSON.stringify(fields) : undefined
          });
          return { content: [{ type: "text", text: `Added ${componentType} to ${path}` }] };
        }

        if (act === "setgravity") {
          const { useGravity } = args as { useGravity?: boolean };
          await callUnity("/component/addOrUpdate", {
            path,
            componentType: "Rigidbody",
            fieldsJson: JSON.stringify({ useGravity })
          });
          return { content: [{ type: "text", text: `Set gravity to ${useGravity} on ${path}` }] };
        }

        if (act === "setmass") {
          const { mass } = args as { mass?: number };
          if (mass === undefined) return { content: [{ type: "text", text: "Mass value required" }], isError: true };
          await callUnity("/component/addOrUpdate", {
            path,
            componentType: "Rigidbody",
            fieldsJson: JSON.stringify({ mass })
          });
          return { content: [{ type: "text", text: `Set mass to ${mass} on ${path}` }] };
        }

        // Tag/Layer actions
        if (act === "settag") {
          const { tag } = args as { tag?: string };
          if (!tag) return { content: [{ type: "text", text: "Tag required" }], isError: true };
          await callUnity("/gameobject/setProperties", { path, tag });
          return { content: [{ type: "text", text: `Set tag '${tag}' on ${path}` }] };
        }

        if (act === "setlayer") {
          const { layer } = args as { layer?: number };
          if (layer === undefined) return { content: [{ type: "text", text: "Layer required" }], isError: true };
          await callUnity("/gameobject/setProperties", { path, layer });
          return { content: [{ type: "text", text: `Set layer ${layer} on ${path}` }] };
        }

        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
      },
    },
    {
      name: "unity_code",
      description: "Code and scripting operations (action=writeFile|createScript|attachScript|compile)",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Code operation to perform",
            enum: ["writeFile", "createScript", "attachScript", "compile"]
          },
          path: { type: "string", description: "File path for writeFile, or GameObject path for attachScript" },
          content: { type: "string", description: "File or script content" },
          scriptContent: { type: "string", description: "Script content (alias for content)" },
          className: { type: "string", description: "C# class name for createScript/attachScript" },
          scriptPath: { type: "string", description: "Script file path (e.g., 'Assets/Scripts/CarController.cs')" },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "writeFile").toLowerCase();

        // Helper function to write a file to Unity project
        async function writeUnityFile(filePath: string, fileContent: string): Promise<void> {
          // Ensure the path starts with Assets/
          const assetPath = filePath.startsWith("Assets/") ? filePath : `Assets/${filePath}`;

          // Get Unity project info to construct absolute path
          const infoResult = await callUnity<{ projectName: string; unityVersion: string; dataPath: string } | null>("/editor/info", {});
          if (!infoResult || !infoResult.dataPath) {
            throw new Error("Could not get Unity project path");
          }

          // Build absolute path
          const projectPath = infoResult.dataPath.replace(/[\\]/g, '/').replace(/\/Assets$/, '');
          const absolutePath = `${projectPath}/${assetPath}`.replace(/\/+/g, '/');
          const absoluteDir = absolutePath.substring(0, absolutePath.lastIndexOf('/'));

          // Create directory using System.IO.Directory with explicit assembly
          await callUnity("/editor/invoke", {
            typeName: "System.IO.Directory",
            methodName: "CreateDirectory",
            isStatic: true,
            argsJson: JSON.stringify([absoluteDir])
          }).catch(() => {
            // Directory might exist, continue
          });

          // Write file using System.IO.File (no explicit assembly) and UTF8 encoding
          await callUnity("/editor/invoke", {
            typeName: "System.IO.File",
            methodName: "WriteAllText",
            isStatic: true,
            argsJson: JSON.stringify([absolutePath, fileContent])
          });

          // Refresh assets if it's a script
          if (assetPath.endsWith('.cs')) {
            await callUnity("/assets/refresh", {});
            await waitForCompileIdle();
          }
        }

        if (act === "writefile") {
          const { path, content } = args as { path?: string; content?: string };
          if (!path || !content) return errorResponse("Path and content required");

          try {
            await writeUnityFile(path, content);
            const assetPath = path.startsWith("Assets/") ? path : `Assets/${path}`;
            return successResponse(`Created file: ${assetPath}`);
          } catch (error) {
            const errorMsg = (error as Error).message || String(error);
            return errorResponse(`Failed to write file: ${errorMsg}`);
          }
        }

        if (act === "createscript") {
          const { scriptPath, className, content, scriptContent: scriptContentParam } = args as { scriptPath?: string; className?: string; content?: string; scriptContent?: string };
          if (!scriptPath) return await errorResponseWithConsoleCheck("scriptPath required");

          // Use scriptContent parameter if provided, otherwise use content parameter
          const finalContent = scriptContentParam || content;

          // Extract class name from script path if not provided
          const derivedClassName = className || scriptPath.replace(/^.*\//, '').replace(/\.cs$/, '');

          // Generate default content if not provided
          const scriptContent = finalContent || `using UnityEngine;

public class ${derivedClassName} : MonoBehaviour
{
    void Start()
    {
        Debug.Log("${derivedClassName} started!");
    }

    void Update()
    {

    }
}`;

          try {
            // Ensure the path ends with .cs
            let assetPath = scriptPath;
            if (!assetPath.endsWith('.cs')) {
              assetPath += '.cs';
            }

            await writeUnityFile(assetPath, scriptContent);

            // Refresh asset database to ensure Unity recognizes the new script
            await callUnity("/assets/refresh", {});

            // Wait for compilation to complete
            await waitForCompileIdle(30000); // 30 second timeout for script compilation

            const finalAssetPath = assetPath.startsWith("Assets/") ? assetPath : `Assets/${assetPath}`;
            return await successResponseWithConsoleCheck(`📝 Created script: ${finalAssetPath}`);
          } catch (error) {
            const errorMsg = (error as Error).message || String(error);
            return await errorResponseWithConsoleCheck(`Failed to create script: ${errorMsg}`);
          }
        }

        if (act === "attachscript") {
          const { path, className } = args as { path?: string; className?: string };
          if (!path || !className) return await errorResponseWithConsoleCheck("path and className required");

          try {
            await callUnity("/component/addOrUpdate", {
              path,
              componentType: className
            });
            return await successResponseWithConsoleCheck(`🔗 Attached ${className} to ${path}`);
          } catch (error) {
            const errorMsg = (error as Error).message || String(error);
            return await errorResponseWithConsoleCheck(`Failed to attach script: ${errorMsg}`);
          }
        }

        if (act === "compile") {
          try {
            // Force Unity to recompile scripts
            await callUnity("/assets/refresh", {});
            await waitForCompileIdle();
            return await successResponseWithConsoleCheck("🔨 Compilation completed");
          } catch (error) {
            const errorMsg = (error as Error).message || String(error);
            return await errorResponseWithConsoleCheck(`Compilation failed: ${errorMsg}`);
          }
        }

        return await errorResponseWithConsoleCheck(`Unknown action: ${act}`);
      },
    },
    {
      name: "unity_visualscripting",
      description: "Visual Scripting tools: create visual scripts, add nodes, connect nodes, and generate from MCP operations",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "addNode", "connectNodes", "getGraph", "generateFromMcp"],
            description: "Visual scripting operation to perform"
          },
          gameObjectPath: {
            type: "string",
            description: "Path to the GameObject (e.g., 'Player' or 'Environment/Terrain')"
          },
          scriptName: {
            type: "string",
            description: "Name for the visual script (optional, auto-generated if not provided)"
          },
          templateType: {
            type: "string",
            enum: ["empty", "state", "flow", "custom"],
            description: "Template type for new visual scripts"
          },
          mcpOperations: {
            type: "array",
            items: { type: "string" },
            description: "Array of MCP operation descriptions for script generation"
          },
          nodeType: {
            type: "string",
            enum: ["event", "action", "condition", "variable", "mcp_operation"],
            description: "Type of node to add"
          },
          nodeData: {
            type: "string",
            description: "JSON data or description for the node"
          },
          position: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              z: { type: "number" }
            },
            description: "Position of the node in the graph"
          },
          nodeId: {
            type: "string",
            description: "Custom node ID (optional, auto-generated if not provided)"
          },
          fromNodeId: {
            type: "string",
            description: "Source node ID for connections"
          },
          fromPortName: {
            type: "string",
            description: "Source port name for connections"
          },
          toNodeId: {
            type: "string",
            description: "Target node ID for connections"
          },
          toPortName: {
            type: "string",
            description: "Target port name for connections"
          },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                action: { type: "string" },
                // parameters can be a JSON string; server will stringify objects before sending to the bridge
                parameters: { type: "string" },
                description: { type: "string" },
                order: { type: "number" },
                nodeType: { type: "string" },
                position: {
                  type: "object",
                  properties: {
                    x: { type: "number" }, y: { type: "number" }, z: { type: "number" }
                  }
                },
                groupName: { type: "string" },
                comment: { type: "string" },
                color: { type: "string" },
                variable: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    initialValue: {}
                  }
                },
                ports: {
                  type: "object",
                  properties: { from: { type: "string" }, to: { type: "string" } }
                }
              }
            },
            description: "Array of MCP operations to convert to visual script nodes"
          },
          autoConnect: {
            type: "boolean",
            description: "Whether to automatically connect nodes in sequence"
          },
          includeConnections: {
            type: "boolean",
            description: "Whether to include connection information when getting graph"
          },
          includeNodeData: {
            type: "boolean",
            description: "Whether to include detailed node data when getting graph"
          }
        },
        required: ["action", "gameObjectPath"]
      },
      handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const { action, gameObjectPath, scriptName, templateType, mcpOperations,
                nodeType, nodeData, position, nodeId, fromNodeId, fromPortName,
                toNodeId, toPortName, operations, autoConnect, includeConnections,
                includeNodeData } = args;

        try {
          switch (action) {
            case "create": {
              const result = await callUnity<VisualScriptResponse>("/visualscripting/create", {
                gameObjectPath,
                scriptName,
                templateType: templateType || "empty",
                mcpOperations: mcpOperations || []
              });

              if (result) {
                return successResponse(
                  `Visual script '${result.scriptName}' created successfully on ${gameObjectPath}.\n` +
                  `Generated ${result.nodes?.length || 0} nodes and ${result.connections?.length || 0} connections.\n` +
                  `Message: ${result.message}`
                );
              } else {
                return errorResponse(`Failed to create visual script`);
              }
            }

            case "addNode": {
              if (!nodeType) {
                return errorResponse("nodeType is required for addNode action");
              }

              const result = await callUnity<VisualScriptResponse>("/visualscripting/addNode", {
                gameObjectPath,
                nodeType,
                nodeData: nodeData || "",
                position: position || { x: 0, y: 0, z: 0 },
                nodeId
              });

              if (result) {
                return successResponse(
                  `Node '${nodeType}' added successfully to visual script on ${gameObjectPath}.\n` +
                  `Node ID: ${result.nodes?.[0]?.nodeId}\n` +
                  `Message: ${result.message}`
                );
              } else {
                return errorResponse(`Failed to add node`);
              }
            }

            case "connectNodes": {
              if (!fromNodeId || !toNodeId || !fromPortName || !toPortName) {
                return errorResponse("fromNodeId, toNodeId, fromPortName, and toPortName are required for connectNodes action");
              }

              const result = await callUnity<VisualScriptResponse>("/visualscripting/connectNodes", {
                gameObjectPath,
                fromNodeId,
                fromPortName,
                toNodeId,
                toPortName
              });

              if (result) {
                return successResponse(
                  `Nodes connected successfully in visual script on ${gameObjectPath}.\n` +
                  `Connection: ${fromNodeId}.${fromPortName} -> ${toNodeId}.${toPortName}\n` +
                  `Message: ${result.message}`
                );
              } else {
                return errorResponse(`Failed to connect nodes`);
              }
            }

            case "getGraph": {
              const result = await callUnity<VisualScriptResponse>("/visualscripting/getGraph", {
                gameObjectPath,
                includeConnections: includeConnections !== false,
                includeNodeData: includeNodeData !== false
              });

              if (result) {
                return successResponse(
                  `Visual script graph retrieved from ${gameObjectPath}:\n` +
                  `Nodes: ${result.nodes?.length || 0}\n` +
                  `Connections: ${result.connections?.length || 0}\n` +
                  `Graph data: ${JSON.stringify(result, null, 2)}`
                );
              } else {
                return errorResponse(`Failed to get graph`);
              }
            }

            case "generateFromMcp": {
              if (!operations || !Array.isArray(operations)) {
                return errorResponse("operations array is required for generateFromMcp action");
              }

              // Ensure parameters are JSON strings; pass through extra metadata fields
              const ops = operations.map((op: Record<string, unknown>) => ({
                ...op,
                parameters: typeof op.parameters === "string" ? op.parameters : JSON.stringify(op.parameters ?? {})
              }));

              const result = await callUnity<VisualScriptResponse>("/visualscripting/generateFromMcp", {
                gameObjectPath,
                scriptName: scriptName || `${String(gameObjectPath).replace(/[^a-zA-Z0-9]/g, '_')}_MCPScript`,
                operations: ops,
                autoConnect: autoConnect !== false
              });

              if (result) {
                return successResponse(
                  `Visual script '${result.scriptName}' generated from MCP operations on ${gameObjectPath}.\n` +
                  `Generated ${result.nodes?.length || 0} nodes and ${result.connections?.length || 0} connections.\n` +
                  `Operations processed: ${operations.length}\n` +
                  `Message: ${result.message}`
                );
              } else {
                return errorResponse(`Failed to generate visual script from MCP`);
              }
            }

            default:
              return errorResponse(`Unknown visual scripting action: ${action}`);
          }
        } catch (error) {
          return errorResponse(`Visual scripting operation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    {
      name: "unity_visualscripting_templates",
      description: "Visual Scripting template management: browse, search, and apply predefined workflow templates",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "search", "get", "apply", "categories", "tags"],
            description: "Template operation to perform"
          },
          category: {
            type: "string",
            description: "Filter templates by category"
          },
          tag: {
            type: "string",
            description: "Filter templates by tag"
          },
          query: {
            type: "string",
            description: "Search query for templates"
          },
          templateName: {
            type: "string",
            description: "Name of the template to get or apply"
          },
          gameObjectPath: {
            type: "string",
            description: "Path to the GameObject for template application"
          },
          customizations: {
            type: "object",
            description: "Custom parameters to override template defaults"
          }
        },
        required: ["action"]
      },
      handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const { action, category, tag, query, templateName, gameObjectPath, customizations } = args as { action?: string; category?: string; tag?: string; query?: string; templateName?: string; gameObjectPath?: string; customizations?: Record<string, unknown> };

        try {
          switch (action) {
            case "list": {
              let templates = Object.values(VISUAL_SCRIPT_TEMPLATES);

              if (category) {
                templates = getTemplatesByCategory(String(category));
              } else if (tag) {
                templates = getTemplatesByTag(String(tag));
              }

              const templateList = templates.map(t => ({
                name: t.name,
                description: t.description,
                category: t.category,
                tags: t.tags,
                operationCount: t.mcpOperations.length
              }));

              return successResponse(
                `Found ${templateList.length} visual scripting templates:\n\n` +
                templateList.map(t =>
                  `• ${t.name} (${t.category})\n` +
                  `  ${t.description}\n` +
                  `  Operations: ${t.operationCount}, Tags: ${t.tags.join(', ')}\n`
                ).join('\n')
              );
            }

            case "search": {
              if (!query) {
                return errorResponse("query is required for search action");
              }

              const templates = searchTemplates(String(query));
              const templateList = templates.map(t => ({
                name: t.name,
                description: t.description,
                category: t.category,
                tags: t.tags,
                operationCount: t.mcpOperations.length
              }));

              return successResponse(
                `Found ${templateList.length} templates matching "${query}":\n\n` +
                templateList.map(t =>
                  `• ${t.name} (${t.category})\n` +
                  `  ${t.description}\n` +
                  `  Operations: ${t.operationCount}, Tags: ${t.tags.join(', ')}\n`
                ).join('\n')
              );
            }

            case "get": {
              if (!templateName) {
                return errorResponse("templateName is required for get action");
              }

              const template = VISUAL_SCRIPT_TEMPLATES[String(templateName)];
              if (!template) {
                return errorResponse(`Template '${templateName}' not found`);
              }

              return successResponse(
                `Template: ${template.name}\n` +
                `Description: ${template.description}\n` +
                `Category: ${template.category}\n` +
                `Tags: ${template.tags.join(', ')}\n` +
                `Auto-connect: ${template.autoConnect}\n` +
                `Operations (${template.mcpOperations.length}):\n\n` +
                template.mcpOperations.map((op, i) =>
                  `${i + 1}. ${op.description}\n` +
                  `   Tool: ${op.tool}, Action: ${op.action}\n` +
                  `   Parameters: ${JSON.stringify(op.parameters, null, 2)}\n`
                ).join('\n')
              );
            }

            case "apply": {
              if (!templateName || !gameObjectPath || typeof gameObjectPath !== 'string') {
                return errorResponse("templateName and gameObjectPath are required for apply action");
              }

              const template = VISUAL_SCRIPT_TEMPLATES[templateName];
              if (!template) {
                return errorResponse(`Template '${templateName}' not found`);
              }

              // Apply customizations if provided
              let operations = template.mcpOperations;
              if (customizations) {
                operations = operations.map(op => ({
                  ...op,
                  parameters: { ...op.parameters, ...customizations }
                }));
              }

              // Generate visual script from template
              const ops = operations.map((op) => ({
                ...op,
                parameters: typeof op.parameters === "string" ? op.parameters : JSON.stringify(op.parameters ?? {})
              }));
              const response = await callUnity("/visualscripting/generateFromMcp", {
                gameObjectPath,
                scriptName: `${templateName}_${gameObjectPath.replace(/[^a-zA-Z0-9]/g, '_')}`,
                operations: ops,
                autoConnect: template.autoConnect
              }) as UnityResponse<VisualScriptResponse>;

              if (response.ok && response.result) {
                const result = response.result;
                return successResponse(
                  `Template '${templateName}' applied successfully to ${gameObjectPath}!\n` +
                  `Visual script '${result.scriptName}' created with:\n` +
                  `• ${result.nodes?.length || 0} nodes\n` +
                  `• ${result.connections?.length || 0} connections\n` +
                  `• ${operations.length} MCP operations\n\n` +
                  `Message: ${result.message}`
                );
              } else {
                return errorResponse(`Failed to apply template: ${response.error}`);
              }
            }

            case "categories": {
              const categories = getAllCategories();
              return successResponse(
                `Available template categories (${categories.length}):\n\n` +
                categories.map(cat => {
                  const count = getTemplatesByCategory(cat).length;
                  return `• ${cat} (${count} templates)`;
                }).join('\n')
              );
            }

            case "tags": {
              const tags = getAllTags();
              return successResponse(
                `Available template tags (${tags.length}):\n\n` +
                tags.map(tag => {
                  const count = getTemplatesByTag(tag).length;
                  return `• ${tag} (${count} templates)`;
                }).join('\n')
              );
            }

            default:
              return errorResponse(`Unknown template action: ${action}`);
          }
        } catch (error) {
          return errorResponse(`Template operation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
  ];

  // Canonicalize: lowercase and normalize dots to underscores (tools are underscore-only)
  const canonicalize = (name: string) => name.toLowerCase().replace(/\./g, "_");
  const toolByCanonical = new Map<string, ToolDef>();
  for (const t of tools) {
    toolByCanonical.set(canonicalize(t.name), t);
  }

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Ensure descriptions are always present for clients that rely on non-optional field
    return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema })) } as unknown as ReturnType<typeof ListToolsResultSchema["parse"]>;
  });

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req: ReturnType<typeof CallToolRequestSchema["parse"]>) => {
    const requestedName = (req.params.name ?? "");
    const canonRequested = canonicalize(requestedName);
    const tool = toolByCanonical.get(canonRequested);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // No aliasing; tools use underscore names only.

    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${requestedName}` }], isError: true } as unknown as ReturnType<typeof CompatibilityCallToolResultSchema["parse"]>;
    }

    try {
      const result = await tool.handler(args);
      return result as unknown as ReturnType<typeof CompatibilityCallToolResultSchema["parse"]>;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true } as unknown as ReturnType<typeof CompatibilityCallToolResultSchema["parse"]>;
    }
  });

  // resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "unity://logs",
          name: "Unity Logs",
          description: "Unity Editor logs via MCP bridge",
          mimeType: "text/plain",
        },
      ],
    } as unknown as ReturnType<typeof ListResourcesResultSchema["parse"]>;
  });

  // resources/templates/list (none)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] } as unknown as ReturnType<typeof ListResourceTemplatesResultSchema["parse"]>;
  });

  // resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (req: ReturnType<typeof ReadResourceRequestSchema["parse"]>) => {
    if (req.params.uri !== "unity://logs") {
      return { contents: [] } as unknown as ReturnType<typeof ReadResourceResultSchema["parse"]>;
    }
    const text = await getUnityText("/logs/read", 10_000).catch(() => "");
    return {
      contents: [
        {
          uri: req.params.uri,
          mimeType: "text/plain",
          text,
        },
      ],
    } as unknown as ReturnType<typeof ReadResourceResultSchema["parse"]>;
  });

  return server;
}

export async function main() {
  const server = getServer();

  if (!process.env.UNITY_BRIDGE_TOKEN) {
    console.warn("[unity-mcp] UNITY_BRIDGE_TOKEN not set; the bridge will accept unauthenticated requests on 127.0.0.1. Set a token in both Unity and server env for security.");
  }

  // Subscribe to Unity SSE logs and emit resource updated notifications for unity://logs
  try {
    const sseHeaders: Record<string, string> = {};
    const token = process.env.UNITY_BRIDGE_TOKEN;
    if (token) sseHeaders["X-Unity-Bridge-Token"] = token;
    const es = new EventSource(`${UNITY_BASE_URL}/logs/stream`, { headers: sseHeaders });
    let queued = false;
    es.onmessage = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        try {
          // Notify subscribers that logs resource updated

          server.sendResourceUpdated({ uri: "unity://logs" });
        } catch (e) { if (DEBUG) { console.warn(`[unity-mcp] sendResourceUpdated failed: ${e instanceof Error ? e.message : String(e)}`); } }
      }, 500);
    };
    es.onerror = () => {
      // ignore transient errors
    };
  } catch {
    // ignore if SSE not available
  }

  // stdio transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

if (process.env.MCP_NO_MAIN !== "1") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}


