(function () {
  "use strict";

  const PROTOCOL = "agencity.observe.v1";
  const MAX_ROOTS = 100;
  const MAX_ROUTES = 64;
  const MAX_DETAIL_ITEMS = 50;
  const MAX_RAIL_ITEMS = 200;
  const MAX_RAIL_BYTES = 1024 * 1024;
  const MAX_TEXT = 12_000;
  const DETAIL_SECTIONS = Object.freeze([
    ["identity", "Identity"],
    ["runs", "Runs"],
    ["model_attempts", "Model attempts"],
    ["cells", "Cells"],
    ["effects", "Effects"],
    ["tasks", "Tasks"],
    ["mailbox", "Mailbox"],
    ["budget", "Budget"],
    ["goals", "Goals"],
    ["gates", "Gates"],
    ["artifacts", "Artifacts"],
    ["terminal_outcomes", "Terminal outcomes"],
  ]);
  const AVAILABILITY_STATES = new Set([
    "workspace_uninitialized",
    "service_stopped",
    "service_stale",
    "service_conflict",
    "service_incompatible",
    "connecting",
    "connected",
    "resyncing",
    "route_unavailable",
    "family_truncated",
  ]);
  const STREAM_EVENTS = [
    "projection_replaced",
    "family_snapshot",
    "family_update",
    "availability",
    "activity",
    "committed_event",
    "progress",
    "progress_cleared",
    "resync_required",
  ];

  const view = {};
  const state = {
    generation: "",
    sequence: "0",
    instanceId: "",
    workspaceName: "",
    availability: "connecting",
    roots: [],
    rootCount: 0,
    rootCursor: "",
    rootNextCursor: "",
    rootCursorHistory: [],
    nodes: [],
    edges: [],
    messageEdges: [],
    rootRoute: null,
    selectedRoute: null,
    selectedItemId: "",
    positions: new Map(),
    inspectorOpen: false,
    activities: [],
    activityBytes: 0,
    progress: new Map(),
    events: [],
    eventKeys: new Set(),
    detailSection: "",
    detailNextCursor: "",
    detailTruncated: false,
    detailRequest: 0,
    stream: null,
    reconnectTimer: 0,
    reconnectAttempts: 0,
    refreshTimer: 0,
    layoutTimer: 0,
    resyncing: false,
  };

  function element(id) {
    return document.getElementById(id);
  }

  function bindElements() {
    [
      "connection-state",
      "workspace-name",
      "family-name",
      "instance-name",
      "generation-name",
      "stream-state",
      "app-status",
      "root-panel",
      "root-count",
      "roots-list",
      "roots-previous",
      "roots-page",
      "roots-next",
      "observer-main",
      "overview-panel",
      "inspect-panel",
      "events-panel",
      "current-work-title",
      "current-work-status",
      "current-work-action",
      "current-work-agent",
      "current-work-model",
      "current-work-steps",
      "current-work-turns",
      "current-work-tokens",
      "current-work-elapsed",
      "current-work-note",
      "graph-status",
      "family-graph",
      "graph-edges",
      "graph-nodes",
      "activity-count",
      "activity-list",
      "selected-route",
      "inspector-title",
      "inspector-close",
      "detail-sections",
      "detail-state",
      "detail-list",
      "detail-pager",
      "detail-more",
      "events-count",
      "events-list",
    ].forEach((id) => {
      view[id] = element(id);
    });
  }

  function text(parent, value, className) {
    const node = document.createElement("span");
    if (className) node.className = className;
    node.textContent = boundedText(value);
    parent.appendChild(node);
    return node;
  }

  function boundedText(value, limit) {
    const maximum = typeof limit === "number" ? limit : MAX_TEXT;
    let raw;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const bounded = asObject(value);
      if (bounded.kind === "complete" && typeof bounded.text === "string") {
        raw = bounded.text;
      } else if (bounded.kind === "prefix" && typeof bounded.prefix === "string") {
        raw = bounded.prefix + truncationSuffix(bounded);
      } else if (bounded.kind === "head_tail" && typeof bounded.head === "string" && typeof bounded.tail === "string") {
        raw = bounded.head + "\n… omitted …\n" + bounded.tail + truncationSuffix(bounded);
      } else {
        raw = String(value);
      }
    } else {
      raw = value === null || value === undefined ? "" : String(value);
    }
    if (raw.length <= maximum) return raw;
    return raw.slice(0, maximum) + "… [truncated in browser]";
  }

  function truncationSuffix(value) {
    const omitted = Number(firstValue(value, ["omittedUtf8Bytes"], 0)) || 0;
    return omitted > 0 ? "\n[" + omitted + " UTF-8 bytes omitted]" : "";
  }

  function firstValue(source, keys, fallback) {
    if (!source || typeof source !== "object") return fallback;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return fallback;
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function envelopePayload(value) {
    const envelope = asObject(value);
    const version = firstValue(envelope, ["version", "protocolVersion", "observerProtocolVersion"], "");
    if (version && version !== PROTOCOL && version !== 1 && version !== "v1") {
      throw new Error("Observer protocol is incompatible.");
    }
    if (envelope.ok === false || envelope.error) {
      const problem = asObject(envelope.error);
      throw new Error(boundedText(firstValue(problem, ["message", "code"], "Observer request failed."), 300));
    }
    return asObject(firstValue(envelope, ["data", "payload"], envelope));
  }

  async function request(path, options) {
    const headers = new Headers({ Accept: "application/json" });
    const settings = options || {};
    if (settings.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (settings.bootstrapToken) {
      headers.set("X-Agencity-Observe-Bootstrap", settings.bootstrapToken);
    }
    const response = await fetch(path, {
      method: settings.method || "GET",
      headers,
      body: settings.json === undefined ? undefined : JSON.stringify(settings.json),
      credentials: "same-origin",
      cache: "no-store",
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Observer returned an unreadable response.");
    }
    if (!response.ok) {
      const problem = asObject(body.error);
      throw new Error(boundedText(firstValue(problem, ["message", "code"], "Observer request failed."), 300));
    }
    return envelopePayload(body);
  }

  function readBootstrapToken() {
    const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    return new URLSearchParams(fragment).get("token") || "";
  }

  function removeFragment() {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }

  async function establishSession() {
    const bootstrapToken = readBootstrapToken();
    if (!bootstrapToken) return;
    await request("/api/session", {
      method: "POST",
      bootstrapToken,
    });
    removeFragment();
  }

  function routeFrom(value) {
    const source = asObject(firstValue(asObject(value), ["route"], value));
    const sessionId = boundedText(firstValue(source, ["sessionId", "session_id"], ""), 256);
    const branchId = boundedText(firstValue(source, ["branchId", "branch_id"], ""), 256);
    if (!sessionId || !branchId) return null;
    return { sessionId, branchId };
  }

  function routeKey(route) {
    return route ? route.sessionId + "\u0000" + route.branchId : "";
  }

  function sameRoute(left, right) {
    return routeKey(left) === routeKey(right);
  }

  function setStatus(message, isError) {
    view["app-status"].textContent = boundedText(message, 500);
    view["app-status"].dataset.kind = isError ? "error" : "status";
  }

  function normalizeAvailability(value) {
    const candidate = String(value || "connecting");
    return AVAILABILITY_STATES.has(candidate) ? candidate : "connecting";
  }

  function humanState(value) {
    return boundedText(String(value || "unknown")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase(), 80);
  }

  function applyHeader(source) {
    const data = asObject(source);
    const availabilitySource = firstValue(data, ["availability"], {});
    const availability = typeof availabilitySource === "string"
      ? availabilitySource
      : firstValue(asObject(availabilitySource), ["state", "status", "code"], firstValue(data, ["status"], state.availability));
    state.availability = normalizeAvailability(availability);
    state.instanceId = boundedText(firstValue(data, ["managedInstanceId", "instanceId"], state.instanceId), 256);
    state.workspaceName = boundedText(
      firstValue(data, ["workspaceName", "workspaceRoot", "workspaceId"], state.workspaceName || "Unavailable"),
      160
    );

    view["connection-state"].textContent = humanState(state.availability);
    view["connection-state"].dataset.state = state.availability;
    view["workspace-name"].textContent = state.workspaceName;
    view["instance-name"].textContent = state.instanceId || "Unavailable";
    view["generation-name"].textContent = state.generation || "—";

    const unavailable = state.availability !== "connected" && state.availability !== "family_truncated";
    if (unavailable) {
      setStatus(availabilityMessage(state.availability), false);
    }
  }

  function availabilityMessage(availability) {
    const messages = {
      workspace_uninitialized: "This workspace has not been initialized. Observation will remain available and retry.",
      service_stopped: "The managed workspace service is stopped. The observer does not start it.",
      service_stale: "A service manifest exists, but no matching live service is available.",
      service_conflict: "Service identity or execution authority conflicts. The observer will not choose an authority.",
      service_incompatible: "The managed service does not support the required observer capabilities.",
      connecting: "Validating the managed workspace service…",
      connected: "Connected to committed family state.",
      resyncing: "Discarding stale browser state and loading a fresh bounded snapshot…",
      route_unavailable: "A retained family route could not be loaded.",
      family_truncated: "The family reached the 64-route observer bound. Additional routes were not loaded.",
    };
    return messages[availability] || "Observer availability is unknown.";
  }

  function rootsPageFrom(source) {
    const data = asObject(source);
    const holder = asObject(firstValue(data, ["rootSelector", "rootsPage", "roots"], {}));
    const items = Array.isArray(data.roots)
      ? data.roots
      : asArray(firstValue(holder, ["items", "roots", "rows"], []));
    return {
      items: items.slice(0, MAX_ROOTS),
      count: Number(firstValue(holder, ["selectableCount", "totalCount", "count"], firstValue(data, ["selectableRootCount"], items.length))) || 0,
      nextCursor: boundedText(firstValue(holder, ["nextCursor", "next"], ""), 1024),
      truncated: Boolean(firstValue(holder, ["truncated"], items.length > MAX_ROOTS)),
    };
  }

  function renderRoots(page) {
    state.roots = page.items;
    state.rootCount = Math.max(page.count, page.items.length);
    state.rootNextCursor = page.nextCursor;
    view["roots-list"].replaceChildren();

    for (const itemValue of state.roots) {
      const item = asObject(itemValue);
      const route = routeFrom(item);
      if (!route) continue;
      const status = boundedText(firstValue(item, ["status", "sessionStatus"], "unknown"), 80);
      const selectable = item.selectable !== false && status !== "failed" && status !== "archived";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "root-option";
      button.disabled = !selectable;
      const name = firstValue(item, ["name", "displayName", "taskSummary", "sessionId"], route.sessionId);
      const strong = document.createElement("strong");
      strong.textContent = boundedText(name, 180);
      button.appendChild(strong);
      text(button, firstValue(item, ["branchName", "branchId"], route.branchId));
      text(button, "Status: " + humanState(status));
      button.addEventListener("click", () => {
        void selectFamily(route);
      });
      view["roots-list"].appendChild(button);
    }

    const pageNumber = state.rootCursorHistory.length + 1;
    view["root-count"].textContent =
      state.rootCount + " selectable root" + (state.rootCount === 1 ? "" : "s") +
      (page.truncated ? "; this page is bounded" : "");
    view["roots-page"].textContent = "Page " + pageNumber;
    view["roots-previous"].disabled = state.rootCursorHistory.length === 0;
    view["roots-next"].disabled = !state.rootNextCursor;
    view["root-panel"].hidden = state.roots.length === 0 && Boolean(state.selectedRoute);
  }

  async function loadRootPage(cursor, movingBack) {
    const query = new URLSearchParams();
    query.set("rootsLimit", String(MAX_ROOTS));
    if (cursor) query.set("rootsCursor", cursor);
    const data = await request("/api/bootstrap?" + query.toString());
    if (!movingBack) state.rootCursorHistory.push(state.rootCursor);
    state.rootCursor = cursor;
    applyHeader(data);
    renderRoots(rootsPageFrom(data));
  }

  function familyFrom(source) {
    const data = asObject(source);
    const snapshot = asObject(firstValue(data, ["snapshot"], data));
    return asObject(firstValue(snapshot, ["family", "projection"], snapshot));
  }

  function normalizeNode(value, index) {
    const source = asObject(value);
    const route = routeFrom(source);
    if (!route) return null;
    const modelSource = asObject(firstValue(source, ["model"], {}));
    const latestRunSource = asObject(firstValue(source, ["latestRun"], {}));
    const budgetSource = asObject(firstValue(source, ["budget"], {}));
    const model = modelSource.provider || modelSource.model
      ? boundedText(modelSource.provider, 80) + "/" + boundedText(modelSource.model, 120)
      : boundedText(firstValue(source, ["modelId"], "Model unavailable"), 180);
    return {
      route,
      name: boundedText(firstValue(source, ["sessionName", "name", "displayName", "agentName"], route.sessionId), 180),
      branchName: boundedText(firstValue(source, ["branchName", "branch"], route.branchId), 180),
      depth: Math.max(0, Math.min(63, Number(firstValue(source, ["depth"], 0)) || 0)),
      model,
      taskSummary: boundedText(firstValue(source, ["taskSummary", "task", "summary"], ""), 360),
      status: boundedText(firstValue(source, ["status", "sessionStatus"], "unknown"), 80),
      activity: boundedText(firstValue(source, ["activity"], "idle"), 80),
      activityReason: boundedText(firstValue(source, ["activityReason"], ""), 120),
      latestRun: latestRunSource.id ? {
        id: boundedText(latestRunSource.id, 256),
        task: boundedText(latestRunSource.task, 1024),
        status: boundedText(latestRunSource.status, 80),
        stepCount: Math.max(0, Number(latestRunSource.stepCount) || 0),
        currentAction: boundedText(latestRunSource.currentAction, 80),
        reason: boundedText(latestRunSource.reason, 360),
        deadline: asObject(latestRunSource.deadline),
      } : null,
      budget: Object.keys(budgetSource).length ? {
        tokens: Math.max(0, Number(budgetSource.tokens) || 0),
        costUsd: Math.max(0, Number(budgetSource.costUsd) || 0),
        turns: Math.max(0, Number(budgetSource.turns) || 0),
        wallTimeMs: Math.max(0, Number(budgetSource.wallTimeMs) || 0),
        exceeded: budgetSource.exceeded === true,
      } : null,
      unavailable:
        firstValue(source, ["availability"], "") === "route_unavailable" ||
        Boolean(firstValue(source, ["unavailable", "routeUnavailable"], false)),
      order: index,
    };
  }

  function normalizeEdge(value) {
    const source = asObject(value);
    const parent = routeFrom(firstValue(source, ["parent", "from", "parentRoute", "fromRoute"], null));
    const child = routeFrom(firstValue(source, ["child", "to", "childRoute", "toRoute"], null));
    if (!parent || !child) return null;
    return {
      parent,
      child,
      id: boundedText(firstValue(source, ["taskId", "id"], routeKey(parent) + routeKey(child)), 256),
      status: boundedText(firstValue(source, ["status"], ""), 80),
    };
  }

  function normalizeMessageEdge(value) {
    const edge = normalizeEdge(value);
    if (!edge) return null;
    const source = asObject(value);
    edge.id = boundedText(firstValue(source, ["mailboxMessageId", "messageId", "id"], edge.id), 256);
    edge.status = boundedText(firstValue(source, ["lifecycle", "status"], "unknown"), 80);
    return edge;
  }

  function applySnapshot(source, options) {
    const data = asObject(source);
    const snapshot = asObject(firstValue(data, ["snapshot"], data));
    const nextGeneration = boundedText(firstValue(snapshot, ["generation", "observerGeneration"], state.generation), 256);
    const generationChanged = Boolean(nextGeneration && nextGeneration !== state.generation);
    if (generationChanged) {
      state.positions.clear();
      state.activities = [];
      state.activityBytes = 0;
      state.progress.clear();
      state.events = [];
      state.eventKeys.clear();
      renderActivities();
      renderEvents();
      clearDetail();
    }
    if (nextGeneration) state.generation = nextGeneration;
    state.sequence = boundedText(firstValue(snapshot, ["sequence", "observerSequence"], state.sequence), 64);
    state.instanceId = boundedText(firstValue(snapshot, ["managedInstanceId", "instanceId"], state.instanceId), 256);

    const family = familyFrom(snapshot);
    const rawNodes = asArray(firstValue(family, ["nodes", "routes", "items"], []));
    const rawEdges = asArray(firstValue(family, ["delegationEdges", "edges", "tasks"], []));
    const rawMessages = asArray(firstValue(family, ["messageEdges", "messages", "mailboxEdges"], []));
    state.nodes = rawNodes.slice(0, MAX_ROUTES).map(normalizeNode).filter(Boolean);
    state.edges = rawEdges.slice(0, MAX_ROUTES * 2).map(normalizeEdge).filter(Boolean);
    state.messageEdges = rawMessages.slice(0, MAX_ROUTES * 4).map(normalizeMessageEdge).filter(Boolean);

    const selectedRoot = routeFrom(firstValue(snapshot, ["selectedRoot", "selectedRoute"], firstValue(family, ["root"], null)));
    if (selectedRoot) {
      state.rootRoute = selectedRoot;
      view["family-name"].textContent = familyNameFor(selectedRoot);
    }
    if (!state.selectedRoute || !state.nodes.some((node) => sameRoute(node.route, state.selectedRoute))) {
      state.selectedRoute = selectedRoot || (state.nodes[0] ? state.nodes[0].route : null);
      state.selectedItemId = "";
      clearDetail();
    }

    const truncation = asObject(firstValue(family, ["truncation"], {}));
    const routeTruncated =
      Boolean(firstValue(family, ["truncated", "familyTruncated"], false)) ||
      truncation.familyRoutes === true ||
      rawNodes.length > MAX_ROUTES;
    const projectionTruncated =
      routeTruncated ||
      ["graphEdges", "mailboxEdges", "byteLimit"].some((key) => truncation[key] === true);
    const unavailableCount = state.nodes.filter((node) => node.unavailable).length;
    const snapshotAvailability = firstValue(snapshot, ["availability"], "connected");
    state.availability = routeTruncated ? "family_truncated" : normalizeAvailability(
      typeof snapshotAvailability === "string"
        ? snapshotAvailability
        : firstValue(asObject(snapshotAvailability), ["state", "status", "code"], "connected")
    );
    applyHeader(Object.assign({}, snapshot, { availability: state.availability }));
    view["graph-status"].textContent = routeTruncated
      ? "More routes were not loaded; no omitted count is inferred."
      : projectionTruncated
        ? "Graph or mailbox data was bounded by the observer response."
      : unavailableCount
        ? unavailableCount + " referenced route" + (unavailableCount === 1 ? " is" : "s are") + " unavailable."
        : state.nodes.length + " loaded route" + (state.nodes.length === 1 ? "" : "s") + ".";
    view["root-panel"].hidden = true;
    view["observer-main"].hidden = false;
    renderGraph();
    renderCurrentWork();
    renderSelectedRoute();
    setStatus(
      routeTruncated
        ? availabilityMessage("family_truncated")
        : projectionTruncated
          ? "Showing a bounded projection; omitted graph or mailbox values remain unavailable."
          : "Showing bounded current state and live activity.",
      false
    );
    if (!options || options.openStream !== false) openStream();
  }

  function familyNameFor(route) {
    const node = state.nodes.find((candidate) => sameRoute(candidate.route, route));
    return node ? node.name : route ? route.sessionId : "Not selected";
  }

  function formatCount(value) {
    return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
    const hours = Math.floor(minutes / 60);
    return hours + "h " + (minutes % 60) + "m";
  }

  function actionLabel(action) {
    const labels = {
      awaiting_model: "Waiting for the next model action",
      typescript: "Running a TypeScript action",
      final: "Completing the task",
      blocked: "Reporting a blocker",
      failed: "Reporting a failure",
    };
    return labels[action] || "No active action";
  }

  function currentProgressFor(route) {
    for (const progress of state.progress.values()) {
      if (sameRoute(progress.route, route)) return progress;
    }
    return null;
  }

  function latestActivityFor(route) {
    return state.activities.find((item) => sameRoute(item.route, route)) || null;
  }

  function renderCurrentWork() {
    const node = state.nodes.find((candidate) => sameRoute(candidate.route, state.rootRoute)) || state.nodes[0] || null;
    if (!node) {
      view["current-work-title"].textContent = "Waiting for family state";
      view["current-work-status"].textContent = "Unavailable";
      view["current-work-status"].dataset.activity = "unavailable";
      view["current-work-action"].textContent = "No current route is available.";
      return;
    }
    const run = node.latestRun;
    const budget = node.budget;
    const progress = currentProgressFor(node.route);
    const activity = latestActivityFor(node.route);
    view["current-work-title"].textContent =
      boundedText(run?.task || node.taskSummary || node.name || "Task summary unavailable", 1_000);
    view["current-work-status"].textContent = humanState(node.activity);
    view["current-work-status"].dataset.activity = node.activity;
    view["current-work-agent"].textContent = node.name;
    view["current-work-model"].textContent = node.model;
    view["current-work-steps"].textContent = String(run?.stepCount || 0);
    view["current-work-turns"].textContent = formatCount(budget?.turns || 0);
    view["current-work-tokens"].textContent = formatCount(budget?.tokens || 0);
    view["current-work-elapsed"].textContent = formatDuration(budget?.wallTimeMs || 0);

    const semantic = activity ? semanticEvent(activity.kind, false) : null;
    view["current-work-action"].textContent = progress
      ? boundedText(progress.message || humanState(progress.stage), 600)
      : run?.currentAction
        ? actionLabel(run.currentAction)
        : semantic?.label || (node.activity === "idle" ? "Waiting for work." : "Current action unavailable.");
    const notes = [];
    if (node.activityReason) notes.push("Attention: " + humanState(node.activityReason) + ".");
    if (run?.reason) notes.push(run.reason);
    if (budget?.exceeded) notes.push("The durable budget is exceeded.");
    view["current-work-note"].textContent = notes.join(" ");
  }

  function placeNodes() {
    state.positions.clear();
    const sorted = [...state.nodes].sort((left, right) =>
      left.depth - right.depth || left.order - right.order || routeKey(left.route).localeCompare(routeKey(right.route))
    );
    const byDepth = new Map();
    for (const node of sorted) {
      const group = byDepth.get(node.depth) || [];
      group.push(node);
      byDepth.set(node.depth, group);
    }
    const depths = [...byDepth.keys()].sort((left, right) => left - right);
    const nodeWidth = 200;
    const nodeHeight = 112;
    const columnGap = 56;
    const rowGap = 24;
    const maxRows = Math.max(1, ...[...byDepth.values()].map((nodes) => nodes.length));
    const contentWidth = Math.max(nodeWidth, depths.length * nodeWidth + Math.max(0, depths.length - 1) * columnGap);
    const contentHeight = Math.max(nodeHeight, maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
    const viewportWidth = Math.max(320, view["family-graph"].clientWidth || 520);
    const viewportHeight = Math.max(288, view["family-graph"].clientHeight || 400);
    const width = Math.max(viewportWidth, contentWidth + 48);
    const height = Math.max(viewportHeight, contentHeight + 48);
    const originX = Math.max(24, (width - contentWidth) / 2);
    for (let depthIndex = 0; depthIndex < depths.length; depthIndex += 1) {
      const nodes = byDepth.get(depths[depthIndex]) || [];
      const columnHeight = nodes.length * nodeHeight + Math.max(0, nodes.length - 1) * rowGap;
      const originY = Math.max(24, (height - columnHeight) / 2);
      nodes.forEach((node, row) => {
        state.positions.set(routeKey(node.route), {
          x: originX + depthIndex * (nodeWidth + columnGap),
          y: originY + row * (nodeHeight + rowGap),
        });
      });
    }
    return { width, height };
  }

  function renderGraph() {
    const bounds = placeNodes();
    view["graph-nodes"].replaceChildren();
    view["graph-edges"].replaceChildren();
    view["graph-edges"].setAttribute("viewBox", "0 0 " + bounds.width + " " + bounds.height);
    view["graph-edges"].setAttribute("width", String(bounds.width));
    view["graph-edges"].setAttribute("height", String(bounds.height));
    view["graph-nodes"].style.width = bounds.width + "px";
    view["graph-nodes"].style.height = bounds.height + "px";

    for (const edge of state.edges) drawEdge(edge, false);
    for (const edge of state.messageEdges) drawEdge(edge, true);
    for (const node of state.nodes) drawNode(node);
  }

  function drawEdge(edge, message) {
    const from = state.positions.get(routeKey(edge.parent));
    const to = state.positions.get(routeKey(edge.child));
    if (!from || !to) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const startX = from.x + 200;
    const startY = from.y + 55;
    const endX = to.x;
    const endY = to.y + 55;
    const middleX = startX + (endX - startX) / 2;
    path.setAttribute("d", "M " + startX + " " + startY + " C " + middleX + " " + startY + ", " + middleX + " " + endY + ", " + endX + " " + endY);
    path.setAttribute("class", message ? "graph-edge message" : "graph-edge");
    view["graph-edges"].appendChild(path);
  }

  function drawNode(node) {
    const position = state.positions.get(routeKey(node.route));
    if (!position) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-node" + (sameRoute(node.route, state.selectedRoute) ? " selected" : "");
    button.style.left = position.x + "px";
    button.style.top = position.y + "px";
    button.dataset.activity = node.activity;
    button.setAttribute("aria-label", "Inspect " + boundedText(node.name, 120));
    text(button, node.name, "node-title");
    text(button, node.branchName + " · depth " + node.depth, "node-meta");
    text(button, node.model, "node-meta");
    text(button, node.taskSummary || "No task summary", "node-task");
    if (node.latestRun?.currentAction) text(button, actionLabel(node.latestRun.currentAction), "node-action");
    text(button, node.unavailable ? "route unavailable" : humanState(node.activity), "node-state");
    button.addEventListener("click", () => {
      state.selectedRoute = node.route;
      state.selectedItemId = "";
      state.inspectorOpen = true;
      clearDetail();
      renderGraph();
      renderSelectedRoute();
      void loadDetail("identity", "", false);
    });
    view["graph-nodes"].appendChild(button);
  }

  function switchDepth(depth) {
    const selected = depth === "events" ? "events" : "overview";
    for (const button of document.querySelectorAll("[data-depth]")) {
      button.setAttribute("aria-selected", button.getAttribute("data-depth") === selected ? "true" : "false");
    }
    view["overview-panel"].hidden = selected !== "overview";
    view["events-panel"].hidden = selected !== "events";
  }

  function renderDetailSectionButtons() {
    view["detail-sections"].replaceChildren();
    for (const entry of DETAIL_SECTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry[1];
      if (state.detailSection === entry[0]) button.className = "active";
      button.disabled = !state.selectedRoute;
      button.addEventListener("click", () => {
        void loadDetail(entry[0], "", false);
      });
      view["detail-sections"].appendChild(button);
    }
  }

  function renderSelectedRoute() {
    const selectedNode = state.nodes.find((node) => sameRoute(node.route, state.selectedRoute));
    view["inspector-title"].textContent = selectedNode?.name || "Inspect agent";
    view["selected-route"].textContent = state.selectedRoute
      ? (selectedNode?.branchName || state.selectedRoute.branchId) + " · " + humanState(selectedNode?.activity || "unknown")
      : "Select a graph node.";
    view["inspect-panel"].hidden = !state.inspectorOpen || !state.selectedRoute;
    renderDetailSectionButtons();
  }

  function closeInspector() {
    state.inspectorOpen = false;
    view["inspect-panel"].hidden = true;
  }

  function clearDetail() {
    state.detailRequest += 1;
    state.detailSection = "";
    state.detailNextCursor = "";
    state.detailTruncated = false;
    view["detail-list"].replaceChildren();
    view["detail-state"].textContent = "Choose a section to load bounded detail.";
    view["detail-pager"].hidden = true;
    renderDetailSectionButtons();
  }

  async function loadDetail(section, cursor, append) {
    if (!state.selectedRoute || !DETAIL_SECTIONS.some((entry) => entry[0] === section)) return;
    const requestId = ++state.detailRequest;
    state.detailSection = section;
    renderDetailSectionButtons();
    view["detail-state"].textContent = "Loading bounded " + humanState(section) + " detail…";
    if (!append) view["detail-list"].replaceChildren();
    const query = new URLSearchParams();
    query.set("section", section);
    query.set("sessionId", state.selectedRoute.sessionId);
    query.set("branchId", state.selectedRoute.branchId);
    query.set("limit", String(MAX_DETAIL_ITEMS));
    if (state.selectedItemId) query.set("itemId", state.selectedItemId);
    if (cursor) query.set("cursor", cursor);
    try {
      const page = await request("/api/family/detail?" + query.toString());
      if (requestId !== state.detailRequest) return;
      applyDetailPage(page, append);
    } catch (error) {
      if (requestId !== state.detailRequest) return;
      view["detail-state"].textContent = safeError(error);
      view["detail-pager"].hidden = true;
    }
  }

  function detailItemsFrom(page) {
    const data = asObject(page);
    const holder = asObject(firstValue(data, ["page", "detail"], data));
    const items = firstValue(holder, ["items", "rows"], []);
    if (Array.isArray(items)) return items.slice(0, MAX_DETAIL_ITEMS);
    const item = firstValue(holder, ["item", "value"], null);
    return item === null ? [] : [item];
  }

  function applyDetailPage(page, append) {
    const data = asObject(page);
    const holder = asObject(firstValue(data, ["page", "detail"], data));
    const route = routeFrom(firstValue(holder, ["route"], data));
    if (route && !sameRoute(route, state.selectedRoute)) {
      view["detail-state"].textContent = "Detail response belonged to a previous route and was ignored.";
      return;
    }
    const responseGeneration = boundedText(firstValue(data, ["generation", "observerGeneration"], state.generation), 256);
    if (responseGeneration && responseGeneration !== state.generation) {
      view["detail-state"].textContent = "Detail became stale during a family resync.";
      return;
    }
    const items = detailItemsFrom(page);
    if (!append) view["detail-list"].replaceChildren();
    for (const item of items) renderDetailItem(item);
    const pagination = asObject(firstValue(holder, ["pagination"], {}));
    const truncation = asObject(firstValue(holder, ["truncation"], {}));
    state.detailNextCursor = boundedText(
      firstValue(pagination, ["nextCursor", "next"], firstValue(holder, ["nextCursor", "next"], "")),
      1024
    );
    state.detailTruncated =
      Boolean(firstValue(holder, ["truncated"], false)) ||
      truncation.itemLimit === true ||
      truncation.byteLimit === true;
    const snapshotCursor = boundedText(firstValue(holder, ["snapshotCursor", "cursor"], ""), 128);
    const completeness = state.detailTruncated
      ? "Page is truncated; omitted content is not available through this view."
      : state.detailNextCursor
        ? "More bounded items are available."
        : "Bounded page complete.";
    view["detail-state"].textContent =
      items.length + " item" + (items.length === 1 ? "" : "s") +
      (snapshotCursor ? " · snapshot cursor " + snapshotCursor : "") +
      " · " + completeness;
    view["detail-pager"].hidden = !state.detailNextCursor;
  }

  function renderDetailItem(itemValue) {
    const item = asObject(itemValue);
    const data = asObject(firstValue(item, ["data"], {}));
    const kind = boundedText(firstValue(item, ["kind", "type"], state.detailSection || "detail"), 80);
    const id = boundedText(firstValue(item, ["id", "eventId"], ""), 256);
    const card = document.createElement("article");
    card.className = "detail-card";
    const title = document.createElement("h3");
    title.textContent = detailTitle(kind, id, data);
    card.appendChild(title);
    const list = document.createElement("dl");
    const entries = Object.entries(data).slice(0, 38);
    if (id) entries.push(["id", id]);
    if (item.provenance) entries.push(["provenance", item.provenance]);
    for (const entry of entries) {
      const term = document.createElement("dt");
      term.textContent = fieldLabel(entry[0]);
      const description = document.createElement("dd");
      description.textContent = formatValue(entry[1], 0);
      list.append(term, description);
    }
    if (Object.keys(data).length > 38) {
      const term = document.createElement("dt");
      term.textContent = "Browser bound";
      const description = document.createElement("dd");
      description.textContent = "Additional fields were not rendered.";
      list.append(term, description);
    }
    card.appendChild(list);
    view["detail-list"].appendChild(card);
  }

  function detailTitle(kind, id, data) {
    const status = boundedText(data.status, 80);
    if (kind === "identity") return boundedText(data.sessionName, 180) || "Agent identity";
    if (kind === "runs") return boundedText(data.task, 240) || "Agent run";
    if (kind === "model_attempts") return "Model attempt " + boundedText(data.attempt, 20);
    if (kind === "cells") return "TypeScript cell" + (status ? " · " + humanState(status) : "");
    if (kind === "effects") {
      return [boundedText(data.executor, 80), boundedText(data.operation, 100)].filter(Boolean).join(" · ") || "Tool effect";
    }
    if (kind === "tasks") return boundedText(data.task, 240) || "Child task";
    if (kind === "mailbox") return "Agent message · " + humanState(data.direction || data.kind);
    if (kind === "budget") return data.exceeded ? "Budget · exceeded" : "Budget usage";
    if (kind === "goals") return boundedText(data.description, 240) || "Goal";
    if (kind === "gates") return boundedText(data.name, 180) || "Completion gate";
    if (kind === "artifacts") return boundedText(data.mediaType, 120) || "Artifact";
    if (kind.startsWith("terminal_")) return "Outcome · " + humanState(status || kind.replace("terminal_", ""));
    return id || humanState(kind);
  }

  function fieldLabel(value) {
    return boundedText(String(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase()), 120);
  }

  function formatValue(value, depth) {
    if (value === null) return "null";
    if (value === undefined) return "unavailable";
    if (typeof value === "string") return boundedText(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (
      value &&
      typeof value === "object" &&
      ["complete", "prefix", "head_tail"].includes(asObject(value).kind)
    ) {
      return boundedText(value);
    }
    if (depth >= 2) return "[bounded structured value]";
    if (Array.isArray(value)) {
      const values = value.slice(0, 16).map((item) => formatValue(item, depth + 1));
      if (value.length > values.length) values.push("… " + (value.length - values.length) + " more");
      return boundedText("[\n" + values.join(",\n") + "\n]");
    }
    const object = asObject(value);
    const entries = Object.entries(object).slice(0, 20);
    const values = entries.map((entry) => entry[0] + ": " + formatValue(entry[1], depth + 1));
    if (Object.keys(object).length > entries.length) values.push("… additional fields omitted");
    return boundedText("{\n" + values.join(",\n") + "\n}");
  }

  function activityFrom(source, kind) {
    const data = asObject(source);
    const route = routeFrom(firstValue(data, ["route"], null));
    return {
      kind: boundedText(firstValue(data, ["type", "kind", "eventType"], kind || "activity"), 120),
      summary: boundedText(firstValue(data, ["summary", "message", "status", "operation"], ""), 600),
      route,
      eventId: boundedText(firstValue(data, ["eventId", "canonicalEventId"], ""), 256),
      cursor: boundedText(firstValue(data, ["routeCursor", "cursor"], ""), 128),
      time: boundedText(firstValue(data, ["committedAt", "createdAt", "time"], ""), 128),
      producer: boundedText(firstValue(data, ["producer"], ""), 160),
    };
  }

  function addActivity(source, kind) {
    const item = activityFrom(source, kind);
    const size = item.kind.length + item.summary.length + item.eventId.length + item.cursor.length + item.time.length + item.producer.length + 64;
    state.activities.unshift(item);
    state.activityBytes += size;
    while (state.activities.length > MAX_RAIL_ITEMS || state.activityBytes > MAX_RAIL_BYTES) {
      const removed = state.activities.pop();
      if (!removed) break;
      state.activityBytes -= removed.kind.length + removed.summary.length + removed.eventId.length + removed.cursor.length + removed.time.length + removed.producer.length + 64;
    }
    renderActivities();
    if (item.eventId || item.cursor) addEvent(item);
  }

  function semanticEvent(kind, provisional) {
    const value = String(kind || "activity");
    if (provisional) {
      if (/model|tool/i.test(value)) return { category: "model", label: "Model is responding" };
      return { category: "action", label: humanState(value) };
    }
    const exact = {
      ModelCallRequested: ["model", "Model response requested"],
      ModelCallCompleted: ["model", "Model response completed"],
      ModelCallTerminated: ["attention", "Model response ended without success"],
      EffectRequested: ["action", "Tool request recorded"],
      EffectAttemptStarted: ["action", "Tool execution started"],
      EffectOutcomeRecorded: ["action", "Tool outcome recorded"],
      CellProposed: ["action", "TypeScript action proposed"],
      CellStarted: ["action", "TypeScript action started"],
      CellCommitted: ["action", "TypeScript action completed"],
      CellFailed: ["attention", "TypeScript action failed"],
      AgentRunRequested: ["family", "Agent run requested"],
      AgentRunStepStarted: ["model", "Agent step started"],
      AgentRunModelAttemptStarted: ["model", "Model attempt started"],
      AgentRunActionCommitted: ["action", "Model chose the next action"],
      AgentRunActionRejected: ["attention", "Model action rejected"],
      AgentRunTypedFinishCommitted: ["family", "Agent submitted a final outcome"],
      AgentRunTypedActionViolationCommitted: ["attention", "Model action violated its contract"],
      AgentRunResultCommitted: ["family", "Agent result committed"],
      AgentRunStatusChanged: ["family", "Agent run status changed"],
      SessionStatusChanged: ["family", "Agent status changed"],
      TaskCreated: ["family", "Child task created"],
      TaskStatusChanged: ["family", "Child task status changed"],
      MailboxMessageSent: ["family", "Agent message sent"],
      MailboxMessageDelivered: ["family", "Agent message delivered"],
      MailboxMessageContextDelivered: ["family", "Agent message entered context"],
      MailboxMessageDeliveryFailed: ["attention", "Agent message delivery failed"],
      GoalGateEvaluationRecorded: ["family", "Completion gate evaluated"],
    };
    if (exact[value]) return { category: exact[value][0], label: exact[value][1] };
    if (/failed|blocked|unknown|cancel/i.test(value)) {
      return { category: "attention", label: humanState(value) };
    }
    if (/model|provider/i.test(value)) return { category: "model", label: humanState(value) };
    if (/cell|effect|process|generation|skill/i.test(value)) return { category: "action", label: humanState(value) };
    if (/task|session|run|mailbox|goal|gate|agent/i.test(value)) return { category: "family", label: humanState(value) };
    return { category: "system", label: humanState(value) };
  }

  function relativeTime(value) {
    if (!value) return "";
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return boundedText(value, 80);
    const difference = Math.round((time - Date.now()) / 1000);
    const absolute = Math.abs(difference);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (absolute < 60) return formatter.format(difference, "second");
    if (absolute < 3600) return formatter.format(Math.round(difference / 60), "minute");
    if (absolute < 86_400) return formatter.format(Math.round(difference / 3600), "hour");
    return formatter.format(Math.round(difference / 86_400), "day");
  }

  function groupedActivities() {
    const groups = [];
    for (const progress of state.progress.values()) {
      const semantic = semanticEvent(progress.stage, true);
      groups.push({
        category: semantic.category,
        label: semantic.label,
        route: progress.route,
        provisional: true,
        items: [{
          kind: progress.stage,
          summary: boundedText(progress.message, 600),
          route: progress.route,
          eventId: "",
          cursor: "",
          time: "",
          producer: "",
        }],
      });
    }
    for (const item of state.activities) {
      const semantic = semanticEvent(item.kind, false);
      const previous = groups.at(-1);
      if (previous && !previous.provisional && previous.category === semantic.category &&
          sameRoute(previous.route, item.route) && previous.items.length < 8) {
        previous.items.push(item);
        continue;
      }
      groups.push({
        category: semantic.category,
        label: semantic.label,
        route: item.route,
        provisional: false,
        items: [item],
      });
    }
    return groups;
  }

  function renderActivityGroup(group) {
    const row = document.createElement("li");
    const details = document.createElement("details");
    details.className = "activity-group";
    const summary = document.createElement("summary");
    const indicator = document.createElement("span");
    indicator.className = "activity-kind";
    indicator.dataset.kind = group.category;
    summary.appendChild(indicator);
    const copy = document.createElement("span");
    copy.className = "activity-summary";
    const title = document.createElement("strong");
    title.textContent = group.provisional ? "Live · " + group.label : group.label;
    copy.appendChild(title);
    const route = document.createElement("span");
    route.textContent = group.route ? familyNameFor(group.route) : "Observer";
    if (group.items.length > 1) route.textContent += " · " + group.items.length + " related events";
    copy.appendChild(route);
    summary.appendChild(copy);
    const time = document.createElement("time");
    time.className = "activity-time";
    time.textContent = relativeTime(group.items[0]?.time);
    if (group.items[0]?.time) time.title = group.items[0].time;
    summary.appendChild(time);
    details.appendChild(summary);

    const list = document.createElement("ol");
    list.className = "activity-details";
    for (const item of group.items) {
      const entry = document.createElement("li");
      const semantic = semanticEvent(item.kind, group.provisional);
      const heading = document.createElement("strong");
      heading.textContent = semantic.label;
      entry.appendChild(heading);
      if (item.summary) text(entry, item.summary);
      if (item.producer) text(entry, "Producer: " + item.producer);
      if (item.eventId) text(entry, "Event: " + item.eventId);
      if (item.cursor) text(entry, "Cursor: " + item.cursor);
      list.appendChild(entry);
    }
    details.appendChild(list);
    row.appendChild(details);
    view["activity-list"].appendChild(row);
  }

  function renderActivities() {
    view["activity-list"].replaceChildren();
    for (const group of groupedActivities()) renderActivityGroup(group);
    const count = state.activities.length + state.progress.size;
    view["activity-count"].textContent = count + " update" + (count === 1 ? "" : "s");
    renderCurrentWork();
  }

  function addEvent(item) {
    const key = item.eventId + "\u0000" + item.cursor + "\u0000" + routeKey(item.route);
    if (state.eventKeys.has(key)) return;
    state.eventKeys.add(key);
    state.events.unshift(item);
    while (state.events.length > MAX_RAIL_ITEMS) {
      const removed = state.events.pop();
      if (removed) state.eventKeys.delete(removed.eventId + "\u0000" + removed.cursor + "\u0000" + routeKey(removed.route));
    }
    renderEvents();
  }

  function renderEvents() {
    view["events-list"].replaceChildren();
    for (const item of state.events) {
      const row = document.createElement("li");
      row.className = "event-item";
      const title = document.createElement("strong");
      title.textContent = humanState(item.kind);
      row.appendChild(title);
      if (item.eventId) text(row, "Event " + item.eventId);
      if (item.cursor) text(row, "Route cursor " + item.cursor);
      if (item.route) text(row, item.route.sessionId + " / " + item.route.branchId);
      if (item.producer) text(row, "Producer: " + item.producer);
      if (item.time) text(row, item.time);
      view["events-list"].appendChild(row);
    }
    view["events-count"].textContent = String(state.events.length);
  }

  function sequenceFrom(source) {
    return boundedText(firstValue(asObject(source), ["sequence", "observerSequence"], state.sequence), 64);
  }

  function generationFrom(source) {
    return boundedText(firstValue(asObject(source), ["generation", "observerGeneration"], state.generation), 256);
  }

  function handleStreamMessage(raw, namedType) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setStatus("A stream update was unreadable. Loading a fresh snapshot.", true);
      void resync();
      return;
    }
    let streamEnvelope;
    try {
      streamEnvelope = asObject(parsed);
      const version = firstValue(streamEnvelope, ["version", "protocolVersion", "observerProtocolVersion"], "");
      if (version && version !== PROTOCOL && version !== 1 && version !== "v1") {
        throw new Error("Observer protocol is incompatible.");
      }
      if (streamEnvelope.data && !streamEnvelope.payload) {
        streamEnvelope = asObject(streamEnvelope.data);
      }
    } catch (error) {
      setStatus(safeError(error), true);
      void resync();
      return;
    }
    const payload = asObject(firstValue(streamEnvelope, ["payload"], streamEnvelope));
    const type = boundedText(firstValue(payload, ["type", "kind"], namedType || "message"), 120);
    const incomingGeneration = generationFrom(streamEnvelope);
    if (type === "resync_required") {
      void resync();
      return;
    }
    if (incomingGeneration && state.generation && incomingGeneration !== state.generation) {
      if (type === "projection_replaced" || payload.snapshot || payload.family) {
        closeStream();
        state.generation = incomingGeneration;
        state.activities = [];
        state.activityBytes = 0;
        state.progress.clear();
        state.events = [];
        state.eventKeys.clear();
        renderActivities();
        renderEvents();
        applySnapshot(payload);
      } else {
        void resync();
      }
      return;
    }
    state.sequence = sequenceFrom(streamEnvelope);
    if (payload.snapshot || payload.family || type === "projection_replaced" || type === "family_snapshot") {
      applySnapshot(payload, { openStream: false });
    }
    if (type === "availability") applyHeader(payload);
    const activityPayload = asObject(firstValue(payload, ["activity", "event", "progress"], payload));
    if (type === "progress") {
      const progressRoute = routeFrom(firstValue(payload, ["route"], null));
      const effectId = boundedText(firstValue(payload, ["effectId"], ""), 256);
      if (progressRoute && effectId) {
        state.progress.set(routeKey(progressRoute) + "\u0000" + effectId, {
          route: progressRoute,
          stage: boundedText(firstValue(payload, ["stage"], "working"), 180),
          message: boundedText(firstValue(payload, ["message"], ""), 600),
        });
        renderActivities();
      }
    } else if (type === "progress_cleared") {
      const progressRoute = routeFrom(firstValue(payload, ["route"], null));
      const effectId = boundedText(firstValue(payload, ["effectId"], ""), 256);
      if (progressRoute && effectId) state.progress.delete(routeKey(progressRoute) + "\u0000" + effectId);
      renderActivities();
    } else if (type !== "projection_replaced" && type !== "family_snapshot") {
      addActivity(activityPayload, type);
    }
    if (type === "committed_event" || firstValue(activityPayload, ["eventId", "canonicalEventId"], "")) {
      scheduleSnapshotRefresh();
    }
  }

  function closeStream() {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    if (state.progress.size) {
      state.progress.clear();
      renderActivities();
    }
  }

  function openStream() {
    if (!state.generation || state.stream) return;
    closeStream();
    window.clearTimeout(state.reconnectTimer);
    const query = new URLSearchParams();
    query.set("generation", state.generation);
    query.set("after", state.sequence || "0");
    const stream = new EventSource("/api/family/stream?" + query.toString(), { withCredentials: true });
    state.stream = stream;
    view["stream-state"].textContent = "Connecting";
    stream.onopen = () => {
      state.reconnectAttempts = 0;
      view["stream-state"].textContent = "Live";
    };
    stream.onmessage = (event) => {
      handleStreamMessage(event.data, "message");
    };
    for (const eventName of STREAM_EVENTS) {
      stream.addEventListener(eventName, (event) => {
        handleStreamMessage(event.data, eventName);
      });
    }
    stream.onerror = () => {
      if (state.stream !== stream) return;
      closeStream();
      view["stream-state"].textContent = "Reconnecting";
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectAttempts += 1;
    const delay = Math.min(10_000, 750 * Math.pow(2, Math.min(4, state.reconnectAttempts - 1)));
    state.reconnectTimer = window.setTimeout(() => {
      void resync();
    }, delay);
  }

  function scheduleSnapshotRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      void refreshSnapshot(false);
    }, 180);
  }

  async function refreshSnapshot(openAfter) {
    if (!state.generation) return;
    try {
      const data = await request("/api/family/snapshot");
      applySnapshot(data, { openStream: openAfter !== false });
    } catch (error) {
      setStatus(safeError(error), true);
      if (openAfter !== false) scheduleReconnect();
    }
  }

  async function resync() {
    if (state.resyncing) return;
    state.resyncing = true;
    closeStream();
    state.availability = "resyncing";
    applyHeader({ availability: "resyncing" });
    view["stream-state"].textContent = "Resyncing";
    try {
      const data = await request("/api/family/snapshot");
      applySnapshot(data, { openStream: false });
      state.resyncing = false;
      openStream();
    } catch (error) {
      state.resyncing = false;
      setStatus(safeError(error), true);
      scheduleReconnect();
    }
  }

  async function selectFamily(route) {
    closeStream();
    view["stream-state"].textContent = "Switching";
    setStatus("Switching the process-wide selected family…", false);
    try {
      const data = await request("/api/family/select", {
        method: "POST",
        json: {
          version: PROTOCOL,
          generation: state.generation,
          route: {
            sessionId: route.sessionId,
            branchId: route.branchId,
          },
        },
      });
      state.activities = [];
      state.activityBytes = 0;
      state.progress.clear();
      state.events = [];
      state.eventKeys.clear();
      renderActivities();
      renderEvents();
      applySnapshot(data);
    } catch (error) {
      setStatus(safeError(error), true);
      await resync();
    }
  }

  async function loadBootstrap() {
    const data = await request("/api/bootstrap?rootsLimit=" + MAX_ROOTS);
    state.generation = boundedText(firstValue(data, ["generation", "observerGeneration"], state.generation), 256);
    state.sequence = boundedText(firstValue(data, ["sequence", "observerSequence"], state.sequence), 64);
    applyHeader(data);
    const roots = rootsPageFrom(data);
    renderRoots(roots);

    const family = familyFrom(data);
    const nodes = asArray(firstValue(family, ["nodes", "routes", "items"], []));
    const selected = routeFrom(firstValue(data, ["selectedRoot", "selectedRoute"], null));
    if (nodes.length || selected) {
      applySnapshot(data);
      return;
    }

    const selectable = roots.items.filter((item) => {
      const status = firstValue(asObject(item), ["status", "sessionStatus"], "");
      return asObject(item).selectable !== false && status !== "failed" && status !== "archived" && routeFrom(item);
    });
    view["root-panel"].hidden = selectable.length === 0;
    view["observer-main"].hidden = true;
    if (selectable.length === 1) {
      await selectFamily(routeFrom(selectable[0]));
    } else if (selectable.length > 1) {
      setStatus("Select one root family. The selection is shared by every tab attached to this observer.", false);
    } else if (state.availability === "connected") {
      setStatus("No selectable root family is available.", false);
    }
  }

  function safeError(error) {
    if (error instanceof Error) return boundedText(error.message, 500);
    return "Observer request failed.";
  }

  function bindActions() {
    for (const button of document.querySelectorAll("[data-depth]")) {
      button.addEventListener("click", () => {
        switchDepth(button.getAttribute("data-depth") || "overview");
      });
    }
    view["roots-next"].addEventListener("click", () => {
      if (state.rootNextCursor) void loadRootPage(state.rootNextCursor, false);
    });
    view["roots-previous"].addEventListener("click", () => {
      if (!state.rootCursorHistory.length) return;
      const previous = state.rootCursorHistory.pop() || "";
      void loadRootPage(previous, true);
    });
    view["detail-more"].addEventListener("click", () => {
      if (state.detailSection && state.detailNextCursor) {
        void loadDetail(state.detailSection, state.detailNextCursor, true);
      }
    });
    view["inspector-close"].addEventListener("click", closeInspector);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.inspectorOpen) closeInspector();
    });
    window.addEventListener("resize", () => {
      window.clearTimeout(state.layoutTimer);
      state.layoutTimer = window.setTimeout(renderGraph, 100);
    });
    window.addEventListener("beforeunload", closeStream);
  }

  async function start() {
    bindElements();
    bindActions();
    renderDetailSectionButtons();
    try {
      await establishSession();
      await loadBootstrap();
    } catch (error) {
      applyHeader({ availability: "service_stopped" });
      setStatus(safeError(error) + " Open the current bootstrap URL if this observer process restarted.", true);
    }
  }

  void start();
})();
