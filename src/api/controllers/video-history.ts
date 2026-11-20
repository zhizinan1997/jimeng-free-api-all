export function videoHistoryRecord(result: any, historyId: string | number) {
  const keyed = result?.[String(historyId)];
  if (keyed) return keyed;
  return result?.history_list?.[0] || result?.history_records?.[0];
}
