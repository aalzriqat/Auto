// Shared by the protected G5 publisher and the candidate scenario receipt verifier.
export function matchesTrustedG5Artifact(artifact, { artifactId, repositoryId, runId, attempt, controllerSha }) {
  return matchesTrustedRunArtifact(artifact, { artifactId, repositoryId, runId, controllerSha }, `trusted-g5-evidence-${runId}-${attempt}`);
}

export function matchesTrustedRunArtifact(artifact, { artifactId, repositoryId, runId, controllerSha }, name) {
  const producer = artifact?.workflow_run;
  return artifact?.id === artifactId &&
    artifact.name === name &&
    artifact.expired === false && producer?.id === runId &&
    producer.repository_id === repositoryId && producer.head_repository_id === repositoryId &&
    producer.head_branch === "main" && producer.head_sha === controllerSha;
}
