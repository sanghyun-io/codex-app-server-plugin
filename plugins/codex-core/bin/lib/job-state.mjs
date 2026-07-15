const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

const TRANSITIONS = new Map([
  ["queued", new Set(["starting", "cancelled", "failed"])],
  ["starting", new Set(["running", "recovering", "cancelled", "failed"])],
  ["running", new Set(["recovering", "completed", "cancelled", "failed"])],
  ["recovering", new Set(["starting", "running", "cancelled", "failed"])],
]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from, to) {
  if (from === to) return !isTerminalStatus(from);
  if (isTerminalStatus(from)) return false;
  return TRANSITIONS.get(from)?.has(to) || false;
}

function applyStatus(state, nextStatus, event) {
  if (state.status !== nextStatus && !canTransition(state.status, nextStatus)) return state;
  return {
    ...state,
    ...event,
    status: nextStatus,
    type: undefined,
  };
}

export function reduceJob(request, supervisorEvents = [], attemptEvents = [], resultExists = false) {
  let state = {
    ...request,
    status: "queued",
    generation: 0,
    error: null,
  };
  let latestDispatch = null;

  for (const event of supervisorEvents) {
    if (event.type === "dispatched") {
      const generation = Number(event.generation) || 0;
      if (generation > (Number(latestDispatch?.generation) || 0)) latestDispatch = event;
    } else if (event.type === "cancel_requested") {
      state = { ...state, cancelRequested: true, cancelRequestedAt: event.at };
    } else if (event.type === "cancelled") {
      state = applyStatus(state, "cancelled", event);
    } else if (event.type === "failed") {
      state = applyStatus(state, "failed", event);
    }
  }

  const generations = attemptEvents
    .map(event => Number(event.generation) || 0)
    .filter(generation => generation > 0);
  const attemptGeneration = generations.length ? Math.max(...generations) : 0;
  const dispatchGeneration = Number(latestDispatch?.generation) || 0;
  const currentGeneration = Math.max(attemptGeneration, dispatchGeneration);
  state.generation = currentGeneration;

  if (!isTerminalStatus(state.status)) {
    if (latestDispatch && dispatchGeneration === currentGeneration) {
      state = applyStatus(state, "starting", latestDispatch);
    }
    for (const event of attemptEvents) {
      if ((Number(event.generation) || 0) !== currentGeneration) continue;
      if (["starting", "running", "recovering", "completed", "cancelled", "failed"].includes(event.type)) {
        state = applyStatus(state, event.type, event);
      } else if (event.type === "recoverable_failure") {
        state = applyStatus(state, "recovering", event);
      } else {
        state = { ...state, ...event, type: undefined };
      }
    }
  }

  if (resultExists && state.status !== "cancelled" && state.status !== "failed") {
    state = { ...state, status: "completed", resultRecovered: state.status !== "completed" };
  }

  delete state.type;
  return state;
}
