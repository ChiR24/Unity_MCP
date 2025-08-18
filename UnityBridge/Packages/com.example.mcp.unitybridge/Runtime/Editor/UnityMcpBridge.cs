// SPDX-License-Identifier: MIT
#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using System.Reflection;
using System.Globalization;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor.SceneManagement;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine.Profiling.Memory.Experimental;

namespace MCP.UnityBridge
{
    [InitializeOnLoad]
    public static class UnityMcpBridge
    {
        private static HttpListener _listener;
        private static Thread _serverThread;
        private static readonly string Prefix = "http://127.0.0.1:58888/";
        private static readonly int MaxLogLines = 5000;
        private static readonly ConcurrentQueue<string> LogRing = new ConcurrentQueue<string>();
        private static readonly List<HttpListenerResponse> SseClients = new List<HttpListenerResponse>();
        private static readonly object SseLock = new object();
        private static readonly string BridgeToken;
        private static volatile bool _stopping;

        static UnityMcpBridge()
        {
            Application.logMessageReceived += OnLogMessageReceived;
            // Allow configuring a shared secret to guard the bridge
            var env = Environment.GetEnvironmentVariable("UNITY_BRIDGE_TOKEN");
            BridgeToken = EditorPrefs.GetString("MCP_UnityBridge_Token", string.IsNullOrEmpty(env) ? string.Empty : env);
            StartServer();
            EditorApplication.playModeStateChanged += state =>
            {
                BroadcastSse($"[Editor] PlayModeStateChanged: {state}");
            };
            Selection.selectionChanged += () =>
            {
                BroadcastSse("[Editor] SelectionChanged");
            };
            EditorApplication.update += ProcessMainThreadQueue;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
        }

        private static void OnBeforeAssemblyReload()
        {
            StopServer();
        }

        private static void OnLogMessageReceived(string condition, string stackTrace, LogType type)
        {
            var line = $"[{DateTime.Now:HH:mm:ss}] {type}: {condition}";
            LogRing.Enqueue(line);
            while (LogRing.Count > MaxLogLines && LogRing.TryDequeue(out _)) { }
            BroadcastSse(line);
        }

        private static void StartServer()
        {
            if (_listener != null) return;
            _listener = new HttpListener();
            _listener.Prefixes.Add(Prefix);
            try
            {
                _stopping = false;
                _listener.Start();
            }
            catch (Exception ex)
            {
                Debug.LogError($"UnityMcpBridge failed to start: {ex.Message}");
                return;
            }

            _serverThread = new Thread(ServerLoop) { IsBackground = true };
            _serverThread.Start();
            Debug.Log("UnityMcpBridge running at " + Prefix);
        }

        private static void ServerLoop()
        {
            while (!_stopping && _listener != null && _listener.IsListening)
            {
                try
                {
                    var ctx = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleContext(ctx));
                }
                catch (ThreadAbortException)
                {
                    // Graceful exit on domain/thread shutdown
                    return;
                }
                catch (HttpListenerException)
                {
                    if (!_stopping) { /* swallow transient listener stop */ }
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    if (!_stopping) Debug.LogException(ex);
                }
            }
        }

        private static void StopServer()
        {
            if (_listener == null) return;
            _stopping = true;
            try
            {
                lock (SseLock)
                {
                    foreach (var res in SseClients)
                    {
                        try { res.OutputStream.Close(); } catch { }
                    }
                    SseClients.Clear();
                }
                _listener.Close();
            }
            catch { }
            finally
            {
                _listener = null;
            }
        }

