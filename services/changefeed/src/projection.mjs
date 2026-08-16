function decodeJson(value) {
  const decoded = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return typeof decoded === "string" ? JSON.parse(decoded) : decoded;
}

export function parseChangefeedRow(row) {
  // CockroachDB emits resolved timestamps as an envelope in `value` for the
  // pg client used by the sinkless changefeed. Treat it as a progress marker,
  // never as a database row to project.
  const rawValue = decodeJson(row.value);
  const resolved = row.resolved ?? rawValue?.resolved;
  if (resolved) {
    return { type: "resolved", resolved: String(resolved) };
  }
  const topicValue = row.topic ?? row.table ?? "unknown";
  const topic = Buffer.isBuffer(topicValue)
    ? topicValue.toString("utf8")
    : topicValue;
  const key = decodeJson(row.key);
  const value = rawValue;
  const payload = value?.payload ?? value ?? {};
  const after = payload.after ?? payload;
  const keyValue = Array.isArray(key) ? key.at(-1) : key?.id ?? key;
  const sourceKey = String(after?.id ?? keyValue ?? "unknown");
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
