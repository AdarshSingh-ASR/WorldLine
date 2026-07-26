function decodeJson(value) {
  const decoded = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return typeof decoded === "string" ? JSON.parse(decoded) : decoded;
}

export function parseChangefeedRow(row) {
  const topicValue = row.topic ?? row.table ?? "unknown";
  const topic = Buffer.isBuffer(topicValue)
    ? topicValue.toString("utf8")
    : topicValue;
  const key = decodeJson(row.key);
  const value = decodeJson(row.value);
  if (!value && row.resolved) {
    return { type: "resolved", resolved: row.resolved };
  }
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
