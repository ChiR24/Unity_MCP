import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpText = { type: "text"; text: string };
type McpResult = { content?: McpText[]; isError?: boolean } & Record<string, unknown>;

async function main() {
  const useTsx = process.env.MCP_USE_TSX === "1";
  const command = process.env.MCP_SERVER_CMD || "node";
  const serverArgs = useTsx
    ? ["../server/node_modules/tsx/dist/cli.js", "../server/src/index.ts"]
    : (process.env.MCP_SERVER_ARGS ? process.env.MCP_SERVER_ARGS.split(" ") : ["../server/dist/index.js"]);

  const client = new Client(
    { name: "unity-mcp-client", version: "0.1.0" },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        prompts: { listChanged: true },
        logging: {}
      }
    }
  );
  const transport = new StdioClientTransport({ command, args: serverArgs });
  await client.connect(transport);
  console.log("Connected to Unity MCP server");

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
  let lastLogLen = 0;

  const getFirstText = (res: McpResult | null): string => {
    try {
      const t = res?.content?.[0]?.text;
      return typeof t === "string" ? t : "";
    } catch { return ""; }
  };
  const getIsError = (res: McpResult | null): boolean => Boolean(res?.isError);
  const parseFirstJson = <T = unknown>(res: McpResult | null): T | null => {
    try {
      const txt = getFirstText(res);
      if (!txt) return null;
      return JSON.parse(txt) as T;
    } catch { return null; }
  };

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<McpResult | null> => {
    try {
      const res = await client.callTool({ name, arguments: args }) as McpResult;
      // Optimize logging: avoid double JSON.stringify
      const argsStr = Object.keys(args).length === 0 ? "{}" : JSON.stringify(args);
      const resStr = getFirstText(res) || "[no content]";
      console.log(`${name} ${argsStr} -> ${resStr.length > 200 ? resStr.substring(0, 200) + "..." : resStr}`);
      
      // After every tool call (except console read itself), read Unity console and print delta
      if (!(name === "unity_console" && (args as Record<string, unknown>)?.action === "read")) {
        try {
          const logsRes = await client.callTool({ name: "unity_console", arguments: { action: "read" } }) as McpResult;
          const txt = getFirstText(logsRes) || "";
          const delta = txt.substring(lastLogLen);
          lastLogLen = txt.length;
          if (delta.trim().length > 0) {
            console.log(`[UnityConsoleDelta]\n${delta}`);
          } else {
            console.log(`[UnityConsoleDelta] <no new logs>`);
          }
        } catch (e) {
          console.warn("console read failed:", (e as Error).message);
        }
      }
      return res;
    } catch (e) {
      console.warn(`${name} failed:`, (e as Error).message);
      return null;
    }
  };

  try {
    const tools = await client.listTools();
    console.log("Tools:", tools.tools.map(t => t.name));
  } catch (e) {
    console.error("listTools failed:", e);
  }

  // Editor basics
  await call("unity_editor", { action: "state" });
  await call("unity_editor", { action: "info" });
  await call("unity_editor", { action: "notify", message: "MCP smoke test", title: "Unity MCP", modal: false });

  // Console
  await call("unity_console", { action: "read" });
  await call("unity_console", { action: "clear" });

  // Assets
  await call("unity_assets", { action: "list", path: "Assets" });
  await call("unity_assets", { action: "find", query: "t:Prefab" });

  // Selection snapshot
  await call("unity_selection", { action: "get" });
  // Dump hierarchy once
  await call("unity_gameObject", { action: "hierarchy" });

  // GameObject lifecycle - align with your test name
  const objName = process.env.TEST_OBJECT_NAME || "TestObject";
  await call("unity_gameObject", { action: "create", name: objName, active: true });
  await sleep(500); // allow editor to process creation

  // Resolve actual path and instanceId for robust addressing
  const getRes = await call("unity_gameObject", { action: "get", name: objName });
  const info = parseFirstJson<{ path?: string; instanceId?: number }>(getRes) || {};
  const objPath = info.path || objName;
  const objId = info.instanceId;

  // Select created object and verify, fallback to instanceId
  let selRes = await call("unity_selection", { action: "set", paths: [objPath] });
  await sleep(200);
  if (getIsError(selRes)) {
    if (typeof objId === "number") {
      selRes = await call("unity_selection", { action: "set", instanceIds: [objId] });
      await sleep(200);
    }
  }
  await call("unity_selection", { action: "get" });

  // Update properties - send both path and instanceId for fallback
  if (typeof objId === "number") {
    await call("unity_gameObject", { action: "set", instanceId: objId, path: objPath, active: true, tag: "Untagged" });
  } else {
    await call("unity_gameObject", { action: "set", path: objPath, active: true, tag: "Untagged" });
  }
  await sleep(250);

  // Component ops - include both identifiers so bridge can fallback if needed
  if (typeof objId === "number") {
    let addCompRes = await call("unity_component", { action: "addOrUpdate", instanceId: objId, path: objPath, componentType: "Rigidbody" });
    if (getIsError(addCompRes)) {
      await sleep(250);
      addCompRes = await call("unity_component", { action: "addOrUpdate", instanceId: objId, path: objPath, componentType: "UnityEngine.Rigidbody" });
    }
    await sleep(300);
    // Apply Rigidbody fields
    await call("unity_component", { action: "addOrUpdate", instanceId: objId, path: objPath, componentType: "UnityEngine.Rigidbody", fields: { mass: 1200, drag: 0.1, angularDrag: 3, useGravity: true } });
    await sleep(200);
    await call("unity_component", { action: "get", instanceId: objId, path: objPath, componentType: "Rigidbody" });
    await call("unity_component", { action: "get", instanceId: objId, path: objPath, componentType: "Transform" });
  } else {
    let addCompRes = await call("unity_component", { action: "addOrUpdate", path: objPath, componentType: "Rigidbody" });
    if (getIsError(addCompRes)) {
      await sleep(250);
      addCompRes = await call("unity_component", { action: "addOrUpdate", path: objPath, componentType: "UnityEngine.Rigidbody" });
    }
    await sleep(300);
    // Apply Rigidbody fields
    await call("unity_component", { action: "addOrUpdate", path: objPath, componentType: "UnityEngine.Rigidbody", fields: { mass: 1200, drag: 0.1, angularDrag: 3, useGravity: true } });
    await sleep(200);
    await call("unity_component", { action: "get", path: objPath, componentType: "Rigidbody" });
    await call("unity_component", { action: "get", path: objPath, componentType: "Transform" });
  }

  // Play mode controls
  await call("unity_play", { action: "start" });
  await sleep(600);
  await call("unity_play", { action: "pause" });
  await sleep(350);
  await call("unity_play", { action: "resume" });
  await sleep(350);
  await call("unity_play", { action: "stop" });

  // Packages (list always; install/remove only when TEST_PACKAGE_ID provided)
  await call("unity_packages", { action: "list" });
  const testPkg = process.env.TEST_PACKAGE_ID; // e.g., com.unity.cinemachine
  if (testPkg) {
    await call("unity_packages", { action: "install", id: testPkg });
    await call("unity_packages", { action: "remove", id: testPkg });
  }

  // Scene ops: proactively SaveAs to ensure a valid path, then Save
  const saveAsPath = process.env.SCENE_SAVEAS_PATH || "Assets/MCP_AutoSave.unity";
  const saveAsRes = await call("unity_scene", { action: "saveAs", path: saveAsPath });
  if (!getIsError(saveAsRes)) {
    await call("unity_scene", { action: "save" });
  } else {
    // Fallback: try direct save once
    await call("unity_scene", { action: "save" });
  }

  if (process.env.SCENE_OPEN_PATH) {
    await call("unity_scene", { action: "open", path: process.env.SCENE_OPEN_PATH, additive: false });
  }

  // Prefab ops (optional; requires a prefab instance). Gated.
  if (process.env.PREFAB_INSTANCE_PATH) {
    await call("unity_prefab", { action: "apply", path: process.env.PREFAB_INSTANCE_PATH });
    await call("unity_prefab", { action: "revert", path: process.env.PREFAB_INSTANCE_PATH });
  }

  // Bake (optional, potentially heavy). Gated.
  if (process.env.RUN_BAKE === "1") {
    await call("unity_bake", { action: "lighting" });
  }

  // Profiler memory snapshot (optional). Provide absolute or project-relative path.
  if (process.env.MEM_SNAPSHOT_PATH) {
    await call("unity_profiler", { action: "memorySnapshot", path: process.env.MEM_SNAPSHOT_PATH });
  }

  // Import settings (optional). Requires an existing asset path.
  if (process.env.IMPORT_ASSET_PATH) {
    await call("unity_import", { assetPath: process.env.IMPORT_ASSET_PATH, maxSize: 256, textureCompression: "Compressed" });
  }

  // Additional endpoints (optional): menu, asset instantiate, tests, hierarchy, invoke
  if (process.env.MENU_PATH) {
    await call("unity_menu", { action: "execute", menuPath: process.env.MENU_PATH });
  }
  if (process.env.INSTANTIATE_ASSET_PATH) {
    await call("unity_asset", { action: "instantiate", assetPath: process.env.INSTANTIATE_ASSET_PATH, parentPath: process.env.PARENT_PATH });
  }
  if (process.env.RUN_TESTS === "1") {
    await call("unity_tests", { action: "run", mode: process.env.TEST_MODE || "EditMode", filter: process.env.TEST_FILTER });
  }
  if (process.env.DUMP_HIERARCHY === "1") {
    await call("unity_gameObject", { action: "hierarchy" });
  }
  if (process.env.INVOKE_TYPE && process.env.INVOKE_METHOD) {
    await call("unity_editor", { action: "invoke", typeName: process.env.INVOKE_TYPE, methodName: process.env.INVOKE_METHOD, isStatic: process.env.INVOKE_IS_STATIC === "1", argsJson: process.env.INVOKE_ARGS_JSON });
  }

  // Visual Scripting Tests
  console.log("\n🎨 Testing Visual Scripting functionality...");

  // Test template management
  await call("unity_visualscripting_templates", { action: "categories" });
  await call("unity_visualscripting_templates", { action: "list", category: "Player Management" });
  await call("unity_visualscripting_templates", { action: "get", templateName: "create_player_setup" });

  // Create a test GameObject for visual scripting
  const vsTestObjName = "VisualScriptTestObject";
  await call("unity_gameObject", { action: "create", name: vsTestObjName, active: true });
  await sleep(500);

  // Test visual scripting operations
  await call("unity_visualscripting", {
    action: "create",
    gameObjectPath: vsTestObjName,
    scriptName: "TestVisualScript",
    templateType: "flow"
  });

  // Add a custom node
  await call("unity_visualscripting", {
    action: "addNode",
    gameObjectPath: vsTestObjName,
    nodeType: "mcp_operation",
    nodeData: "Custom MCP Node",
    position: { x: 800, y: 0, z: 0 }
  });

  // Apply a template
  await call("unity_visualscripting_templates", {
    action: "apply",
    templateName: "create_player_setup",
    gameObjectPath: vsTestObjName,
    customizations: { name: "CustomPlayer" }
  });

  // Get the generated graph
  await call("unity_visualscripting", {
    action: "getGraph",
    gameObjectPath: vsTestObjName,
    includeConnections: true,
    includeNodeData: true
  });

  // Generate visual script from custom MCP operations
  await call("unity_visualscripting", {
    action: "generateFromMcp",
    gameObjectPath: vsTestObjName,
    scriptName: "CustomMCPScript",
    operations: [
      {
        tool: "unity_console",
        action: "clear",
        parameters: {},
        description: "Clear console",
        order: 1
      },
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "DynamicObject" },
        description: "Create dynamic object",
        order: 2
      }
    ],
    autoConnect: true
  });

  // Clean up visual scripting test object
  await call("unity_gameObject", { action: "delete", path: vsTestObjName });
  console.log("✅ Visual Scripting tests completed!\n");

  // Delete the created object to validate delete path
  if (typeof objId === "number") {
    await call("unity_gameObject", { action: "delete", instanceId: objId, path: objPath });
  } else {
    await call("unity_gameObject", { action: "delete", path: objPath });
  }

  // Read logs resource at the end as well
  try {
    const logs = await client.readResource({ uri: "unity://logs" });
    console.log("logs read:", JSON.stringify(logs));
  } catch (e) {
    console.warn("logs read failed:", (e as Error).message);
  }

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
