function compareText(left, right) {
  return left.localeCompare(right, "en");
}

function adjacencyFor(modules, edges) {
  const adjacency = new Map(modules.map((modulePath) => [modulePath, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const dependencies of adjacency.values()) dependencies.sort(compareText);
  return adjacency;
}

export function stronglyConnectedComponents(modules, edges) {
  const adjacency = adjacencyFor(modules, edges);
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;

  function startVisit(modulePath) {
    indexes.set(modulePath, nextIndex);
    lowLinks.set(modulePath, nextIndex);
    nextIndex += 1;
    stack.push(modulePath);
    onStack.add(modulePath);
  }

  for (const modulePath of modules) {
    if (indexes.has(modulePath)) continue;

    startVisit(modulePath);
    const visits = [
      {
        modulePath,
        dependencies: adjacency.get(modulePath),
        dependencyIndex: 0,
        parent: undefined,
      },
    ];

    while (visits.length > 0) {
      const visit = visits.at(-1);
      if (visit.dependencyIndex < visit.dependencies.length) {
        const dependency = visit.dependencies[visit.dependencyIndex];
        visit.dependencyIndex += 1;
        if (!indexes.has(dependency)) {
          startVisit(dependency);
          visits.push({
            modulePath: dependency,
            dependencies: adjacency.get(dependency),
            dependencyIndex: 0,
            parent: visit.modulePath,
          });
        } else if (onStack.has(dependency)) {
          lowLinks.set(
            visit.modulePath,
            Math.min(lowLinks.get(visit.modulePath), indexes.get(dependency)),
          );
        }
        continue;
      }

      visits.pop();
      if (visit.parent !== undefined) {
        lowLinks.set(
          visit.parent,
          Math.min(lowLinks.get(visit.parent), lowLinks.get(visit.modulePath)),
        );
      }
      if (lowLinks.get(visit.modulePath) !== indexes.get(visit.modulePath)) {
        continue;
      }

      const component = [];
      let currentModule;
      do {
        currentModule = stack.pop();
        onStack.delete(currentModule);
        component.push(currentModule);
      } while (currentModule !== visit.modulePath);
      components.push(component.sort(compareText));
    }
  }
  return components;
}