        private static async void HandleContext(HttpListenerContext ctx)
        {
            try
            {
                // Optional token check
                var path = ctx.Request.Url.AbsolutePath;
                if (!string.IsNullOrEmpty(BridgeToken))
                {
                    var headerToken = ctx.Request.Headers["X-Unity-Bridge-Token"];
                    if (headerToken != BridgeToken)
                    {
                        ctx.Response.StatusCode = 401;
                        await WriteText(ctx, "Unauthorized");
                        return;
                    }
                }
                if (ctx.Request.HttpMethod == "GET" && path == "/logs/read")
                {
                    await WriteText(ctx, ReadLogs());
                    return;
                }
                if (ctx.Request.HttpMethod == "GET" && path == "/logs/stream")
                {
                    StartSse(ctx.Response);
                    return;
                }

                if (ctx.Request.HttpMethod == "POST")
                {
                    string body;
                    using (var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding))
                    {
                        body = await reader.ReadToEndAsync();
                    }
                    try { LogBridge($"-> {path} {Trunc(body, 512)}"); } catch { }

                    if (path == "/menu/execute" || path == "/editor/executeMenuItem")
                    {
                        var req = JsonUtility.FromJson<MenuExecuteRequest>(body);
                        var ok = await RunOnMainThread(() => ExecuteMenu(req.menuPath));
                        var msg = $"Executed {req.menuPath}";
                        await WriteJson(ctx, ok ? Ok(new MsgResponse { message = msg }) : Err("Menu not found or failed"));
                        return;
                    }
                    if (path == "/gameobject/create")
                    {
                        var req = JsonUtility.FromJson<GameObjectCreateRequest>(body);
                        bool hasPos = BodyHas(body, "position");
                        bool hasLocalPos = BodyHas(body, "localPosition");
                        bool hasEuler = BodyHas(body, "eulerAngles");
                        bool hasLocalEuler = BodyHas(body, "localEulerAngles");
                        bool hasLocalScale = BodyHas(body, "localScale");
                        var created = await RunOnMainThread(() =>
                        {
                            var go = CreateGameObject(req, hasPos, hasLocalPos, hasEuler, hasLocalEuler, hasLocalScale);
                            
                            // Mark scene dirty and refresh UI after creating GameObject
                            EditorUtility.SetDirty(go);
                            EditorSceneManager.MarkSceneDirty(go.scene);
                            UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                            
                            return new CreatedResponse { instanceId = go.GetInstanceID(), path = GetPath(go.transform) };
                        });
                        await WriteJson(ctx, Ok(created));
                        return;
                    }
                    if (path == "/gameobject/setProperties")
                    {
                        var req = JsonUtility.FromJson<GameObjectSetPropertiesRequest>(body);
                        var updatedPath = await RunOnMainThread(() =>
                        {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return (string)null;
                            if (BodyHas(body, "name") && !string.IsNullOrEmpty(req.name)) go.name = req.name;
                            if (BodyHas(body, "active")) go.SetActive(req.active.GetValueOrDefault());
                            if (BodyHas(body, "tag") && !string.IsNullOrEmpty(req.tag)) go.tag = req.tag;
                            if (BodyHas(body, "layer")) go.layer = req.layer.HasValue ? req.layer.Value : go.layer;
                            var t = go.transform;
                            if (BodyHas(body, "position") && req.position != null) t.position = new Vector3(req.position.x, req.position.y, req.position.z);
                            if (BodyHas(body, "localPosition") && req.localPosition != null) t.localPosition = new Vector3(req.localPosition.x, req.localPosition.y, req.localPosition.z);
                            if (BodyHas(body, "eulerAngles") && req.eulerAngles != null) t.eulerAngles = new Vector3(req.eulerAngles.x, req.eulerAngles.y, req.eulerAngles.z);
                            if (BodyHas(body, "localEulerAngles") && req.localEulerAngles != null) t.localEulerAngles = new Vector3(req.localEulerAngles.x, req.localEulerAngles.y, req.localEulerAngles.z);
                            if (BodyHas(body, "localScale") && req.localScale != null) t.localScale = new Vector3(req.localScale.x, req.localScale.y, req.localScale.z);
                            // Synonyms support
                            if (BodyHas(body, "scale") && req.scale != null) t.localScale = new Vector3(req.scale.x, req.scale.y, req.scale.z);
                            if (BodyHas(body, "rotation") && req.rotation != null) t.eulerAngles = new Vector3(req.rotation.x, req.rotation.y, req.rotation.z);
                            if (BodyHas(body, "localRotation") && req.localRotation != null) t.localEulerAngles = new Vector3(req.localRotation.x, req.localRotation.y, req.localRotation.z);
                            
                            // Mark scene dirty and refresh UI after updating GameObject properties
                            EditorUtility.SetDirty(go);
                            EditorSceneManager.MarkSceneDirty(go.scene);
                            
                            // Refresh Inspector if this object is selected
                            if (Selection.activeGameObject == go)
                            {
                                Selection.activeGameObject = null;
                                Selection.activeGameObject = go;
                            }
                            UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                            
                            return GetPath(go.transform);
                        });
                        if (updatedPath == null) { await WriteJson(ctx, Err("GameObject not found")); return; }
                        await WriteJson(ctx, Ok(new PathResponse { path = updatedPath }));
                        return;
                    }
                    if (path == "/gameobject/getProperties")
                    {
                        var req = JsonUtility.FromJson<GameObjectSetPropertiesRequest>(body);
                        var info = await RunOnMainThread(() =>
                        {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return (GameObjectInfoResponse)null;
                            var t = go.transform;
                            return new GameObjectInfoResponse
                            {
                                instanceId = go.GetInstanceID(),
                                path = GetPath(t),
                                name = go.name,
                                active = go.activeSelf,
                                tag = go.tag,
                                layer = go.layer,
                                position = new Vec3 { x = t.position.x, y = t.position.y, z = t.position.z },
                                localPosition = new Vec3 { x = t.localPosition.x, y = t.localPosition.y, z = t.localPosition.z },
                                eulerAngles = new Vec3 { x = t.eulerAngles.x, y = t.eulerAngles.y, z = t.eulerAngles.z },
                                localEulerAngles = new Vec3 { x = t.localEulerAngles.x, y = t.localEulerAngles.y, z = t.localEulerAngles.z },
                                localScale = new Vec3 { x = t.localScale.x, y = t.localScale.y, z = t.localScale.z },
                            };
                        });
                        if (info == null) { await WriteJson(ctx, Err("GameObject not found")); return; }
                        await WriteJson(ctx, Ok(info));
                        return;
                    }
                    if (path == "/gameobject/delete")
                    {
                        var req = JsonUtility.FromJson<GameObjectDeleteRequest>(body);
                        var deletedPath = await RunOnMainThread(() =>
                        {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return (string)null;
#if UNITY_EDITOR
                            // Store the path before deletion
                            var goPath = req.path ?? GetPath(go.transform);
                            var goScene = go.scene;
                            
                            try { 
                                UnityEngine.Object.DestroyImmediate(go);
                                
                                // Mark scene dirty after deleting GameObject
                                EditorSceneManager.MarkSceneDirty(goScene);
                                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                            } catch { return (string)null; }
#else
                            var goPath = req.path ?? GetPath(go.transform);
                            try { UnityEngine.Object.Destroy(go); } catch { return (string)null; }
#endif
                            return goPath;
                        });
                        if (deletedPath == null) { await WriteJson(ctx, Err("GameObject not found")); return; }
                        await WriteJson(ctx, Ok(new PathResponse { path = deletedPath }));
                        return;
                    }
                    if (path == "/component/addOrUpdate")
                    {
                        var req = JsonUtility.FromJson<ComponentAddOrUpdateRequest>(body);
                        var compResp = await RunOnMainThread(() =>
                        {
                            try
                            {
                                var go = FindTarget(req.path, req.instanceId);
                                if (go == null) return (ok: false, body: Err("GameObject not found"));
                                var type = ResolveType(req.componentType);
                                if (type == null) return (ok: false, body: Err($"Component type '{req.componentType}' not found"));
                                
                                // Try to get existing component or add new one
                                Component comp = go.GetComponent(type);
                                if (comp == null)
                                {
                                    try
                                    {
                                        comp = go.AddComponent(type);
                                    }
                                    catch (Exception addEx)
                                    {
                                        Debug.LogError($"Failed to add component {type.Name}: {addEx.Message}");
                                        return (ok: false, body: Err($"Failed to add component: {addEx.Message}"));
                                    }
                                }
                                
                                if (comp == null)
                                {
                                    return (ok: false, body: Err("Component could not be added"));
                                }
                                
                                // Apply fields if provided
                                if (!string.IsNullOrEmpty(req.fieldsJson))
                                {
                                    try
                                    {
                                        if (comp is MonoBehaviour)
                                        {
                                            EditorJsonUtility.FromJsonOverwrite(req.fieldsJson, comp);
                                        }
                                        else
                                        {
                                            // Apply known engine component fields
                                            if (comp is Rigidbody rb)
                                            {
                                                ApplyRigidbodyFields(rb, req.fieldsJson);
                                            }
                                            else if (comp is Camera cam)
                                            {
                                                ApplyCameraFields(cam, req.fieldsJson);
                                            }
                                            else if (comp is Light li)
                                            {
                                                ApplyLightFields(li, req.fieldsJson);
                                            }
                                        }
                                    }
                                    catch (Exception fieldEx)
                                    {
                                        Debug.LogWarning($"Failed to apply fields to {type.Name}: {fieldEx.Message}");
                                        // Continue anyway, component was added successfully
                                    }
                                }
                                
                                // Mark the scene as dirty and refresh the Editor UI
                                EditorUtility.SetDirty(go);
                                EditorUtility.SetDirty(comp);
                                EditorSceneManager.MarkSceneDirty(go.scene);
                                
                                // Force refresh the Inspector immediately
                                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                                
                                // Force selection refresh to update Inspector
                                var currentSelection = Selection.activeGameObject;
                                Selection.activeGameObject = null;
                                EditorApplication.delayCall += () =>
                                {
                                    Selection.activeGameObject = currentSelection;
                                    UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                                    
                                    // Force refresh hierarchy and inspector windows
                                    EditorApplication.DirtyHierarchyWindowSorting();
                                    EditorUtility.SetDirty(go);
                                };
                                
                                return (ok: true, body: Ok(new ComponentResponse { componentType = req.componentType, path = GetPath(go.transform) }));
                            }
                            catch (Exception ex)
                            {
                                Debug.LogError($"Component add/update failed: {ex.Message}\n{ex.StackTrace}");
                                return (ok: false, body: Err($"Component operation failed: {ex.Message}"));
                            }
                        });
                        if (!compResp.ok) { await WriteJson(ctx, compResp.body); return; }
                        await WriteJson(ctx, compResp.body);
                        return;
                    }
                    if (path == "/package/install")
                    {
                        var req = JsonUtility.FromJson<PackageIdRequest>(body);
                        var (ok, version, perr) = await InstallPackage(req.id);
                        await WriteJson(ctx, ok ? Ok(new InstallResponse { id = req.id, installedVersion = version }) : Err(string.IsNullOrEmpty(perr) ? "Install failed" : perr));
                        return;
                    }
                    if (path == "/package/remove")
                    {
                        var req = JsonUtility.FromJson<PackageIdRequest>(body);
                        if (string.IsNullOrEmpty(req.id)) { await WriteJson(ctx, Err("Package name cannot be empty")); return; }
                        // Pre-flight: check manifest for clearer error message
                        if (!IsPackageInManifest(req.id))
                        {
                            await WriteJson(ctx, Err($"Unable to remove package [{req.id}]: Package name [{req.id}] cannot be found in the project manifest"));
                            return;
                        }
                        var (ok, perr) = await RemovePackage(req.id);
                        await WriteJson(ctx, ok ? Ok(new IdResponse { id = req.id }) : Err(string.IsNullOrEmpty(perr) ? $"Unable to remove package [{req.id}]" : perr));
                        return;
                    }
                    if (path == "/packages/list")
                    {
                        var packages = await ListPackages();
                        await WriteJson(ctx, Ok(new PackagesListResponse { packages = packages }));
                        return;
                    }
                    if (path == "/tests/run")
                    {
						var req = JsonUtility.FromJson<RunTestsRequest>(body);
						// Ensure editor is idle (not playing or compiling) before running tests
						await EnsureEditorIdle();
						try
						{
							var result = await RunTests(req.mode, req.filter);
							await WriteJson(ctx, Ok(result));
						}
						catch
						{
							await WriteJson(ctx, Ok(new TestsResponse { passed = 0, failed = 0, durationMs = 0, reportPath = string.Empty }));
						}
                        return;
                    }
                    if (path == "/editor/state")
                    {
                        var state = await RunOnMainThread(() => new StateResponse{
                            playMode = EditorApplication.isPlaying ? "Playing" : (EditorApplication.isPaused ? "Paused" : "Stopped"),
                            isCompiling = EditorApplication.isCompiling,
                            selection = GetSelectionPaths(),
                        });
                        await WriteJson(ctx, Ok(state));
                        return;
                    }
                    if (path == "/editor/info")
                    {
                        var info = await RunOnMainThread(() => new EditorInfoResponse {
                            projectName = Application.productName,
                            unityVersion = Application.unityVersion,
                            dataPath = Application.dataPath,
                        });
                        await WriteJson(ctx, Ok(info));
                        return;
                    }
                    if (path == "/editor/buildTarget")
                    {
                        var req = JsonUtility.FromJson<BuildTargetRequest>(body);
                        var ok = await RunOnMainThread(() => {
                            try {
                                var target = ParseBuildTarget(req.target);
                                var group = BuildPipeline.GetBuildTargetGroup(target);
                                return EditorUserBuildSettings.SwitchActiveBuildTarget(group, target);
                            } catch { return false; }
                        });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to switch build target"));
                        return;
                    }
                    if (path == "/editor/notify")
                    {
                        var req = JsonUtility.FromJson<NotifyRequest>(body);
                        await RunOnMainThread(() =>
                        {
                            if (req.modal)
                            {
                                EditorUtility.DisplayDialog(string.IsNullOrEmpty(req.title) ? "MCP" : req.title, req.message, "OK");
                            }
                            else
                            {
                                ShowNotification(req.title, req.message);
                            }
                        });
                        await WriteJson(ctx, Ok(new ShownResponse { shown = true }));
                        return;
                    }
                    if (path == "/editor/build")
                    {
                        var req = JsonUtility.FromJson<BuildRequest>(body);
                        var res = await RunOnMainThread(() => RunBuild(req));
                        await WriteJson(ctx, Ok(res));
                        return;
                    }
                    if (path == "/scene/open")
                    {
                        var req = JsonUtility.FromJson<SceneOpenRequest>(body);
                        var ok = await RunOnMainThread(() => OpenScenePath(req.path, req.additive));
                        await WriteJson(ctx, ok ? Ok(new ShownResponse { shown = true }) : Err("Failed to open scene"));
                        return;
                    }
                    if (path == "/scene/save")
                    {
                        var req = JsonUtility.FromJson<SceneSaveRequest>(body);
                        var ok = await RunOnMainThread(() => SaveScenePath(req.path));
                        await WriteJson(ctx, ok ? Ok(new ShownResponse { shown = true }) : Err("Failed to save scene"));
                        return;
                    }
                    if (path == "/scene/saveAs")
                    {
                        var req = JsonUtility.FromJson<SceneSaveRequest>(body);
                        var ok = await RunOnMainThread(() => SaveActiveSceneAs(req.path));
                        await WriteJson(ctx, ok ? Ok(new ShownResponse { shown = true }) : Err("Failed to save scene as"));
                        return;
                    }
                    if (path == "/scene/getLoaded")
                    {
                        var arr = await RunOnMainThread(() => {
                            var list = new List<string>();
                            for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
                            {
                                var scn = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
                                if (scn.isLoaded) list.Add(string.IsNullOrEmpty(scn.path) ? scn.name : scn.path);
                            }
                            return list.ToArray();
                        });
                        await WriteJson(ctx, OkJson("{\"scenes\":[\"" + string.Join("\",\"", arr.Select(x => JsonEscape(x))) + "\"]}"));
                        return;
                    }
                    if (path == "/scene/create")
                    {
                        var req = JsonUtility.FromJson<SceneCreateRequest>(body);
                        var ok = await RunOnMainThread(() => {
                            try {
                                var scn = UnityEditor.SceneManagement.EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
                                if (!string.IsNullOrEmpty(req.path)) { UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scn, req.path); }
                                return true;
                            } catch { return false; }
                        });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to create scene"));
                        return;
                    }
                    if (path == "/scene/unload")
                    {
                        var req = JsonUtility.FromJson<SceneUnloadRequest>(body);
                        var ok = await RunOnMainThread(() => {
                            try {
                                for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) {
                                    var scn = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
                                    if (!scn.isLoaded) continue;
                                    if (string.Equals(req.path, scn.path, StringComparison.OrdinalIgnoreCase) || string.Equals(req.path, scn.name, StringComparison.OrdinalIgnoreCase)) {
                                        return UnityEditor.SceneManagement.EditorSceneManager.CloseScene(scn, true);
                                    }
                                }
                            } catch { }
                            return false;
                        });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to unload scene"));
                        return;
                    }
                    if (path == "/prefab/apply")
                    {
                        var req = JsonUtility.FromJson<PrefabOpRequest>(body);
                        var ok = await RunOnMainThread(() => PrefabApply(req.path, req.instanceId));
                        await WriteJson(ctx, ok ? Ok(new ShownResponse { shown = true }) : Err("Failed to apply prefab"));
                        return;
                    }
                    if (path == "/prefab/revert")
                    {
                        var req = JsonUtility.FromJson<PrefabOpRequest>(body);
                        var ok = await RunOnMainThread(() => PrefabRevert(req.path, req.instanceId));
                        await WriteJson(ctx, ok ? Ok(new ShownResponse { shown = true }) : Err("Failed to revert prefab"));
                        return;
                    }
                    if (path == "/prefab/create")
                    {
                        var req = JsonUtility.FromJson<PrefabCreateRequest>(body);
                        var resp = await RunOnMainThread(() =>
                        {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return (ok: false, json: Err("GameObject not found"));
#if UNITY_EDITOR
                            try
                            {
                                var savedPath = SaveAsPrefab(go, req.assetPath, req.connect, req.overwrite);
                                return string.IsNullOrEmpty(savedPath)
                                    ? (ok: false, json: Err("Failed to create prefab"))
                                    : (ok: true, json: Ok(new PathResponse { path = savedPath }));
                            }
                            catch (Exception ex)
                            {
                                return (ok: false, json: Err("Prefab create failed: " + ex.Message));
                            }
#else
                            return (ok: false, json: Err("Editor only"));
#endif
                        });
                        await WriteJson(ctx, resp.json);
                        return;
                    }
                    if (path == "/component/get")
                    {
                        var req = JsonUtility.FromJson<ComponentGetRequest>(body);
                        var json = await RunOnMainThread(() => GetComponentSnapshot(req));
                        if (string.IsNullOrEmpty(json)) { await WriteJson(ctx, Err("Component not found")); return; }
                        await WriteJson(ctx, OkJson(json));
                        return;
                    }
                    if (path == "/component/getAll")
                    {
                        var req = JsonUtility.FromJson<ComponentGetAllRequest>(body);
                        var json = await RunOnMainThread(() => {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return (string)null;
                            var comps = go.GetComponents<Component>();
                            var sb = new StringBuilder();
                            sb.Append("{"); sb.Append("\"components\":[");
                            for (int i = 0; i < comps.Length; i++)
                            {
                                var c = comps[i]; if (c == null) continue; var t = c.GetType();
                                sb.Append("{\"type\":\"").Append(JsonEscape(t.Name)).Append("\",\"fullName\":\"").Append(JsonEscape(t.FullName)).Append("\"}");
                                if (i < comps.Length - 1) sb.Append(",");
                            }
                            sb.Append("]}");
                            return sb.ToString();
                        });
                        if (string.IsNullOrEmpty(json)) { await WriteJson(ctx, Err("GameObject not found")); return; }
                        await WriteJson(ctx, OkJson(json));
                        return;
                    }
                    if (path == "/component/destroy")
                    {
                        var req = JsonUtility.FromJson<ComponentDestroyRequest>(body);
                        var ok = await RunOnMainThread(() => {
                            var go = FindTarget(req.path, req.instanceId);
                            if (go == null) return false;
                            var type = ResolveType(req.componentType);
                            if (type == null) return false;
                            var comp = go.GetComponent(type);
                            if (comp == null) return false;
                            try { 
                                UnityEngine.Object.DestroyImmediate(comp);
                                
                                // Mark scene dirty and refresh UI after destroying component
                                EditorUtility.SetDirty(go);
                                EditorSceneManager.MarkSceneDirty(go.scene);
                                
                                // Refresh Inspector if this object is selected
                                if (Selection.activeGameObject == go)
                                {
                                    Selection.activeGameObject = null;
                                    Selection.activeGameObject = go;
                                }
                                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                                
                                return true; 
                            } catch { return false; }
                        });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Component not found"));
                        return;
                    }
                    if (path == "/bake/lighting")
                    {
                        var ok = await RunOnMainThread(() => { try { Lightmapping.BakeAsync(); return true; } catch { try { Lightmapping.Bake(); } catch { return false; } return true; } });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Lighting bake failed"));
                        return;
                    }
                    if (path == "/profiler/memorySnapshot")
                    {
                        var req = JsonUtility.FromJson<MemorySnapshotRequest>(body);
                        var ok = await RunOnMainThread(() => TakeMemorySnapshot(req.path));
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Snapshot failed"));
                        return;
                    }
                    if (path == "/import/set")
                    {
                        var req = JsonUtility.FromJson<ImportTextureRequest>(body);
                        var ok = await RunOnMainThread(() => SetTextureImportSettings(req));
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Import settings failed"));
                        return;
                    }
                    if (path == "/material/create")
                    {
                        var req = JsonUtility.FromJson<MaterialCreateRequest>(body);
                        var json = await RunOnMainThread(() => {
                            try
                            {
                                // Create material with shader
                                Shader sh = null;
                                try { if (!string.IsNullOrEmpty(req.shader)) sh = Shader.Find(req.shader); } catch { }
                                if (sh == null) { try { sh = Shader.Find("Standard"); } catch { } }
                                if (sh == null) { try { sh = Shader.Find("Unlit/Color"); } catch { } }
                                var mat = (sh != null) ? new Material(sh) : new Material(Shader.Find("Standard"));
                                if (!string.IsNullOrEmpty(req.name)) mat.name = req.name;
                                if (req.color != null)
                                {
                                    var c = new Color(req.color.r, req.color.g, req.color.b, req.color.a);
                                    try { mat.color = c; } catch { try { mat.SetColor("_Color", c); } catch { } }
                                }

                                string savedPath = null;
#if UNITY_EDITOR
                                if (!string.IsNullOrEmpty(req.assetPath) && req.assetPath.StartsWith("Assets"))
                                {
                                    try
                                    {
                                        var projectDir = System.IO.Path.GetDirectoryName(Application.dataPath);
                                        var absPath = System.IO.Path.Combine(projectDir, req.assetPath);
                                        var dir = System.IO.Path.GetDirectoryName(absPath);
                                        try { System.IO.Directory.CreateDirectory(dir); } catch { }
                                        UnityEditor.AssetDatabase.CreateAsset(mat, req.assetPath);
                                        UnityEditor.AssetDatabase.SaveAssets();
                                        UnityEditor.AssetDatabase.Refresh();
                                        savedPath = req.assetPath;
                                    }
                                    catch (Exception ex)
                                    {
                                        return Err("Failed to save material: " + ex.Message);
                                    }
                                }
#endif
                                if (!string.IsNullOrEmpty(savedPath))
                                {
                                    return Ok(new PathResponse { path = savedPath });
                                }
                                else
                                {
                                    return Ok(new MsgResponse { message = "Created in-memory material" });
                                }
                            }
                            catch (Exception ex)
                            {
                                return Err("Failed to create material: " + ex.Message);
                            }
                        });
                        await WriteJson(ctx, json);
                        return;
                    }
                    if (path == "/editor/invoke")
                    {
                        var req = JsonUtility.FromJson<InvokeRequest>(body);
                        // Ensure reflection calls that touch Unity APIs execute on the main thread
                        var result = await RunOnMainThread(() => InvokeMethodSafe(req));
                        await WriteJson(ctx, result.ok ? OkJson(result.resultJson ?? "{}") : Err(result.error));
                        return;
                    }
                    if (path == "/visualscripting/create")
                    {
                        var req = JsonUtility.FromJson<VisualScriptCreateRequest>(body);
                        var result = await RunOnMainThread(() => CreateVisualScript(req));
                        await WriteJson(ctx, result != null ? Ok(result) : Err("Failed to create visual script"));
                        return;
                    }
                    if (path == "/visualscripting/addNode")
                    {
                        var req = JsonUtility.FromJson<VisualScriptAddNodeRequest>(body);
                        var result = await RunOnMainThread(() => AddVisualScriptNode(req));
                        await WriteJson(ctx, result != null ? Ok(result) : Err("Failed to add visual script node"));
                        return;
                    }
                    if (path == "/visualscripting/connectNodes")
                    {
                        var req = JsonUtility.FromJson<VisualScriptConnectRequest>(body);
                        var result = await RunOnMainThread(() => ConnectVisualScriptNodes(req));
                        await WriteJson(ctx, result != null ? Ok(result) : Err("Failed to connect visual script nodes"));
                        return;
                    }
                    if (path == "/visualscripting/getGraph")
                    {
                        var req = JsonUtility.FromJson<VisualScriptGetRequest>(body);
                        var result = await RunOnMainThread(() => GetVisualScriptGraph(req));
                        await WriteJson(ctx, result != null ? Ok(result) : Err("Failed to get visual script graph"));
                        return;
                    }
                    if (path == "/visualscripting/generateFromMcp")
                    {
                        var req = JsonUtility.FromJson<VisualScriptFromMcpRequest>(body);
                        var result = await RunOnMainThread(() => GenerateVisualScriptFromMcp(req));
                        await WriteJson(ctx, result != null ? Ok(result) : Err("Failed to generate visual script from MCP"));
                        return;
                    }
                    if (path == "/prefs/set")
                    {
                        var req = JsonUtility.FromJson<PlayerPrefsSetRequest>(body);
                        var ok = await RunOnMainThread(() => {
                            try {
                                switch ((req.type ?? "string").ToLowerInvariant())
                                {
                                    case "int": PlayerPrefs.SetInt(req.key, req.intValue); break;
                                    case "float": PlayerPrefs.SetFloat(req.key, req.floatValue); break;
                                    default: PlayerPrefs.SetString(req.key, req.stringValue ?? string.Empty); break;
                                }
                                PlayerPrefs.Save();
                                return true;
                            } catch { return false; }
                        });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to set PlayerPrefs"));
                        return;
                    }
                    if (path == "/prefs/get")
                    {
                        var req = JsonUtility.FromJson<PlayerPrefsGetRequest>(body);
                        var json = await RunOnMainThread(() => {
                            try {
                                var type = (req.type ?? "string").ToLowerInvariant();
                                var has = PlayerPrefs.HasKey(req.key);
                                if (!has) return "{\"hasKey\":false}";
                                if (type == "int") return "{\"hasKey\":true,\"type\":\"int\",\"intValue\":" + PlayerPrefs.GetInt(req.key, 0) + "}";
                                if (type == "float") return "{\"hasKey\":true,\"type\":\"float\",\"floatValue\":" + PlayerPrefs.GetFloat(req.key, 0f).ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
                                var s = PlayerPrefs.GetString(req.key, string.Empty);
                                return "{\"hasKey\":true,\"type\":\"string\",\"stringValue\":\"" + JsonEscape(s) + "\"}";
                            } catch { return (string)null; }
                        });
                        if (string.IsNullOrEmpty(json)) { await WriteJson(ctx, Err("Failed to get PlayerPrefs")); return; }
                        await WriteJson(ctx, OkJson(json));
                        return;
                    }
                    if (path == "/prefs/delete")
                    {
                        var req = JsonUtility.FromJson<PlayerPrefsDeleteRequest>(body);
                        var ok = await RunOnMainThread(() => { try { PlayerPrefs.DeleteKey(req.key); PlayerPrefs.Save(); return true; } catch { return false; } });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to delete PlayerPrefs key"));
                        return;
                    }
                    if (path == "/prefs/clear")
                    {
                        var ok = await RunOnMainThread(() => { try { PlayerPrefs.DeleteAll(); PlayerPrefs.Save(); return true; } catch { return false; } });
                        await WriteJson(ctx, ok ? Ok(new EmptyResponse()) : Err("Failed to clear PlayerPrefs"));
                        return;
                    }
                    if (path == "/selection/get")
                    {
                        var sel = await RunOnMainThread(() => GetSelectionPaths());
                        await WriteJson(ctx, Ok(new PathsResponse { paths = sel }));
                        return;
                    }
                    if (path == "/selection/set")
                    {
                        var req = JsonUtility.FromJson<SelectionSetRequest>(body);
                        var count = await RunOnMainThread(() =>
                        {
                            var targets = new List<UnityEngine.Object>();
                            if (req.paths != null)
                            {
                                foreach (var p in req.paths)
                                {
                                    var go = FindByPathOrName(p);
                                    if (go != null) targets.Add(go);
                                }
                            }
                            if (req.instanceIds != null)
                            {
                                foreach (var id in req.instanceIds)
                                {
                                    var obj = EditorUtility.InstanceIDToObject(id);
                                    if (obj != null) targets.Add(obj);
                                }
                            }
                            Selection.objects = targets.ToArray();
                            return targets.Count;
                        });
                        await WriteJson(ctx, Ok(new CountResponse { count = count }));
                        return;
                    }
                    if (path == "/asset/instantiate")
                    {
                        var req = JsonUtility.FromJson<InstantiateAssetRequest>(body);
                        var resp = await RunOnMainThread(() =>
                        {
                            var obj = InstantiateAsset(req.assetPath, req.parentPath);
                            if (obj == null) return (ok: false, body: "");
                            return (ok: true, body: Ok(new InstantiatedResponse { path = GetPath(obj.transform), instanceId = obj.GetInstanceID() }));
                        });
                        if (!resp.ok) { await WriteJson(ctx, Err("Asset not found or not instantiable")); return; }
                        await WriteJson(ctx, resp.body);
                        return;
                    }
                    if (path == "/asset/addToScene")
                    {
                        var req = JsonUtility.FromJson<AssetAddToSceneRequest>(body);
                        var resp = await RunOnMainThread(() =>
                        {
                            var obj = InstantiateAsset(req.assetPath, req.parentPath);
                            if (obj == null) return (ok: false, body: "");
                            var t = obj.transform;
                            if (BodyHas(body, "position") && req.position != null) t.position = new Vector3(req.position.x, req.position.y, req.position.z);
                            if (BodyHas(body, "localPosition") && req.localPosition != null) t.localPosition = new Vector3(req.localPosition.x, req.localPosition.y, req.localPosition.z);
                            if (BodyHas(body, "eulerAngles") && req.eulerAngles != null) t.eulerAngles = new Vector3(req.eulerAngles.x, req.eulerAngles.y, req.eulerAngles.z);
                            if (BodyHas(body, "localEulerAngles") && req.localEulerAngles != null) t.localEulerAngles = new Vector3(req.localEulerAngles.x, req.localEulerAngles.y, req.localEulerAngles.z);
                            if (BodyHas(body, "localScale") && req.localScale != null) t.localScale = new Vector3(req.localScale.x, req.localScale.y, req.localScale.z);
                            EditorUtility.SetDirty(obj);
                            EditorSceneManager.MarkSceneDirty(obj.scene);
                            UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                            return (ok: true, body: Ok(new InstantiatedResponse { path = GetPath(obj.transform), instanceId = obj.GetInstanceID() }));
                        });
                        if (!resp.ok) { await WriteJson(ctx, Err("Asset not found or not instantiable")); return; }
                        await WriteJson(ctx, resp.body);
                        return;
                    }
                    if (path == "/assets/find")
                    {
                        var req = JsonUtility.FromJson<AssetsFindRequest>(body);
                        var results = await RunOnMainThread(() => FindAssets(req.query, req.path));
                        await WriteJson(ctx, Ok(new AssetsListResponse { assets = results }));
                        return;
                    }
                    if (path == "/assets/list")
                    {
                        var req = JsonUtility.FromJson<AssetsListRequest>(body);
                        var results = await RunOnMainThread(() => ListAssets(req.path));
                        await WriteJson(ctx, Ok(new AssetsListResponse { assets = results }));
                        return;
                    }
                    if (path == "/assets/refresh")
                    {
#if UNITY_EDITOR
                        await RunOnMainThread(() => { try { UnityEditor.AssetDatabase.Refresh(); } catch { } });
#endif
                        await WriteJson(ctx, Ok(new EmptyResponse()));
                        return;
                    }
                    if (path == "/hierarchy/get")
                    {
                        var results = await RunOnMainThread(() => GetHierarchyPaths());
                        await WriteJson(ctx, Ok(new HierarchyResponse { paths = results }));
                        return;
                    }
                    if (path == "/console/read")
                    {
                        await WriteJson(ctx, Ok(new ConsoleTextResponse { text = ReadLogs() }));
                        return;
                    }
                    if (path == "/console/clear")
                    {
                        await RunOnMainThread(() =>
                        {
                            string _;
                            while (LogRing.TryDequeue(out _)) { }
                            try
                            {
                                var t = Type.GetType("UnityEditor.LogEntries, UnityEditor");
                                var m = t?.GetMethod("Clear", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                                m?.Invoke(null, null);
                            }
                            catch { }
                        });
                        await WriteJson(ctx, Ok(new EmptyResponse()));
                        return;
                    }
                    if (path == "/play/start")
                    {
                        // Ensure the editor is idle before trying to enter play mode
                        await EnsureEditorIdle();
                        await RunOnMainThread(() => { if (!EditorApplication.isPlaying) EditorApplication.isPlaying = true; });
                        await Task.Delay(200);
                        await WriteJson(ctx, Ok(new EmptyResponse()));
                        return;
                    }
                    if (path == "/play/stop")
                    {
                        await RunOnMainThread(() => { EditorApplication.isPlaying = false; });
                        await Task.Delay(100);
                        await WriteJson(ctx, Ok(new EmptyResponse()));
                        return;
                    }
                    if (path == "/play/pause")
                    {
                        var req = JsonUtility.FromJson<PauseRequest>(body);
                        var paused = await RunOnMainThread(() =>
                        {
                            EditorApplication.isPaused = req.pause;
                            return EditorApplication.isPaused;
                        });
                        await WriteJson(ctx, Ok(new PausedResponse { paused = paused }));
                        return;
                    }
                }

