export function parseChangefeedRow(row) {
  const topic = row.topic ?? row.table ?? "unknown";
  const key = typeof row.key === "string" ? JSON.parse(row.key) : row.key;
  const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  if (!value && row.resolved) {
    return { type: "resolved", resolved: row.resolved };
  }
  const payload = value?.payload ?? value ?? {};
  const after = payload.after ?? payload;
  const sourceKey = Array.isArray(key)
    ? String(key[0])
    : String(key?.id ?? after?.id ?? "unknown");
  return {
    type: "row",
    sourceTable: String(topic).split(".").at(-1),
    sourceKey,
    mvccTimestamp:
      payload.updated ??
      after?.decision_hlc ??
      row.updated ??
      new Date().toISOString(),
    eventOp: payload.before == null ? "insert" : "update",
    payload: after,
  };
}

export function projectionKey(event) {
  return `${event.sourceTable}:${event.sourceKey}:${event.mvccTimestamp}`;
}
