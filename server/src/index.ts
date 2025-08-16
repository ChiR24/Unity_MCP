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

// Common response helper functions
function successResponse(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResponse(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResponse(data: unknown): ToolResult {
  return successResponse(JSON.stringify(data ?? {}));
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
      if (DEBUG) { try { console.log(`[unity-mcp] POST ${path} ok in ${Date.now() - start}ms`); } catch {} }
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
      if (DEBUG) { try { console.warn(`[unity-mcp] POST ${path} attempt ${attempt}/${maxAttempts} failed: ${msg}`); } catch {} }
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
      const msg = String((err as any)?.message || err);
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
          return { content: [{ type: "text", text: "Cleared" }] };
        }
        const result = await callUnity<{ text: string } | null>("/console/read", {});
        const text = result?.text && typeof result.text === "string" ? result.text : "";
        return { content: [{ type: "text", text }] };
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
          await callUnity("/play/start", {});
          return { content: [{ type: "text", text: "Playing" }] };
        }
        if (act === "stop") {
          await callUnity("/play/stop", {});
          return { content: [{ type: "text", text: "Stopped" }] };
        }
        if (act === "pause") {
          await callUnity("/play/pause", { pause: true });
          return { content: [{ type: "text", text: "Paused" }] };
        }
        if (act === "resume") {
          await callUnity("/play/pause", { pause: false });
          return { content: [{ type: "text", text: "Resumed" }] };
        }
        return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
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
      description: "AssetDatabase operations: list assets, find by query, or refresh the database (action=list|find|refresh)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'list' all assets under a folder, 'find' by AssetDatabase query, or 'refresh' AssetDatabase", enum: ["list", "find", "refresh"] },
          path: { type: "string", description: "Folder path under Assets to search/list (e.g., 'Assets' or 'Assets/Prefabs'). Optional (list)." },
          query: { type: "string", description: "AssetDatabase search filter for 'find' (e.g., 't:Prefab', 't:Material myName')." },
        },
      },
      handler: unityAssetsHandler,
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
          const { primitiveType, name, position, localPosition, localScale, scale, localEulerAngles, ...rest } = args as Record<string, unknown>;
          
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
          const { path, instanceId, name, targetName, ...rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ...rest };
          if (instanceId !== undefined) payload.instanceId = instanceId;
          if (path !== undefined) payload.path = path;
          else if (targetName !== undefined) payload.path = targetName;
          else if (name !== undefined && (act === "get")) payload.path = name; // legacy alias
          const result = await callUnity<{ instanceId: number; path: string; name: string; active: boolean; tag: string; layer: number; position: {x:number;y:number;z:number}; localPosition: {x:number;y:number;z:number}; eulerAngles: {x:number;y:number;z:number}; localEulerAngles: {x:number;y:number;z:number}; localScale: {x:number;y:number;z:number} } | null>("/gameobject/getProperties", payload);
          return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
        }
        if (act === "set") {
          const { path, name, instanceId, components, ...rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ...rest };
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
          const { path, instanceId, name, ...rest } = args as Record<string, unknown>;
          const payload: Record<string, unknown> = { ...rest };
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
          const result = await callUnity<{ } | null>("/editor/buildTarget", args);
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
      description: "Prefab ops (action=apply|revert) for an instance by path or instanceId",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "'apply' instance overrides back to prefab, or 'revert' instance to prefab.", enum: ["apply", "revert"] },
          path: { type: "string", description: "Instance GameObject path or name (alternative to instanceId)." },
          instanceId: { type: "number", description: "Instance GameObject instance ID." },
        },
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "apply").toLowerCase();
        if (act === "apply") { await callUnity("/prefab/apply", args); return { content: [{ type: "text", text: "Applied" }] }; }
        if (act === "revert") { await callUnity("/prefab/revert", args); return { content: [{ type: "text", text: "Reverted" }] }; }
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
      name: "unity_asset",
      description: "Instantiate assets into the scene (action=instantiate)",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["instantiate"] },
          assetPath: { type: "string", description: "Asset path in project (e.g., 'Assets/Prefabs/Cube.prefab')" },
          parentPath: { type: "string", description: "Optional parent GameObject path" },
        },
        required: ["assetPath"],
      },
      handler: async (args) => {
        const { action } = args as { action?: string };
        const act = String(action ?? "instantiate").toLowerCase();
        if (act !== "instantiate") return { content: [{ type: "text", text: `Unknown action: ${act}` }], isError: true };
        const res = await callUnity<{ path: string; instanceId: number }>("/asset/instantiate", args);
        return { content: [{ type: "text", text: `Instantiated ${res.path} (id ${res.instanceId})` }] };
      },
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
          const { name, lightType, position, rotation, intensity, color } = args as any;
          if (!name || !position) return { content: [{ type: "text", text: "Name and position required for light" }], isError: true };
          
          await callUnity("/gameobject/create", { name, position, ...(rotation && { eulerAngles: rotation }) });
          
          const fields: Record<string, any> = {};
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
          const { name, position, rotation, fieldOfView, orthographic } = args as any;
          if (!name || !position) return { content: [{ type: "text", text: "Name and position required for camera" }], isError: true };
          
          await callUnity("/gameobject/create", { name, position, ...(rotation && { eulerAngles: rotation }) });
          
          const fields: Record<string, any> = {};
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
          const { path, name, intensity, color } = args as any;
          const targetPath = path || name;
          if (!targetPath) return { content: [{ type: "text", text: "Path or name required" }], isError: true };
          
          const fields: Record<string, any> = {};
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
          const { path, name, fieldOfView, orthographic } = args as any;
          const targetPath = path || name;
          if (!targetPath) return { content: [{ type: "text", text: "Path or name required" }], isError: true };
          
          const fields: Record<string, any> = {};
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
          const fields: Record<string, any> = {};
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
          
          const fields: Record<string, any> = {};
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
          if (!scriptPath) return errorResponse("scriptPath required");
          
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
            const finalAssetPath = assetPath.startsWith("Assets/") ? assetPath : `Assets/${assetPath}`;
            return successResponse(`Created script: ${finalAssetPath}`);
          } catch (error) {
            const errorMsg = (error as Error).message || String(error);
            return errorResponse(`Failed to create script: ${errorMsg}`);
          }
        }
        
        if (act === "attachscript") {
          const { path, className } = args as { path?: string; className?: string };
          if (!path || !className) return errorResponse("path and className required");
          
          await callUnity("/component/addOrUpdate", {
            path,
            componentType: className
          });
          return successResponse(`Attached ${className} to ${path}`);
        }
        
        if (act === "compile") {
          // Force Unity to recompile scripts
          await callUnity("/assets/refresh", {});
          await waitForCompileIdle();
          return successResponse("Compilation completed");
        }
        
        return errorResponse(`Unknown action: ${act}`);
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
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const requestedName = (req.params.name ?? "");
    const canonRequested = canonicalize(requestedName);
    let tool = toolByCanonical.get(canonRequested);
    let args = (req.params.arguments ?? {}) as Record<string, unknown>;

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
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
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
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          server.sendResourceUpdated({ uri: "unity://logs" });
        } catch {}
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