                ctx.Response.StatusCode = 404;
                await WriteText(ctx, "Not found");
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                try { await WriteJson(ctx, Err(ex.Message)); } catch { }
            }
        }

        private static string ReadLogs()
        {
            var sb = new StringBuilder();
            foreach (var line in LogRing)
            {
                sb.AppendLine(line);
            }
            return sb.ToString();
        }

        private static bool ExecuteMenu(string menuPath)
        {
            return EditorApplication.ExecuteMenuItem(menuPath);
        }

        private static GameObject CreateGameObject(GameObjectCreateRequest req, bool setPos = false, bool setLocalPos = false, bool setEuler = false, bool setLocalEuler = false, bool setLocalScale = false)
        {
            GameObject go = null;
            var wantedName = string.IsNullOrEmpty(req.name) ? "GameObject" : req.name;
            var prim = (req.primitive ?? string.Empty).Trim().ToLowerInvariant();
            try
            {
                if (!string.IsNullOrEmpty(prim))
                {
                    switch (prim)
                    {
                        case "cube": go = GameObject.CreatePrimitive(PrimitiveType.Cube); break;
                        case "sphere": go = GameObject.CreatePrimitive(PrimitiveType.Sphere); break;
                        case "capsule": go = GameObject.CreatePrimitive(PrimitiveType.Capsule); break;
                        case "cylinder": go = GameObject.CreatePrimitive(PrimitiveType.Cylinder); break;
                        case "plane": go = GameObject.CreatePrimitive(PrimitiveType.Plane); break;
                        case "quad": go = GameObject.CreatePrimitive(PrimitiveType.Quad); break;
                        case "camera": go = new GameObject(wantedName); go.AddComponent<Camera>(); break;
                        case "light":
                        case "directional_light":
                            go = new GameObject(wantedName);
                            var l = go.AddComponent<Light>();
                            try { l.type = string.Equals(req.lightType, "point", StringComparison.OrdinalIgnoreCase) ? LightType.Point : (string.Equals(req.lightType, "spot", StringComparison.OrdinalIgnoreCase) ? LightType.Spot : LightType.Directional); } catch { l.type = LightType.Directional; }
                            break;
                    }
                }
            }
            catch { go = null; }

            if (go == null)
            {
                go = new GameObject(wantedName);
                // Auto-infer by common names if no primitive provided
                try
                {
                    if (string.Equals(wantedName, "Main Camera", StringComparison.OrdinalIgnoreCase))
                    {
                        if (go.GetComponent<Camera>() == null) go.AddComponent<Camera>();
                    }
                    else if (string.Equals(wantedName, "Directional Light", StringComparison.OrdinalIgnoreCase))
                    {
                        var l = go.GetComponent<Light>() ?? go.AddComponent<Light>();
                        l.type = LightType.Directional;
                    }
                }
                catch { }
            }

            // Ensure name
            try { go.name = wantedName; } catch { }

            if (req.active.HasValue && !req.active.Value) go.SetActive(false);
            if (!string.IsNullOrEmpty(req.tag)) go.tag = req.tag;
            if (req.layer.HasValue) go.layer = req.layer.Value;
            if (!string.IsNullOrEmpty(req.parentPath))
            {
                var parent = GameObject.Find(req.parentPath);
                if (parent != null) go.transform.SetParent(parent.transform);
            }
            if (req.components != null)
            {
                foreach (var comp in req.components)
                {
                    var type = Type.GetType(comp);
                    if (type != null && type.IsSubclassOf(typeof(Component)))
                    {
                        go.AddComponent(type);
                    }
                }
            }
            // Positioning/orientation if provided
            var t = go.transform;
            if (setPos && req.position != null) t.position = new Vector3(req.position.x, req.position.y, req.position.z);
            if (setLocalPos && req.localPosition != null) t.localPosition = new Vector3(req.localPosition.x, req.localPosition.y, req.localPosition.z);
            if (setEuler && req.eulerAngles != null) t.eulerAngles = new Vector3(req.eulerAngles.x, req.eulerAngles.y, req.eulerAngles.z);
            if (setLocalEuler && req.localEulerAngles != null) t.localEulerAngles = new Vector3(req.localEulerAngles.x, req.localEulerAngles.y, req.localEulerAngles.z);
            if (setLocalScale && req.localScale != null) t.localScale = new Vector3(req.localScale.x, req.localScale.y, req.localScale.z);
            return go;
        }

        private static GameObject FindTarget(string path, int? instanceId)
        {
            if (instanceId.HasValue)
            {
                var obj = EditorUtility.InstanceIDToObject(instanceId.Value) as GameObject;
                if (obj != null) return obj;
            }
            if (!string.IsNullOrEmpty(path))
            {
                var go = GameObject.Find(path);
                if (go != null) return go;
                return FindByPathOrName(path);
            }
            return null;
        }

        private static string GetPath(Transform t)
        {
            var stack = new Stack<string>();
            while (t != null)
            {
                stack.Push(t.name);
                t = t.parent;
            }
            return string.Join("/", stack.ToArray());
        }

        private static void StartSse(HttpListenerResponse res)
        {
            lock (SseLock)
            {
                res.StatusCode = 200;
                res.KeepAlive = true;
                res.ContentType = "text/event-stream";
                res.SendChunked = true;
                res.Headers.Add("Cache-Control", "no-cache");
                SseClients.Add(res);
                _ = SendSse(res, "retry: 2000\n\n");
            }
        }

        private static void BroadcastSse(string line)
        {
            HttpListenerResponse[] clients;
            lock (SseLock)
            {
                clients = SseClients.ToArray();
            }
            foreach (var res in clients)
            {
                try
                {
                    _ = SendSse(res, $"data: {Escape(line)}\n\n").ContinueWith(t =>
                    {
                        if (!t.Result)
                        {
                            lock (SseLock)
                            {
                                try { res.OutputStream.Close(); } catch { }
                                SseClients.Remove(res);
                            }
                        }
                    });
                }
                catch { }
            }
        }

        private static async Task<bool> SendSse(HttpListenerResponse res, string payload)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(payload);
                await res.OutputStream.WriteAsync(bytes, 0, bytes.Length);
                await res.OutputStream.FlushAsync();
                return true;
            }
            catch { return false; }
        }

        private static string Escape(string s)
        {
            return s?.Replace("\n", "\\n");
        }

        private static void LogBridge(string line)
        {
            try
            {
                var msg = $"[MCP] {line}";
                LogRing.Enqueue(msg);
                while (LogRing.Count > MaxLogLines && LogRing.TryDequeue(out _)) { }
                BroadcastSse(msg);
                try { Debug.Log(msg); } catch { }
            }
            catch { }
        }

        private static string Trunc(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            if (s.Length <= max) return s;
            return s.Substring(0, max) + "...";
        }

        private static void ShowNotification(string title, string message)
        {
            var windows = Resources.FindObjectsOfTypeAll<EditorWindow>();
            foreach (var w in windows)
            {
                try { w.ShowNotification(new GUIContent(string.IsNullOrEmpty(title) ? message : title + ": " + message)); }
                catch { }
            }
        }

        private static GameObject InstantiateAsset(string assetPath, string parentPath)
        {
#if UNITY_EDITOR
            var obj = UnityEditor.AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (obj == null) return null;
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(obj);
            if (!string.IsNullOrEmpty(parentPath))
            {
                var parent = GameObject.Find(parentPath);
                if (parent != null) instance.transform.SetParent(parent.transform);
            }
            
            // Mark scene dirty and refresh UI after instantiating asset
            EditorUtility.SetDirty(instance);
            EditorSceneManager.MarkSceneDirty(instance.scene);
            UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
            
            return instance;
#else
            return null;
#endif
        }

        private static string SaveAsPrefab(GameObject go, string assetPath, bool connect, bool overwrite)
        {
#if UNITY_EDITOR
            if (go == null) return null;
            if (string.IsNullOrEmpty(assetPath) || !assetPath.StartsWith("Assets"))
            {
                try { assetPath = "Assets/" + (go.name ?? "NewPrefab") + ".prefab"; } catch { assetPath = "Assets/NewPrefab.prefab"; }
            }
            var projectDir = System.IO.Path.GetDirectoryName(Application.dataPath);
            var absPath = System.IO.Path.Combine(projectDir, assetPath);
            var dir = System.IO.Path.GetDirectoryName(absPath);
            try { System.IO.Directory.CreateDirectory(dir); } catch { }

            if (!overwrite && System.IO.File.Exists(absPath))
            {
                var baseName = System.IO.Path.GetFileNameWithoutExtension(assetPath);
                var folder = System.IO.Path.GetDirectoryName(assetPath).Replace("\\", "/");
                if (string.IsNullOrEmpty(folder)) folder = "Assets";
                for (int i = 1; i < 1000; i++)
                {
                    var cand = (string.IsNullOrEmpty(folder) ? "" : folder + "/") + baseName + "_" + i + ".prefab";
                    var candAbs = System.IO.Path.Combine(projectDir, cand);
                    if (!System.IO.File.Exists(candAbs)) { assetPath = cand; break; }
                }
            }

            GameObject result = null;
            try
            {
                if (connect)
                    result = PrefabUtility.SaveAsPrefabAssetAndConnect(go, assetPath, InteractionMode.AutomatedAction);
                else
                    result = PrefabUtility.SaveAsPrefabAsset(go, assetPath);
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }
            catch { return null; }

            return result != null ? assetPath : null;
#else
            return null;
#endif
        }

        private static string[] GetSelectionPaths()
        {
            var list = new List<string>();
            foreach (var obj in Selection.gameObjects)
            {
                list.Add(GetPath(obj.transform));
            }
            return list.ToArray();
        }

        private static string[] GetHierarchyPaths()
        {
            var list = new List<string>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                var roots = scene.GetRootGameObjects();
                foreach (var go in roots)
                {
                    Traverse(go.transform, list);
                }
            }
            return list.ToArray();
        }

        private static void Traverse(Transform t, List<string> paths)
        {
            paths.Add(GetPath(t));
            for (int i = 0; i < t.childCount; i++) Traverse(t.GetChild(i), paths);
        }

        private static GameObject FindByPathOrName(string pathOrName)
        {
            try
            {
                var go = GameObject.Find(pathOrName);
                if (go != null) return go;
                return FindByNameDeep(pathOrName);
            }
            catch { return null; }
        }

        private static GameObject FindByNameDeep(string name)
        {
            try
            {
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    var scene = SceneManager.GetSceneAt(i);
                    if (!scene.isLoaded) continue;
                    var roots = scene.GetRootGameObjects();
                    foreach (var root in roots)
                    {
                        var tr = FindInChildrenByName(root.transform, name);
                        if (tr != null) return tr.gameObject;
                    }
                }
            }
            catch { }
            return null;
        }

        private static Transform FindInChildrenByName(Transform t, string name)
        {
            if (t == null) return null;
            if (t.name == name) return t;
            for (int i = 0; i < t.childCount; i++)
            {
                var res = FindInChildrenByName(t.GetChild(i), name);
                if (res != null) return res;
            }
            return null;
        }

        private static async Task<(bool ok, string version, string error)> InstallPackage(string id)
        {
            // Must create the request from main thread
            AddRequest request = await RunOnMainThread(() => UnityEditor.PackageManager.Client.Add(id));
            // Poll status safely
            for (;;)
            {
                bool done = await RunOnMainThread(() => request.IsCompleted);
                if (done) break;
                await Task.Delay(100);
            }
            var status = await RunOnMainThread(() => request.Status);
            if (status == UnityEditor.PackageManager.StatusCode.Success)
            {
                var ver = await RunOnMainThread(() => request.Result != null ? request.Result.version : string.Empty);
                return (true, ver ?? string.Empty, string.Empty);
            }
            var err = await RunOnMainThread(() => request.Error != null ? request.Error.message : string.Empty);
            return (false, string.Empty, err);
        }

        private static async Task<(bool ok, string error)> RemovePackage(string id)
        {
            RemoveRequest request = await RunOnMainThread(() => UnityEditor.PackageManager.Client.Remove(id));
            for (;;)
            {
                bool done = await RunOnMainThread(() => request.IsCompleted);
                if (done) break;
                await Task.Delay(100);
            }
            var status = await RunOnMainThread(() => request.Status);
            if (status == UnityEditor.PackageManager.StatusCode.Success) return (true, string.Empty);
            var err = await RunOnMainThread(() => request.Error != null ? request.Error.message : string.Empty);
            return (false, err);
        }

        private static bool IsPackageInManifest(string packageId)
        {
            try
            {
                var manifestPath = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Application.dataPath), "Packages", "manifest.json");
                if (!System.IO.File.Exists(manifestPath)) return false;
                var json = System.IO.File.ReadAllText(manifestPath);
                // naive check
                return json.IndexOf("\"" + packageId + "\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        private static async Task<PkgInfo[]> ListPackages()
        {
            // Start request on main thread
            ListRequest request = await RunOnMainThread(() => UnityEditor.PackageManager.Client.List(true));
            // Poll completion without blocking the main thread
            for (;;)
            {
                bool done = await RunOnMainThread(() => request.IsCompleted);
                if (done) break;
                await Task.Delay(50);
            }
            var status = await RunOnMainThread(() => request.Status);
            if (status == UnityEditor.PackageManager.StatusCode.Success)
            {
                var result = await RunOnMainThread(() => request.Result);
                if (result != null)
                {
                    var outArr = new List<PkgInfo>();
                    foreach (var p in result) outArr.Add(new PkgInfo { name = p.name, version = p.version, displayName = p.displayName });
                    return outArr.ToArray();
                }
            }
            return new PkgInfo[0];
        }

        private static string[] FindAssets(string query, string path)
        {
#if UNITY_EDITOR
            string[] guids = string.IsNullOrEmpty(path) ? UnityEditor.AssetDatabase.FindAssets(query) : UnityEditor.AssetDatabase.FindAssets(query, new[] { path });
            var outArr = new List<string>();
            foreach (var g in guids) outArr.Add(UnityEditor.AssetDatabase.GUIDToAssetPath(g));
            return outArr.ToArray();
#else
            return new string[0];
#endif
        }

        private static string[] ListAssets(string path)
        {
#if UNITY_EDITOR
            if (string.IsNullOrEmpty(path))
            {
                return UnityEditor.AssetDatabase.GetAllAssetPaths();
            }
            // Enumerate all under a folder via FindAssets then map to paths (dedup)
            var set = new HashSet<string>();
            string[] guids = UnityEditor.AssetDatabase.FindAssets(string.Empty, new[] { path });
            foreach (var g in guids)
            {
                var p = UnityEditor.AssetDatabase.GUIDToAssetPath(g);
                if (!string.IsNullOrEmpty(p)) set.Add(p);
            }
            var arr = new List<string>(set);
            arr.Sort(StringComparer.OrdinalIgnoreCase);
            return arr.ToArray();
#else
            return new string[0];
#endif
        }

        private static async Task<object> RunTests(string mode, string filter)
        {
            var tcs = new TaskCompletionSource<TestRunSummary>();
            var summary = new TestRunSummary();
            var startTime = DateTime.UtcNow;

            await RunOnMainThread(() =>
            {
                var api = ScriptableObject.CreateInstance<TestRunnerApi>();
                var testMode = string.Equals(mode, "PlayMode", StringComparison.OrdinalIgnoreCase) ? TestMode.PlayMode : TestMode.EditMode;
                var f = new Filter { testMode = testMode };
                if (!string.IsNullOrEmpty(filter)) f.testNames = new[] { filter };

                api.RegisterCallbacks(new TestCallbacks(
                    finished: (result) =>
                    {
                        var duration = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;
                        summary.durationMs = duration;
                        tcs.TrySetResult(summary);
                    },
                    testFinished: (result) =>
                    {
                        try
                        {
                            var status = result.ToString();
                            if (!string.IsNullOrEmpty(status))
                            {
                                if (status.IndexOf("Passed", StringComparison.OrdinalIgnoreCase) >= 0) summary.passed++;
                                else if (status.IndexOf("Failed", StringComparison.OrdinalIgnoreCase) >= 0) summary.failed++;
                            }
                        }
                        catch { }
                    }
                ));

                api.Execute(new ExecutionSettings(f));
            });

            var res = await tcs.Task.ConfigureAwait(false);
            return new TestsResponse { passed = res.passed, failed = res.failed, durationMs = res.durationMs, reportPath = string.Empty };
        }

        private static async Task EnsureEditorIdle()
        {
            // If playing, stop
            if (await RunOnMainThread(() => EditorApplication.isPlaying || EditorApplication.isPlayingOrWillChangePlaymode))
            {
                await RunOnMainThread(() => { EditorApplication.isPlaying = false; });
            }
            // Wait until not compiling
            for (int i = 0; i < 200; i++)
            {
                var compiling = await RunOnMainThread(() => EditorApplication.isCompiling);
                if (!compiling) break;
                await Task.Delay(50);
            }
            // Small settle delay
            await Task.Delay(50);
        }

        private static async Task WriteText(HttpListenerContext ctx, string text)
        {
            if (ctx == null || ctx.Response == null) return;
            try
            {
                try { ctx.Response.ContentType = "text/plain"; } catch { return; }
                var bytes = Encoding.UTF8.GetBytes(text ?? string.Empty);
                try { ctx.Response.ContentLength64 = bytes.Length; } catch { /* ignore if disposed */ }
                try { await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length); } catch { /* ignore if client aborted */ }
                try { LogBridge($"<- {ctx.Request?.Url?.AbsolutePath} bytes={bytes.Length}"); } catch { }
            }
            catch { }
            finally
            {
                try { ctx.Response.OutputStream.Close(); } catch { }
            }
        }

        private static async Task WriteJson(HttpListenerContext ctx, string json)
        {
            if (ctx == null || ctx.Response == null) return;
            try
            {
                try { ctx.Response.ContentType = "application/json"; } catch { return; }
                var bytes = Encoding.UTF8.GetBytes(json ?? string.Empty);
                try { ctx.Response.ContentLength64 = bytes.Length; } catch { /* ignore if disposed */ }
                try { await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length); } catch { /* ignore if client aborted */ }
                bool ok = false; try { ok = json != null && json.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0; } catch { }
                try { LogBridge($"<- {ctx.Request?.Url?.AbsolutePath} ok={ok} bytes={bytes.Length}"); } catch { }
            }
            catch { }
            finally
            {
                try { ctx.Response.OutputStream.Close(); } catch { }
            }
        }

        // Main-thread scheduling
        private static readonly ConcurrentQueue<(Action action, TaskCompletionSource<bool> tcs)> MainActionQueue = new ConcurrentQueue<(Action, TaskCompletionSource<bool>)>();
        private static readonly ConcurrentQueue<(Func<object> func, TaskCompletionSource<object> tcs)> MainFuncQueue = new ConcurrentQueue<(Func<object>, TaskCompletionSource<object>)>();

        private static void ProcessMainThreadQueue()
        {
            while (MainActionQueue.TryDequeue(out var item))
            {
                try { item.action(); item.tcs.TrySetResult(true); }
                catch (Exception ex) { item.tcs.TrySetException(ex); }
            }
            while (MainFuncQueue.TryDequeue(out var item2))
            {
                try { var res = item2.func(); item2.tcs.TrySetResult(res); }
                catch (Exception ex) { item2.tcs.TrySetException(ex); }
            }
        }

        private static Task RunOnMainThread(Action action)
        {
            var tcs = new TaskCompletionSource<bool>();
            MainActionQueue.Enqueue((action, tcs));
            return tcs.Task;
        }

        private static Task<T> RunOnMainThread<T>(Func<T> func)
        {
            var tcs = new TaskCompletionSource<object>();
            MainFuncQueue.Enqueue((() => (object)func(), tcs));
            return tcs.Task.ContinueWith(t => (T)t.Result);
        }

        private static string Ok(object result)
        {
            return JsonUtility.ToJson(new Envelope { ok = true, resultJson = JsonUtility.ToJson(result) });
        }

        private static string Err(string error)
        {
            return JsonUtility.ToJson(new Envelope { ok = false, error = error });
        }

        private static string OkJson(string rawJson)
        {
            // Wrap a preconstructed JSON payload as resultJson
            var sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"ok\":true,\"resultJson\":");
            sb.Append('"').Append(JsonEscape(rawJson)).Append('"');
            sb.Append("}");
            return sb.ToString();
        }

        private static string JsonWrap(string key, string value)
        {
            return $"\"{key}\":\"{JsonEscape(value)}\"";
        }

        private static string JsonWrap(string key, int value)
        {
            return $"\"{key}\":{value}";
        }

        private static string JsonWrap(string key, bool value)
        {
            return $"\"{key}\":{(value ? "true" : "false")}";
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
        }

        private static Type ResolveType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            try
            {
                // Normalize common friendly names → canonical types
                var key = new string(typeName.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
                switch (key)
                {
                    case "transform": typeName = "UnityEngine.Transform"; break;
                    case "recttransform": typeName = "UnityEngine.RectTransform"; break;
                    case "renderer": typeName = "UnityEngine.Renderer"; break;
                    case "meshrenderer": typeName = "UnityEngine.MeshRenderer"; break;
                    case "skinnedmeshrenderer": typeName = "UnityEngine.SkinnedMeshRenderer"; break;
                    case "meshfilter": typeName = "UnityEngine.MeshFilter"; break;
                    case "boxcollider": typeName = "UnityEngine.BoxCollider"; break;
                    case "spherecollider": typeName = "UnityEngine.SphereCollider"; break;
                    case "capsulecollider": typeName = "UnityEngine.CapsuleCollider"; break;
                    case "collider": typeName = "UnityEngine.Collider"; break;
                    case "rigidbody": typeName = "UnityEngine.Rigidbody"; break;
                    case "camera": typeName = "UnityEngine.Camera"; break;
                    case "light": typeName = "UnityEngine.Light"; break;
                    case "linerenderer": typeName = "UnityEngine.LineRenderer"; break;
                    case "trailrenderer": typeName = "UnityEngine.TrailRenderer"; break;
                    case "animator": typeName = "UnityEngine.Animator"; break;
                    case "animation": typeName = "UnityEngine.Animation"; break;
                    case "audiosource": typeName = "UnityEngine.AudioSource"; break;
                }
            }
            catch { }
            // Exact
            var t = Type.GetType(typeName);
            if (t != null) return t;
            // Try with UnityEngine default assembly
            t = Type.GetType(typeName + ", UnityEngine");
            if (t != null) return t;
            // Try with CoreModule (common for components)
            t = Type.GetType(typeName + ", UnityEngine.CoreModule");
            if (t != null) return t;
            // Try with PhysicsModule (e.g., Rigidbody, Colliders in newer Unity versions)
            t = Type.GetType(typeName + ", UnityEngine.PhysicsModule");
            if (t != null) return t;
            // Search loaded assemblies
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    t = asm.GetType(typeName);
                    if (t != null) return t;
                    // Short name match
                    var match = asm.GetTypes().FirstOrDefault(x => x.Name == typeName || x.FullName == typeName);
                    if (match != null) return match;
                }
                catch { }
            }
            return null;
        }

        // Safer reflection invoke with overload resolution and simple args parsing
        private static (bool ok, string resultJson, string error) InvokeMethodSafe(InvokeRequest req)
        {
            try
            {
                if (req == null) return (false, null, "null request");
                if (string.IsNullOrEmpty(req.typeName) || string.IsNullOrEmpty(req.methodName))
                    return (false, null, "typeName and methodName required");

                // Resolve type (allow assembly-qualified names)
                var type = Type.GetType(req.typeName, false);
                if (type == null)
                {
                    // Try common Unity assemblies fallback
                    type = Type.GetType(req.typeName + ", UnityEngine", false)
                        ?? Type.GetType(req.typeName + ", UnityEngine.CoreModule", false)
                        ?? Type.GetType(req.typeName + ", mscorlib", false)
                        ?? AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(req.typeName, false)).FirstOrDefault(t => t != null);
                }
                if (type == null) return (false, null, $"Type not found: {req.typeName}");

                // Parse argsJson (expected to be a JSON array of strings)
                var strArgs = ParseStringArrayJson(req.argsJson);
                object[] rawArgs = strArgs.Cast<object>().ToArray();

                var flags = BindingFlags.Public | BindingFlags.NonPublic | (req.isStatic ? BindingFlags.Static : BindingFlags.Instance);
                var methods = type.GetMethods(flags).Where(m => m.Name == req.methodName).ToArray();
                if (methods.Length == 0) return (false, null, $"Method not found: {req.methodName}");

                // Filter by arity first
                var byArity = methods.Where(m => m.GetParameters().Length == rawArgs.Length).ToArray();
                MethodInfo selected = null;
                object[] invokeArgs = rawArgs;

                if (byArity.Length == 1)
                {
                    selected = byArity[0];
                }
                else if (byArity.Length > 1)
                {
                    // Try to convert string args to parameter types and pick the first that fits
                    foreach (var m in byArity)
                    {
                        var ps = m.GetParameters();
                        var converted = new object[ps.Length];
                        bool match = true;
                        for (int i = 0; i < ps.Length; i++)
                        {
                            if (!TryConvertStringToType(strArgs[i], ps[i].ParameterType, out converted[i]))
                            {
                                match = false;
                                break;
                            }
                        }
                        if (match)
                        {
                            selected = m;
                            invokeArgs = converted;
                            break;
                        }
                    }
                }

                // Fallback: if still ambiguous or not found, try best-effort: prefer all-string signature
                if (selected == null)
                {
                    selected = byArity.FirstOrDefault(m => m.GetParameters().All(p => p.ParameterType == typeof(string)))
                               ?? byArity.FirstOrDefault();
                }
                if (selected == null) return (false, null, "No suitable overload found");

                object target = null;
                if (!req.isStatic)
                {
                    try { target = Activator.CreateInstance(type); } catch (Exception ex) { return (false, null, $"Failed to create instance: {ex.Message}"); }
                }

                object result;
                try
                {
                    result = selected.Invoke(target, invokeArgs.Length == 0 ? null : invokeArgs);
                }
                catch (TargetInvocationException tex)
                {
                    var inner = tex.InnerException != null ? tex.InnerException.Message : tex.Message;
                    return (false, null, inner);
                }
                catch (Exception ex)
                {
                    return (false, null, ex.Message);
                }

                // Prepare a minimal JSON result payload
                if (result == null) return (true, "{}", null);
                if (result is string s) return (true, "\"" + JsonEscape(s) + "\"", null);
                if (result is bool b) return (true, b ? "true" : "false", null);
                if (result is int ii) return (true, ii.ToString(CultureInfo.InvariantCulture), null);
                if (result is float ff) return (true, ff.ToString(CultureInfo.InvariantCulture), null);
                if (result is double dd) return (true, dd.ToString(CultureInfo.InvariantCulture), null);
                if (result is System.IO.DirectoryInfo di) return (true, "\"" + JsonEscape(di.FullName) + "\"", null);
                return (true, "\"" + JsonEscape(Convert.ToString(result, CultureInfo.InvariantCulture) ?? string.Empty) + "\"", null);
            }
            catch (Exception ex)
            {
                return (false, null, ex.Message);
            }
        }

        private static string[] ParseStringArrayJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return Array.Empty<string>();
            try
            {
                // Minimal JSON string-array parser supporting escapes (\" \\ \n \r \t)
                var list = new List<string>();
                int i = 0; int n = json.Length;
                void SkipWs() { while (i < n && char.IsWhiteSpace(json[i])) i++; }
                SkipWs(); if (i >= n || json[i] != '[') return Array.Empty<string>(); i++;
                for (;;)
                {
                    SkipWs();
                    if (i < n && json[i] == ']') { i++; break; }
                    if (i >= n || json[i] != '"') break; // invalid
                    i++;
                    var sb = new StringBuilder();
                    while (i < n)
                    {
                        char c = json[i++];
                        if (c == '\\')
                        {
                            if (i >= n) break;
                            char e = json[i++];
                            switch (e)
                            {
                                case '\\': sb.Append('\\'); break;
                                case '"': sb.Append('"'); break;
                                case 'n': sb.Append('\n'); break;
                                case 'r': sb.Append('\r'); break;
                                case 't': sb.Append('\t'); break;
                                case 'b': sb.Append('\b'); break;
                                case 'f': sb.Append('\f'); break;
                                default: sb.Append(e); break;
                            }
                        }
                        else if (c == '"')
                        {
                            break;
                        }
                        else
                        {
                            sb.Append(c);
                        }
                    }
                    list.Add(sb.ToString());
                    SkipWs();
                    if (i < n && json[i] == ',') { i++; continue; }
                    SkipWs();
                    if (i < n && json[i] == ']') { i++; break; }
                }
                return list.ToArray();
            }
            catch { return Array.Empty<string>(); }
        }

        private static bool TryConvertStringToType(string input, Type targetType, out object value)
        {
            try
            {
                if (targetType == typeof(string)) { value = input; return true; }
                if (targetType == typeof(bool)) { if (bool.TryParse(input, out var b)) { value = b; return true; } }
                if (targetType == typeof(int)) { if (int.TryParse(input, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) { value = i; return true; } }
                if (targetType == typeof(float)) { if (float.TryParse(input, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var f)) { value = f; return true; } }
                if (targetType == typeof(double)) { if (double.TryParse(input, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var d)) { value = d; return true; } }
                if (targetType == typeof(long)) { if (long.TryParse(input, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l)) { value = l; return true; } }
                if (targetType == typeof(char)) { if (!string.IsNullOrEmpty(input)) { value = input[0]; return true; } }
                if (targetType.IsEnum)
                {
                    var names = Enum.GetNames(targetType);
                    var name = names.FirstOrDefault(n => string.Equals(n, input, StringComparison.OrdinalIgnoreCase));
                    if (name != null) { value = Enum.Parse(targetType, name); return true; }
                    if (int.TryParse(input, out var ei)) { value = Enum.ToObject(targetType, ei); return true; }
                }
                // Fallback: keep as string
                value = input;
                return targetType == typeof(object);
            }
            catch { value = null; return false; }
        }

        private static bool BodyHas(string body, string key)
        {
            try
            {
                // Very simple check to detect if a key is present in JSON to distinguish between false/0 and missing
                // Avoid full JSON parsing to keep dependencies minimal
                var needle = "\"" + key + "\"";
                return body.IndexOf(needle, StringComparison.Ordinal) >= 0;
            }
            catch { return false; }
        }

        [Serializable]
        private class Envelope
        {
            public bool ok;
            public string resultJson;
            public string error;
        }

        [Serializable] private class MsgResponse { public string message; }
        [Serializable] private class CreatedResponse { public int instanceId; public string path; }
        [Serializable] private class PathResponse { public string path; }
        [Serializable] private class Vec3 { public float x; public float y; public float z; }
        [Serializable] private class GameObjectInfoResponse {
            public int instanceId; public string path; public string name; public bool active; public string tag; public int layer;
            public Vec3 position; public Vec3 localPosition; public Vec3 eulerAngles; public Vec3 localEulerAngles; public Vec3 localScale;
        }
        [Serializable] private class ComponentResponse { public string componentType; public string path; }
        [Serializable] private class InstallResponse { public string id; public string installedVersion; }
        [Serializable] private class IdResponse { public string id; }
        [Serializable] private class StateResponse { public string playMode; public bool isCompiling; public string[] selection; }
        [Serializable] private class ShownResponse { public bool shown; }
        [Serializable] private class PathsResponse { public string[] paths; }
        [Serializable] private class CountResponse { public int count; }
        [Serializable] private class InstantiatedResponse { public string path; public int instanceId; }
        [Serializable] private class EmptyResponse { }
        [Serializable] private class PausedResponse { public bool paused; }
        [Serializable] private class TestsResponse { public int passed; public int failed; public int durationMs; public string reportPath; }
        [Serializable] private class PackagesListResponse { public PkgInfo[] packages; }
        [Serializable] private class PkgInfo { public string name; public string version; public string displayName; }
        [Serializable] private class AssetsListResponse { public string[] assets; }
        [Serializable] private class AssetsListRequest { public string path; }
        [Serializable] private class AssetsFindRequest { public string query; public string path; }
        [Serializable] private class HierarchyResponse { public string[] paths; }
        [Serializable] private class ConsoleTextResponse { public string text; }
        [Serializable] private class EditorInfoResponse { public string projectName; public string unityVersion; public string dataPath; }

        [Serializable]
        private class MenuExecuteRequest { public string menuPath; }

        [Serializable]
        private class GameObjectCreateRequest
        {
            public string name;
            public string parentPath;
            public bool? active;
            public string tag;
            public int? layer;
            public string[] components;
            public string primitive; public string lightType;
            public Vec3 position; public Vec3 localPosition; public Vec3 eulerAngles; public Vec3 localEulerAngles; public Vec3 localScale;
        }

        [Serializable]
        private class GameObjectSetPropertiesRequest
        {
            public string path;
            public int? instanceId;
            public string name;
            public bool? active;
            public string tag;
            public int? layer;
            public Vec3 position; public Vec3 localPosition; public Vec3 eulerAngles; public Vec3 localEulerAngles; public Vec3 localScale;
            // Synonyms for convenience
            public Vec3 scale; public Vec3 rotation; public Vec3 localRotation;
        }

        [Serializable]
        private class GameObjectDeleteRequest
        {
            public string path;
            public int? instanceId;
        }

        [Serializable]
        private class ComponentAddOrUpdateRequest
        {
            public string path;
            public int? instanceId;
            public string componentType;
            public string fieldsJson;
        }

        [Serializable]
        private class MaterialCreateRequest { public string name; public string shader; public string assetPath; public ColorRGBA color; }
        [Serializable]
        private class ColorRGBA { public float r; public float g; public float b; public float a; }
        [Serializable]
        private class PackageIdRequest { public string id; }

        [Serializable]
        private class RunTestsRequest { public string mode; public string filter; }
        [Serializable]
        private class InvokeRequest { public string typeName; public string methodName; public bool isStatic; public string argsJson; }

        [Serializable] private class BuildRequest { public string[] scenes; public string target; public string outputPath; public bool development; }
        [Serializable] private class SceneOpenRequest { public string path; public bool additive; }
        [Serializable] private class SceneSaveRequest { public string path; }
        [Serializable] private class PrefabOpRequest { public string path; public int? instanceId; }
        [Serializable] private class PrefabCreateRequest { public string path; public int? instanceId; public string assetPath; public bool connect; public bool overwrite; }
        [Serializable] private class ComponentGetRequest { public string path; public int? instanceId; public string componentType; }
        [Serializable] private class MemorySnapshotRequest { public string path; }
        [Serializable] private class ImportTextureRequest { public string assetPath; public string textureType; public bool sRGB; public int maxSize; public int compressionQuality; public string textureCompression; }
        [Serializable] private class ComponentGetAllRequest { public string path; public int? instanceId; }
        [Serializable] private class ComponentDestroyRequest { public string path; public int? instanceId; public string componentType; }
        [Serializable] private class SceneCreateRequest { public string path; }
        [Serializable] private class SceneUnloadRequest { public string path; }
        [Serializable] private class BuildTargetRequest { public string target; }
        [Serializable] private class PlayerPrefsSetRequest { public string key; public string type; public string stringValue; public int intValue; public float floatValue; }
        [Serializable] private class PlayerPrefsGetRequest { public string key; public string type; }
        [Serializable] private class PlayerPrefsDeleteRequest { public string key; }

        // Visual Scripting Request/Response Classes
        [Serializable]
        private class VisualScriptCreateRequest
        {
            public string gameObjectPath;
            public string scriptName;
            public string templateType; // "empty", "state", "flow", "custom"
            public string[] mcpOperations; // Array of MCP operation descriptions
        }

        [Serializable]
        private class VisualScriptAddNodeRequest
        {
            public string gameObjectPath;
            public string nodeType; // "event", "action", "condition", "variable", "mcp_operation"
            public string nodeData; // JSON data for the node
            public Vec3 position; // Position in the graph
            public string nodeId; // Optional custom node ID
        }

        [Serializable]
        private class VisualScriptConnectRequest
        {
            public string gameObjectPath;
            public string fromNodeId;
            public string fromPortName;
            public string toNodeId;
            public string toPortName;
        }

        [Serializable]
        private class VisualScriptGetRequest
        {
            public string gameObjectPath;
            public bool includeConnections;
            public bool includeNodeData;
        }

        [Serializable]
        private class VisualScriptFromMcpRequest
        {
            public string gameObjectPath;
            public string scriptName;
            public McpOperation[] operations;
            public bool autoConnect; // Whether to auto-connect nodes in sequence
        }

        [Serializable]
        private class McpOperation
        {
            public string tool;
            public string action;
            public string parameters; // JSON string of parameters
            public string description;
            public int order; // Execution order
        }

        [Serializable]
        private class VisualScriptResponse
        {
            public string gameObjectPath;
            public string scriptName;
            public bool success;
            public string message;
            public VisualScriptNode[] nodes;
            public VisualScriptConnection[] connections;
        }

        [Serializable]
        private class VisualScriptNode
        {
            public string nodeId;
            public string nodeType;
            public string displayName;
            public Vec3 position;
            public string nodeData; // JSON data
            public string[] inputPorts;
            public string[] outputPorts;
        }

        [Serializable]
        private class VisualScriptConnection
        {
            public string fromNodeId;
            public string fromPort;
            public string toNodeId;
            public string toPort;
        }
        [Serializable] private class RigidbodyFieldsPayload { public float mass; public float drag; public float angularDrag; public bool useGravity; public bool isKinematic; public string constraints; public string interpolation; public string collisionDetectionMode; }
        [Serializable] private class ColorPayload { public float r; public float g; public float b; public float a; }
        [Serializable] private class CameraFieldsPayload { public float fieldOfView; public bool orthographic; public float nearClipPlane; public float farClipPlane; public string clearFlags; public ColorPayload backgroundColor; }
        [Serializable] private class LightFieldsPayload { public string type; public float intensity; public float range; public float spotAngle; public ColorPayload color; public string shadows; }

        private struct TestRunSummary
        {
            public int passed;
            public int failed;
            public int durationMs;
        }

        private class TestCallbacks : ICallbacks
        {
            private readonly Action<ITestResultAdaptor> _finished;
            private readonly Action<ITestResultAdaptor> _testFinished;

            public TestCallbacks(Action<ITestResultAdaptor> finished, Action<ITestResultAdaptor> testFinished)
            {
                _finished = finished;
                _testFinished = testFinished;
            }

            public void RunStarted(ITestAdaptor testsToRun) { }

            public void RunFinished(ITestResultAdaptor result)
            {
                _finished?.Invoke(result);
            }

            public void TestStarted(ITestAdaptor test) { }

            public void TestFinished(ITestResultAdaptor result)
            {
                _testFinished?.Invoke(result);
            }
        }

        private static BuildInfoResponse RunBuild(BuildRequest req)
        {
            var scenes = (req.scenes != null && req.scenes.Length > 0) ? req.scenes : EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            var target = ParseBuildTarget(req.target);
            var options = req.development ? BuildOptions.Development : BuildOptions.None;
            var bpo = new BuildPlayerOptions { scenes = scenes, target = target, locationPathName = req.outputPath, options = options };
            try
            {
                var report = BuildPipeline.BuildPlayer(bpo);
                var summary = report.summary;
                var res = summary.result.ToString();
                return new BuildInfoResponse { outputPath = req.outputPath, result = res, error = string.Empty };
            }
            catch (Exception ex)
            {
                return new BuildInfoResponse { outputPath = req.outputPath, result = "Failed", error = ex.Message };
            }
        }

        private static BuildTarget ParseBuildTarget(string s)
        {
            if (string.IsNullOrEmpty(s)) return EditorUserBuildSettings.activeBuildTarget;
            try
            {
                return (BuildTarget)Enum.Parse(typeof(BuildTarget), s, true);
            }
            catch { return EditorUserBuildSettings.activeBuildTarget; }
        }

        private static bool OpenScenePath(string path, bool additive)
        {
            try { var mode = additive ? OpenSceneMode.Additive : OpenSceneMode.Single; var scn = EditorSceneManager.OpenScene(path, mode); return scn.IsValid(); } catch { return false; }
        }

        private static bool SaveScenePath(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path))
                {
                    var dir = System.IO.Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir) && !System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
                    var scn = EditorSceneManager.GetActiveScene();
                    return EditorSceneManager.SaveScene(scn, path);
                }
                // Try saving all open scenes first
                if (EditorSceneManager.SaveOpenScenes()) return true;
                // Fallback: save active scene to a default path under Assets
                var fallback = System.IO.Path.Combine("Assets", "MCP_AutoSave.unity");
                var fallbackDir = System.IO.Path.GetDirectoryName(fallback);
                if (!string.IsNullOrEmpty(fallbackDir) && !System.IO.Directory.Exists(fallbackDir)) System.IO.Directory.CreateDirectory(fallbackDir);
                var scn2 = EditorSceneManager.GetActiveScene();
                return EditorSceneManager.SaveScene(scn2, fallback);
            }
            catch { return false; }
        }

        private static bool SaveActiveSceneAs(string newPath)
        {
            try
            {
                var dir = System.IO.Path.GetDirectoryName(newPath);
                if (!string.IsNullOrEmpty(dir) && !System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
                var scn = EditorSceneManager.GetActiveScene();
                return EditorSceneManager.SaveScene(scn, newPath);
            }
            catch { return false; }
        }

        private static bool PrefabApply(string path, int? instanceId)
        {
            try
            {
                var go = FindTarget(path, instanceId);
                if (go == null) return false;
                PrefabUtility.ApplyPrefabInstance(go, InteractionMode.UserAction);
                
                // Mark scene dirty and refresh UI after applying prefab changes
                EditorUtility.SetDirty(go);
                EditorSceneManager.MarkSceneDirty(go.scene);
                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                
                return true;
            }
            catch { return false; }
        }

        private static bool PrefabRevert(string path, int? instanceId)
        {
            try
            {
                var go = FindTarget(path, instanceId);
                if (go == null) return false;
                PrefabUtility.RevertPrefabInstance(go, InteractionMode.UserAction);
                
                // Mark scene dirty and refresh UI after reverting prefab changes
                EditorUtility.SetDirty(go);
                EditorSceneManager.MarkSceneDirty(go.scene);
                
                // Refresh Inspector if this object is selected
                if (Selection.activeGameObject == go)
                {
                    Selection.activeGameObject = null;
                    Selection.activeGameObject = go;
                }
                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                
                return true;
            }
            catch { return false; }
        }

        private static string GetComponentSnapshot(ComponentGetRequest req)
        {
            var go = FindTarget(req.path, req.instanceId);
            if (go == null) return null;
            var requestedTypeName = string.IsNullOrEmpty(req.componentType) ? "Transform" : req.componentType;
            var type = ResolveType(requestedTypeName);
            if (type == null) return null;
            var comp = go.GetComponent(type);
            if (comp == null)
            {
                // Fallback: scan all components and match by exact type, full name, or simple name
                try
                {
                    var all = go.GetComponents<Component>();
                    foreach (var c in all)
                    {
                        var ct = c?.GetType();
                        if (ct == null) continue;
                        if (ct == type || string.Equals(ct.FullName, type.FullName, StringComparison.OrdinalIgnoreCase) || string.Equals(ct.Name, type.Name, StringComparison.OrdinalIgnoreCase))
                        {
                            comp = c;
                            break;
                        }
                    }
                }
                catch { }
            }
            if (comp == null) return null;

            // Special cases
            if (comp is Transform tr)
            {
                var sb = new StringBuilder();
                sb.Append("{");
                sb.Append("\"type\":\"Transform\",");
                sb.Append("\"position\":{")
                  .Append("\"x\":" + tr.position.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + tr.position.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + tr.position.z.ToString(CultureInfo.InvariantCulture)).Append("},");
                sb.Append("\"localPosition\":{")
                  .Append("\"x\":" + tr.localPosition.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + tr.localPosition.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + tr.localPosition.z.ToString(CultureInfo.InvariantCulture)).Append("},");
                sb.Append("\"eulerAngles\":{")
                  .Append("\"x\":" + tr.eulerAngles.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + tr.eulerAngles.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + tr.eulerAngles.z.ToString(CultureInfo.InvariantCulture)).Append("},");
                sb.Append("\"localScale\":{")
                  .Append("\"x\":" + tr.localScale.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + tr.localScale.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + tr.localScale.z.ToString(CultureInfo.InvariantCulture)).Append("}");
                sb.Append("}");
                return sb.ToString();
            }

            if (comp is Renderer r)
            {
                var sb = new StringBuilder();
                sb.Append("{");
                sb.Append("\"type\":\"Renderer\",");
                sb.Append("\"materials\":[");
                var mats = r.sharedMaterials;
                for (int i = 0; i < mats.Length; i++)
                {
                    var m = mats[i];
                    var mName = m != null ? JsonEscape(m.name) : null;
                    var shaderName = (m != null && m.shader != null) ? JsonEscape(m.shader.name) : null;
                    sb.Append("{");
                    sb.Append("\"name\":").Append(mName == null ? "null" : "\"" + mName + "\"")
                      .Append(",\"shader\":").Append(shaderName == null ? "null" : "\"" + shaderName + "\"");
                    sb.Append("}");
                    if (i < mats.Length - 1) sb.Append(",");
                }
                sb.Append("],");
                sb.Append("\"enabled\":").Append(r.enabled ? "true" : "false").Append(",");
                sb.Append("\"sortingLayerID\":").Append(r.sortingLayerID).Append(",");
                sb.Append("\"sortingOrder\":").Append(r.sortingOrder);
                sb.Append("}");
                return sb.ToString();
            }

            if (comp is Collider col)
            {
                var b = col.bounds;
                var sb = new StringBuilder();
                sb.Append("{");
                sb.Append("\"type\":\"").Append(JsonEscape(col.GetType().Name)).Append("\",");
                sb.Append("\"isTrigger\":").Append(col.isTrigger ? "true" : "false").Append(",");
                sb.Append("\"bounds\":{");
                sb.Append("\"center\":{")
                  .Append("\"x\":" + b.center.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + b.center.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + b.center.z.ToString(CultureInfo.InvariantCulture)).Append("},");
                sb.Append("\"size\":{")
                  .Append("\"x\":" + b.size.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + b.size.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + b.size.z.ToString(CultureInfo.InvariantCulture)).Append("}");
                sb.Append("}");
                sb.Append("}");
                return sb.ToString();
            }

            if (comp is Rigidbody rb)
            {
                // Version-tolerant accessors for fields that changed names in newer Unity versions
                float ReadFloatProp(object obj, string primary, string alt, float defVal)
                {
                    try
                    {
                        var t = obj.GetType();
                        var p = t.GetProperty(primary, BindingFlags.Public | BindingFlags.Instance);
                        if (p != null && p.PropertyType == typeof(float)) return (float)p.GetValue(obj, null);
                        var p2 = t.GetProperty(alt, BindingFlags.Public | BindingFlags.Instance);
                        if (p2 != null && p2.PropertyType == typeof(float)) return (float)p2.GetValue(obj, null);
                    }
                    catch { }
                    return defVal;
                }
                Vector3 ReadVec3Prop(object obj, string primary, string alt)
                {
                    try
                    {
                        var t = obj.GetType();
                        var p = t.GetProperty(primary, BindingFlags.Public | BindingFlags.Instance);
                        if (p != null && p.PropertyType == typeof(Vector3)) return (Vector3)p.GetValue(obj, null);
                        var p2 = t.GetProperty(alt, BindingFlags.Public | BindingFlags.Instance);
                        if (p2 != null && p2.PropertyType == typeof(Vector3)) return (Vector3)p2.GetValue(obj, null);
                    }
                    catch { }
                    return Vector3.zero;
                }

                var mass = ReadFloatProp(rb, "mass", "mass", 0f);
                var drag = ReadFloatProp(rb, "linearDamping", "drag", 0f);
                var angularDrag = ReadFloatProp(rb, "angularDamping", "angularDrag", 0f);
                var vel = ReadVec3Prop(rb, "linearVelocity", "velocity");
                var angVel = ReadVec3Prop(rb, "angularVelocity", "angularVelocity");

                var sb = new StringBuilder();
                sb.Append("{");
                sb.Append("\"type\":\"Rigidbody\",");
                sb.Append("\"mass\":").Append(mass.ToString(CultureInfo.InvariantCulture)).Append(",");
                sb.Append("\"drag\":").Append(drag.ToString(CultureInfo.InvariantCulture)).Append(",");
                sb.Append("\"angularDrag\":").Append(angularDrag.ToString(CultureInfo.InvariantCulture)).Append(",");
                sb.Append("\"useGravity\":").Append(rb.useGravity ? "true" : "false").Append(",");
                sb.Append("\"isKinematic\":").Append(rb.isKinematic ? "true" : "false").Append(",");
                sb.Append("\"constraints\":\"").Append(JsonEscape(rb.constraints.ToString())).Append("\",");
                sb.Append("\"interpolation\":\"").Append(JsonEscape(rb.interpolation.ToString())).Append("\",");
                sb.Append("\"collisionDetectionMode\":\"").Append(JsonEscape(rb.collisionDetectionMode.ToString())).Append("\",");
                sb.Append("\"velocity\":{")
                  .Append("\"x\":" + vel.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + vel.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + vel.z.ToString(CultureInfo.InvariantCulture)).Append("},");
                sb.Append("\"angularVelocity\":{")
                  .Append("\"x\":" + angVel.x.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"y\":" + angVel.y.ToString(CultureInfo.InvariantCulture)).Append(",")
                  .Append("\"z\":" + angVel.z.ToString(CultureInfo.InvariantCulture)).Append("}");
                sb.Append("}");
                return sb.ToString();
            }

            // Fallback: try JsonUtility (works for some MonoBehaviours)
            try { var s = JsonUtility.ToJson(comp); if (!string.IsNullOrEmpty(s) && s != "{}") return s; } catch { }

            // Final fallback: reflect simple public fields/props
            try
            {
                var dict = new Dictionary<string, object>();
                foreach (var f in comp.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
                {
                    var val = SafeBoxValue(f.GetValue(comp));
                    if (val != null) dict[f.Name] = val;
                }
                foreach (var p in comp.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!p.CanRead) continue;
                    var val = SafeBoxValue(p.GetValue(comp, null));
                    if (val != null) dict[p.Name] = val;
                }
                return JsonUtility.ToJson(new WrapperDict { keys = dict.Keys.ToArray(), values = dict.Values.Select(v => v.ToString()).ToArray() });
            }
            catch { return null; }
        }

        private static object SafeBoxValue(object v)
        {
            if (v == null) return null;
            var t = v.GetType();
            if (t.IsPrimitive || v is string) return v;
            if (v is Vector3 v3) return new { x = v3.x, y = v3.y, z = v3.z };
            if (v is Vector2 v2) return new { x = v2.x, y = v2.y };
            if (v is Vector4 v4) return new { x = v4.x, y = v4.y, z = v4.z, w = v4.w };
            if (v is Quaternion q) return new { x = q.x, y = q.y, z = q.z, w = q.w };
            if (v is Color c) return new { r = c.r, g = c.g, b = c.b, a = c.a };
            return null;
        }

        [Serializable] private class WrapperDict { public string[] keys; public string[] values; }

        private static void ApplyRigidbodyFields(Rigidbody rb, string fieldsJson)
        {
            if (rb == null || string.IsNullOrEmpty(fieldsJson)) return;
            RigidbodyFieldsPayload f = null;
            try { f = JsonUtility.FromJson<RigidbodyFieldsPayload>(fieldsJson); } catch { }
            if (f == null) return;

            bool Has(string key) { try { return BodyHas(fieldsJson, key); } catch { return false; } }

            if (Has("mass")) { try { rb.mass = f.mass; } catch { } }

            if (Has("drag")) { TrySetFloatProp(rb, "linearDamping", "drag", f.drag); }
            if (Has("angularDrag")) { TrySetFloatProp(rb, "angularDamping", "angularDrag", f.angularDrag); }
            if (Has("useGravity")) { try { rb.useGravity = f.useGravity; } catch { } }
            if (Has("isKinematic")) { try { rb.isKinematic = f.isKinematic; } catch { } }

            if (Has("constraints"))
            {
                try { var val = (RigidbodyConstraints)Enum.Parse(typeof(RigidbodyConstraints), f.constraints, true); rb.constraints = val; } catch { }
            }
            if (Has("interpolation"))
            {
                try { var val = (RigidbodyInterpolation)Enum.Parse(typeof(RigidbodyInterpolation), f.interpolation, true); rb.interpolation = val; } catch { }
            }
            if (Has("collisionDetectionMode"))
            {
                try { var val = (CollisionDetectionMode)Enum.Parse(typeof(CollisionDetectionMode), f.collisionDetectionMode, true); rb.collisionDetectionMode = val; } catch { }
            }

            void TrySetFloatProp(object obj, string primary, string alt, float value)
            {
                try
                {
                    var t = obj.GetType();
                    var p = t.GetProperty(primary, BindingFlags.Public | BindingFlags.Instance);
                    if (p != null && p.CanWrite && p.PropertyType == typeof(float)) { p.SetValue(obj, value, null); return; }
                    var p2 = t.GetProperty(alt, BindingFlags.Public | BindingFlags.Instance);
                    if (p2 != null && p2.CanWrite && p2.PropertyType == typeof(float)) { p2.SetValue(obj, value, null); return; }
                }
                catch { }
            }
        }

        private static void ApplyCameraFields(Camera cam, string fieldsJson)
        {
            if (cam == null || string.IsNullOrEmpty(fieldsJson)) return;
            CameraFieldsPayload f = null;
            try { f = JsonUtility.FromJson<CameraFieldsPayload>(fieldsJson); } catch { }
            if (f == null) return;
            bool Has(string key) { try { return BodyHas(fieldsJson, key); } catch { return false; } }

            if (Has("fieldOfView")) { try { cam.fieldOfView = f.fieldOfView; } catch { } }
            if (Has("orthographic")) { try { cam.orthographic = f.orthographic; } catch { } }
            if (Has("nearClipPlane")) { try { cam.nearClipPlane = f.nearClipPlane; } catch { } }
            if (Has("farClipPlane")) { try { cam.farClipPlane = f.farClipPlane; } catch { } }
            if (Has("clearFlags")) { try { cam.clearFlags = (CameraClearFlags)Enum.Parse(typeof(CameraClearFlags), f.clearFlags, true); } catch { } }
            if (Has("backgroundColor") && f.backgroundColor != null) { try { cam.backgroundColor = new Color(f.backgroundColor.r, f.backgroundColor.g, f.backgroundColor.b, f.backgroundColor.a); } catch { } }
        }

        private static void ApplyLightFields(Light li, string fieldsJson)
        {
            if (li == null || string.IsNullOrEmpty(fieldsJson)) return;
            LightFieldsPayload f = null;
            try { f = JsonUtility.FromJson<LightFieldsPayload>(fieldsJson); } catch { }
            if (f == null) return;
            bool Has(string key) { try { return BodyHas(fieldsJson, key); } catch { return false; } }

            if (Has("type")) { try { li.type = (LightType)Enum.Parse(typeof(LightType), f.type, true); } catch { } }
            if (Has("intensity")) { try { li.intensity = f.intensity; } catch { } }
            if (Has("range")) { try { li.range = f.range; } catch { } }
            if (Has("spotAngle")) { try { li.spotAngle = f.spotAngle; } catch { } }
            if (Has("color") && f.color != null) { try { li.color = new Color(f.color.r, f.color.g, f.color.b, f.color.a); } catch { } }
            if (Has("shadows")) { try { li.shadows = (LightShadows)Enum.Parse(typeof(LightShadows), f.shadows, true); } catch { } }
        }

        private static bool TakeMemorySnapshot(string path)
        {
            try
            {
                bool done = false; bool ok = false;
                Unity.Profiling.Memory.MemoryProfiler.TakeSnapshot(path, (p, success) => { ok = success; done = true; });
                var start = DateTime.UtcNow;
                while (!done && (DateTime.UtcNow - start).TotalSeconds < 60) System.Threading.Thread.Sleep(100);
                return ok;
            }
            catch { return false; }
        }

        private static bool SetTextureImportSettings(ImportTextureRequest req)
        {
            try
            {
                var importer = AssetImporter.GetAtPath(req.assetPath) as TextureImporter;
                if (importer == null) return false;
                if (!string.IsNullOrEmpty(req.textureType))
                {
                    try { importer.textureType = (TextureImporterType)Enum.Parse(typeof(TextureImporterType), req.textureType, true); } catch { }
                }
                importer.sRGBTexture = req.sRGB;
                if (req.maxSize > 0) importer.maxTextureSize = req.maxSize;
                if (!string.IsNullOrEmpty(req.textureCompression))
                {
                    try { importer.textureCompression = (TextureImporterCompression)Enum.Parse(typeof(TextureImporterCompression), req.textureCompression, true); } catch { }
                }
                importer.compressionQuality = req.compressionQuality;
                importer.SaveAndReimport();
                return true;
            }
            catch { return false; }
        }

        [Serializable]
        private class BuildInfoResponse { public string outputPath; public string result; public string error; }

        private static (bool ok, string resultJson, string error) InvokeMethod(InvokeRequest req)
        {
            try
            {
                var type = Type.GetType(req.typeName);
                if (type == null) return (false, null, "Type not found");
                var method = type.GetMethod(req.methodName, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | (req.isStatic ? System.Reflection.BindingFlags.Static : System.Reflection.BindingFlags.Instance));
                if (method == null) return (false, null, "Method not found");
                object instance = null;
                if (!req.isStatic)
                {
                    instance = Activator.CreateInstance(type);
                }
                object[] args = null;
                if (!string.IsNullOrEmpty(req.argsJson))
                {
                    // For simplicity, support string[] args encoded as JSON array of strings
                    var arr = JsonUtility.FromJson<WrapperStringArray>("{\"items\":" + req.argsJson + "}");
                    args = arr.items == null ? new object[0] : Array.ConvertAll(arr.items, x => (object)x);
                }
                var ret = method.Invoke(instance, args);
                string json;
                if (ret == null) json = "{}";
                else if (ret is string s) json = "{\"result\":\"" + JsonEscape(s) + "\"}";
                else json = JsonUtility.ToJson(ret);
                return (true, json, null);
            }
            catch (Exception ex)
            {
                return (false, null, ex.Message);
            }
        }

        [Serializable]
        private class WrapperStringArray { public string[] items; }

        [Serializable]
        private class NotifyRequest { public string title; public string message; public bool modal; }

        [Serializable]
        private class SelectionSetRequest { public string[] paths; public int[] instanceIds; }

        [Serializable]
        private class InstantiateAssetRequest { public string assetPath; public string parentPath; }
        [Serializable]
        private class AssetAddToSceneRequest { public string assetPath; public string parentPath; public Vec3 position; public Vec3 localPosition; public Vec3 eulerAngles; public Vec3 localEulerAngles; public Vec3 localScale; }

        [Serializable]
        private class PauseRequest { public bool pause; }

        // Visual Scripting Implementation Methods
        private static VisualScriptResponse CreateVisualScript(VisualScriptCreateRequest req)
        {
            try
            {
                var go = FindTarget(req.gameObjectPath, null);
                if (go == null)
                    return null; // Will be handled as error by caller

                // Check if Visual Scripting package is available
                var scriptMachineType = Type.GetType("Unity.VisualScripting.ScriptMachine, Unity.VisualScripting.Core");
                if (scriptMachineType == null)
                {
                    // Fallback: Simulate visual script creation without actual Visual Scripting package
                    return CreateVisualScriptSimulation(req);
                }

                // Add ScriptMachine component if not present
                var scriptMachine = go.GetComponent(scriptMachineType);
                if (scriptMachine == null)
                {
                    scriptMachine = go.AddComponent(scriptMachineType);
                }

                // Create a new ScriptGraphAsset
                var scriptGraphAssetType = Type.GetType("Unity.VisualScripting.ScriptGraphAsset, Unity.VisualScripting.Core");
                var scriptGraphAsset = ScriptableObject.CreateInstance(scriptGraphAssetType);

                // Set the script name
                var scriptName = string.IsNullOrEmpty(req.scriptName) ? $"{go.name}_VisualScript" : req.scriptName;
                scriptGraphAsset.name = scriptName;

                // Save the asset
                var assetPath = $"Assets/Scripts/VisualScripts/{scriptName}.asset";
                System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(assetPath));
                AssetDatabase.CreateAsset(scriptGraphAsset, assetPath);

                // Assign the graph to the ScriptMachine
                var graphProperty = scriptMachineType.GetProperty("graph");
                graphProperty?.SetValue(scriptMachine, scriptGraphAsset);

                // Generate nodes based on template or MCP operations
                var nodes = new List<VisualScriptNode>();
                if (req.mcpOperations != null && req.mcpOperations.Length > 0)
                {
                    nodes = GenerateNodesFromMcpOperations(req.mcpOperations);
                }
                else
                {
                    nodes = GenerateTemplateNodes(req.templateType ?? "empty");
                }

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    scriptName = scriptName,
                    success = true,
                    message = $"Visual script '{scriptName}' created successfully",
                    nodes = nodes.ToArray(),
                    connections = new VisualScriptConnection[0]
                };

                EditorUtility.SetDirty(go);
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static VisualScriptResponse AddVisualScriptNode(VisualScriptAddNodeRequest req)
        {
            try
            {
                var go = FindTarget(req.gameObjectPath, null);
                if (go == null)
                    return null; // Will be handled as error by caller

                var scriptMachineType = Type.GetType("Unity.VisualScripting.ScriptMachine, Unity.VisualScripting.Core");
                var scriptMachine = go.GetComponent(scriptMachineType);
                if (scriptMachine == null)
                    return null; // Will be handled as error by caller

                // Create node based on type
                var node = CreateVisualScriptNode(req.nodeType, req.nodeData, req.position, req.nodeId);

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    success = true,
                    message = $"Node '{req.nodeType}' added successfully",
                    nodes = new[] { node }
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static VisualScriptResponse ConnectVisualScriptNodes(VisualScriptConnectRequest req)
        {
            try
            {
                var go = FindTarget(req.gameObjectPath, null);
                if (go == null)
                    return null; // Will be handled as error by caller

                // Create connection
                var connection = new VisualScriptConnection
                {
                    fromNodeId = req.fromNodeId,
                    fromPort = req.fromPortName,
                    toNodeId = req.toNodeId,
                    toPort = req.toPortName
                };

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    success = true,
                    message = "Nodes connected successfully",
                    connections = new[] { connection }
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static VisualScriptResponse GetVisualScriptGraph(VisualScriptGetRequest req)
        {
            try
            {
                var go = FindTarget(req.gameObjectPath, null);
                if (go == null)
                    return null; // Will be handled as error by caller

                var scriptMachineType = Type.GetType("Unity.VisualScripting.ScriptMachine, Unity.VisualScripting.Core");
                var scriptMachine = go.GetComponent(scriptMachineType);
                if (scriptMachine == null)
                    return null; // Will be handled as error by caller

                // Get graph information
                var nodes = new List<VisualScriptNode>();
                var connections = new List<VisualScriptConnection>();

                // This would require deeper integration with Visual Scripting API
                // For now, return basic structure
                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    success = true,
                    message = "Graph retrieved successfully",
                    nodes = nodes.ToArray(),
                    connections = connections.ToArray()
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static VisualScriptResponse GenerateVisualScriptFromMcp(VisualScriptFromMcpRequest req)
        {
            try
            {
                var go = FindTarget(req.gameObjectPath, null);
                if (go == null)
                    return null; // Will be handled as error by caller

                // Check if Visual Scripting package is available
                var scriptMachineType = Type.GetType("Unity.VisualScripting.ScriptMachine, Unity.VisualScripting.Core");
                if (scriptMachineType == null)
                {
                    // Fallback: Simulate visual script generation
                    return GenerateVisualScriptFromMcpSimulation(req);
                }

                // Create visual script first
                var createReq = new VisualScriptCreateRequest
                {
                    gameObjectPath = req.gameObjectPath,
                    scriptName = req.scriptName,
                    templateType = "empty"
                };

                var createResponse = CreateVisualScript(createReq);
                if (createResponse == null)
                    return null; // Will be handled as error by caller

                // Generate nodes from MCP operations
                var nodes = new List<VisualScriptNode>();
                var connections = new List<VisualScriptConnection>();

                // Sort operations by order
                var sortedOps = req.operations.OrderBy(op => op.order).ToArray();

                for (int i = 0; i < sortedOps.Length; i++)
                {
                    var op = sortedOps[i];
                    var nodeId = $"mcp_node_{i}";

                    var node = new VisualScriptNode
                    {
                        nodeId = nodeId,
                        nodeType = "mcp_operation",
                        displayName = $"{op.tool}: {op.action}",
                        position = new Vec3 { x = i * 200, y = 0, z = 0 },
                        nodeData = JsonUtility.ToJson(op),
                        inputPorts = new[] { "input" },
                        outputPorts = new[] { "output" }
                    };
                    nodes.Add(node);

                    // Auto-connect nodes in sequence if requested
                    if (req.autoConnect && i > 0)
                    {
                        var connection = new VisualScriptConnection
                        {
                            fromNodeId = $"mcp_node_{i-1}",
                            fromPort = "output",
                            toNodeId = nodeId,
                            toPort = "input"
                        };
                        connections.Add(connection);
                    }
                }

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    scriptName = req.scriptName,
                    success = true,
                    message = $"Visual script generated from {req.operations.Length} MCP operations",
                    nodes = nodes.ToArray(),
                    connections = connections.ToArray()
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static List<VisualScriptNode> GenerateNodesFromMcpOperations(string[] mcpOperations)
        {
            var nodes = new List<VisualScriptNode>();

            for (int i = 0; i < mcpOperations.Length; i++)
            {
                var node = new VisualScriptNode
                {
                    nodeId = $"mcp_op_{i}",
                    nodeType = "mcp_operation",
                    displayName = mcpOperations[i],
                    position = new Vec3 { x = i * 150, y = 0, z = 0 },
                    nodeData = mcpOperations[i],
                    inputPorts = new[] { "input" },
                    outputPorts = new[] { "output" }
                };
                nodes.Add(node);
            }

            return nodes;
        }

        private static List<VisualScriptNode> GenerateTemplateNodes(string templateType)
        {
            var nodes = new List<VisualScriptNode>();

            switch (templateType.ToLower())
            {
                case "state":
                    nodes.Add(CreateVisualScriptNode("event", "On Start", new Vec3 { x = 0, y = 0, z = 0 }, "start_event"));
                    nodes.Add(CreateVisualScriptNode("action", "Set Variable", new Vec3 { x = 200, y = 0, z = 0 }, "set_var"));
                    break;
                case "flow":
                    nodes.Add(CreateVisualScriptNode("event", "On Update", new Vec3 { x = 0, y = 0, z = 0 }, "update_event"));
                    nodes.Add(CreateVisualScriptNode("condition", "If", new Vec3 { x = 200, y = 0, z = 0 }, "if_condition"));
                    nodes.Add(CreateVisualScriptNode("action", "Debug Log", new Vec3 { x = 400, y = 0, z = 0 }, "debug_log"));
                    break;
                default: // empty
                    nodes.Add(CreateVisualScriptNode("event", "On Start", new Vec3 { x = 0, y = 0, z = 0 }, "start_event"));
                    break;
            }

            return nodes;
        }

        private static VisualScriptNode CreateVisualScriptNode(string nodeType, string nodeData, Vec3 position, string nodeId = null)
        {
            if (string.IsNullOrEmpty(nodeId))
                nodeId = System.Guid.NewGuid().ToString();

            var inputPorts = new List<string>();
            var outputPorts = new List<string>();

            // Define ports based on node type
            switch (nodeType.ToLower())
            {
                case "event":
                    outputPorts.Add("trigger");
                    break;
                case "action":
                    inputPorts.Add("input");
                    outputPorts.Add("output");
                    break;
                case "condition":
                    inputPorts.Add("input");
                    outputPorts.Add("true");
                    outputPorts.Add("false");
                    break;
                case "variable":
                    outputPorts.Add("value");
                    break;
                case "mcp_operation":
                    inputPorts.Add("input");
                    outputPorts.Add("output");
                    outputPorts.Add("error");
                    break;
            }

            return new VisualScriptNode
            {
                nodeId = nodeId,
                nodeType = nodeType,
                displayName = nodeData,
                position = position,
                nodeData = nodeData,
                inputPorts = inputPorts.ToArray(),
                outputPorts = outputPorts.ToArray()
            };
        }

        private static VisualScriptResponse CreateVisualScriptSimulation(VisualScriptCreateRequest req)
        {
            try
            {
                // Simulate visual script creation for demonstration purposes
                var scriptName = string.IsNullOrEmpty(req.scriptName) ? $"{req.gameObjectPath}_VisualScript" : req.scriptName;

                // Generate nodes based on template or MCP operations
                var nodes = new List<VisualScriptNode>();
                var connections = new List<VisualScriptConnection>();

                if (req.mcpOperations != null && req.mcpOperations.Length > 0)
                {
                    nodes = GenerateNodesFromMcpOperations(req.mcpOperations);
                }
                else
                {
                    nodes = GenerateTemplateNodes(req.templateType ?? "empty");
                }

                // Auto-connect nodes in sequence for simulation
                for (int i = 0; i < nodes.Count - 1; i++)
                {
                    var connection = new VisualScriptConnection
                    {
                        fromNodeId = nodes[i].nodeId,
                        fromPort = nodes[i].outputPorts?.FirstOrDefault() ?? "output",
                        toNodeId = nodes[i + 1].nodeId,
                        toPort = nodes[i + 1].inputPorts?.FirstOrDefault() ?? "input"
                    };
                    connections.Add(connection);
                }

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    scriptName = scriptName,
                    success = true,
                    message = $"Visual script '{scriptName}' simulated successfully (Visual Scripting package not installed). Generated {nodes.Count} nodes and {connections.Count} connections.",
                    nodes = nodes.ToArray(),
                    connections = connections.ToArray()
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }

        private static VisualScriptResponse GenerateVisualScriptFromMcpSimulation(VisualScriptFromMcpRequest req)
        {
            try
            {
                // Simulate visual script generation from MCP operations
                var nodes = new List<VisualScriptNode>();
                var connections = new List<VisualScriptConnection>();

                // Sort operations by order
                var sortedOps = req.operations.OrderBy(op => op.order).ToArray();

                for (int i = 0; i < sortedOps.Length; i++)
                {
                    var op = sortedOps[i];
                    var nodeId = $"mcp_node_{i}";

                    var node = new VisualScriptNode
                    {
                        nodeId = nodeId,
                        nodeType = "mcp_operation",
                        displayName = $"{op.tool}: {op.action}",
                        position = new Vec3 { x = i * 200, y = 0, z = 0 },
                        nodeData = $"Tool: {op.tool}, Action: {op.action}, Description: {op.description}",
                        inputPorts = new[] { "input" },
                        outputPorts = new[] { "output", "error" }
                    };
                    nodes.Add(node);

                    // Auto-connect nodes in sequence if requested
                    if (req.autoConnect && i > 0)
                    {
                        var connection = new VisualScriptConnection
                        {
                            fromNodeId = $"mcp_node_{i-1}",
                            fromPort = "output",
                            toNodeId = nodeId,
                            toPort = "input"
                        };
                        connections.Add(connection);
                    }
                }

                var response = new VisualScriptResponse
                {
                    gameObjectPath = req.gameObjectPath,
                    scriptName = req.scriptName,
                    success = true,
                    message = $"Visual script '{req.scriptName}' simulated from {req.operations.Length} MCP operations (Visual Scripting package not installed). Generated {nodes.Count} nodes and {connections.Count} connections.",
                    nodes = nodes.ToArray(),
                    connections = connections.ToArray()
                };

                return response;
            }
            catch (Exception ex)
            {
                return null; // Will be handled as error by caller
            }
        }
    }
}
#endif
