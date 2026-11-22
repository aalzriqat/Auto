/** GitHub Actions can return the check's own UI link as its details URL. */
export function matchesScenarioCheckUrl(record, requested) {
  if ((record.details_url ?? "") === requested) return true;
  if (requested === "") return false;
  const repository = requested.slice(0, requested.indexOf("/actions/runs/"));
  const checkUrl = `${repository}/runs/${record.id}`;
  return record.details_url === checkUrl && record.html_url === checkUrl;
}
