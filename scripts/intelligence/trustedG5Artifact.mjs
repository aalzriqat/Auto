// Shared by the protected G5 publisher and the candidate scenario receipt verifier.
export function matchesTrustedG5Artifact(artifact, { artifactId, repositoryId, runId, attempt, controllerSha }) {
  const producer = artifact?.workflow_run;
  return artifact?.id === artifactId &&
    artifact.name === `trusted-g5-evidence-${runId}-${attempt}` &&
    artifact.expired === false && producer?.id === runId &&
    producer.repository_id === repositoryId && producer.head_repository_id === repositoryId &&
    producer.head_branch === "main" && producer.head_sha === controllerSha;
}
